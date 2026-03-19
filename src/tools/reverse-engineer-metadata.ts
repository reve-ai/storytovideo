import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { readFileSync } from "fs";
import { extname } from "path";
import type { StoryAnalysis } from "../types";

/** Minimal shot description coming from the analyze-shots tool. */
export interface ShotDescription {
  index: number;
  timestamp: string;
  description: string;
  composition: string;
  cameraDirection: string;
  dialogue: string;
  soundEffects: string;
  durationSeconds: number;
}

// ── Zod schema matching StoryAnalysis exactly ──────────────────────────

const shotSchema = z.object({
  shotNumber: z.number(),
  sceneNumber: z.number(),
  shotInScene: z.number(),
  durationSeconds: z.number(),
  shotType: z.literal("first_last_frame"),
  composition: z.string(),
  startFramePrompt: z.string(),
  endFramePrompt: z.string(),
  actionPrompt: z.string(),
  dialogue: z.string(),
  soundEffects: z.string(),
  cameraDirection: z.string(),
  charactersPresent: z.array(z.string()),
  location: z.string(),
  continuousFromPrevious: z.boolean(),
});

const sceneSchema = z.object({
  sceneNumber: z.number(),
  title: z.string(),
  narrativeSummary: z.string(),
  charactersPresent: z.array(z.string()),
  location: z.string(),
  estimatedDurationSeconds: z.number(),
  shots: z.array(shotSchema),
  transition: z.enum(["cut", "fade_black"]),
});

const storyAnalysisSchema = z.object({
  title: z.string(),
  artStyle: z.string(),
  characters: z.array(z.object({
    name: z.string(),
    physicalDescription: z.string(),
    personality: z.string(),
    ageRange: z.string(),
  })),
  locations: z.array(z.object({
    name: z.string(),
    visualDescription: z.string(),
  })),
  scenes: z.array(sceneSchema),
});

// ── Main function ──────────────────────────────────────────────────────

/**
 * Reverse-engineers a full StoryAnalysis from a sequence of shot descriptions
 * (produced by the analyze-shots tool) and optional frame images.
 *
 * Uses Claude to identify recurring characters, distinct locations, group shots
 * into scenes, and reconstruct narrative metadata — producing output structurally
 * identical to the forward pipeline's StoryAnalysis.
 */
export async function reverseEngineerMetadata(params: {
  shotDescriptions: ShotDescription[];
  frameImagePaths?: string[];
}): Promise<StoryAnalysis> {
  const { shotDescriptions, frameImagePaths } = params;

  const shotsText = shotDescriptions
    .map((s) =>
      `Shot ${s.index} [${s.timestamp}] (${s.durationSeconds}s):\n` +
      `  Description: ${s.description}\n` +
      `  Composition: ${s.composition}\n` +
      `  Camera: ${s.cameraDirection}\n` +
      `  Dialogue: ${s.dialogue || "(none)"}\n` +
      `  Sound effects: ${s.soundEffects || "(none)"}`
    )
    .join("\n\n");

  const prompt = buildPrompt(shotsText, shotDescriptions.length);

  // Build message content: text + optional images
  const contentParts: Array<{ type: string; text?: string; image?: string }> = [
    { type: "text", text: prompt },
  ];

  if (frameImagePaths && frameImagePaths.length > 0) {
    for (const imgPath of frameImagePaths) {
      try {
        const base64 = readFileSync(imgPath).toString("base64");
        const ext = extname(imgPath).toLowerCase();
        const mime = ext === ".png" ? "image/png" : "image/jpeg";
        contentParts.push({
          type: "image",
          image: `data:${mime};base64,${base64}`,
        } as any);
      } catch {
        // Skip unreadable images
      }
    }
  }

  try {
    const imageCount = contentParts.length - 1;
    console.log(`[reverse-engineer] Calling Claude with ${shotDescriptions.length} shots and ${imageCount} images...`);
    const startTime = Date.now();

    const { object } = await generateObject({
      model: anthropic("claude-opus-4-6"),
      schema: storyAnalysisSchema,
      messages: [{ role: "user" as const, content: contentParts as any }],
    } as any);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const result = object as any as StoryAnalysis;
    console.log(`[reverse-engineer] Done in ${elapsed}s — ${result.characters?.length ?? 0} characters, ${result.locations?.length ?? 0} locations, ${result.scenes?.length ?? 0} scenes`);

    return result;
  } catch (error) {
    console.error("Error in reverseEngineerMetadata:", error);
    throw error;
  }
}

// ── Prompt builder ─────────────────────────────────────────────────────

function buildPrompt(shotsText: string, shotCount: number): string {
  return `You are analyzing a sequence of ${shotCount} shots extracted from a video.
Your job is to reverse-engineer the full story metadata from these shot descriptions.

SHOT DESCRIPTIONS:
${shotsText}

INSTRUCTIONS:
1. **Characters**: Identify all recurring people/characters across the shots by their visual descriptions.
   - Give each character a creative FICTIONAL name (NEVER use real people's names).
   - If someone appears to be a real person or celebrity, invent an original fictional name that reflects their personality or role.
   - Provide detailed physicalDescription (face, body, clothing, distinguishing features).
   - Infer personality from their actions and dialogue.
   - Estimate ageRange.

2. **Locations**: Identify all distinct locations where shots take place.
   - Give each location a descriptive name.
   - Provide visualDescription covering architecture, lighting, colors, atmosphere.

3. **Scenes**: Group the shots into logical scenes based on:
   - Location changes (new location = likely new scene)
   - Narrative flow and timing gaps
   - Thematic shifts
   For each scene provide: title, narrativeSummary, charactersPresent (using your fictional names), location (matching a location name), estimatedDurationSeconds (sum of shot durations), and transition type ("cut" for scene 1, "cut" or "fade_black" for others).

4. **Shots within scenes**: For each shot, fill in ALL fields:
   - shotNumber: global 1-based index across the entire video
   - sceneNumber: which scene it belongs to (1-based)
   - shotInScene: 1-based index within its scene
   - durationSeconds: from the shot description
   - shotType: always "first_last_frame"
   - composition: infer from the description (e.g. "wide_establishing", "close_up", "medium_shot", "tracking", "over_the_shoulder", "two_shot", "pov", "insert_cutaway", "low_angle", "high_angle")
   - startFramePrompt: a detailed visual prompt describing the first frame
   - endFramePrompt: a detailed visual prompt describing the last frame
   - actionPrompt: describe the action/movement in the shot
   - dialogue: quoted speech if any, empty string if none
   - soundEffects: described sound effects, empty string if none
   - cameraDirection: camera movement description
   - charactersPresent: array of fictional character names present
   - location: matching a location name from your locations list
   - continuousFromPrevious: true if this shot flows directly from the previous one without a cut

5. **Title**: Infer a compelling title for the overall story/video.

6. **Art style**: Describe the visual art style of the video. Default to "photorealistic" if unclear.

IMPORTANT: The output must be a complete, valid StoryAnalysis. Every shot must appear in exactly one scene. Shot numbering must be globally sequential and locally sequential within each scene.`;
}

// ── Tool definition ────────────────────────────────────────────────────

/**
 * Vercel AI SDK tool definition for reverseEngineerMetadata.
 */
export const reverseEngineerMetadataTool = {
  description:
    "Reverse-engineer characters, locations, scenes, and full story metadata from analyzed shot descriptions",
  parameters: z.object({
    shotDescriptions: z.array(z.object({
      index: z.number().describe("0-based shot index"),
      timestamp: z.string().describe("Timestamp in the source video"),
      description: z.string().describe("Visual description of the shot"),
      composition: z.string().describe("Shot composition type"),
      cameraDirection: z.string().describe("Camera movement description"),
      dialogue: z.string().describe("Any dialogue in the shot"),
      soundEffects: z.string().describe("Sound effects description"),
      durationSeconds: z.number().describe("Shot duration in seconds"),
    })).describe("Array of shot descriptions from the analyze-shots tool"),
    frameImagePaths: z.array(z.string()).optional().describe(
      "Optional sample of frame image paths for visual reference"
    ),
  }),
};

