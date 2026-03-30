import { z } from "zod";
import { mkdir } from "fs/promises";
import { readFileSync } from "fs";
import { join } from "path";
import { getGoogleClient } from "../google-client";
import { generateVideoGrok as grokGenerateVideo } from "../grok-client";
import { generateVideoLtx as ltxGenerateVideo, type LtxProgressInfo } from "../ltx-client";
import { rateLimiters } from "../queue/rate-limiter-registry.js";
import type { VideoBackend } from "../types";

// Custom error for RAI celebrity filter rejections — allows orchestrator to
// catch this specific failure and regenerate frames before retrying.
export class RaiCelebrityError extends Error {
  constructor(_shotNumber: number, message: string) {
    super(message);
    this.name = "RaiCelebrityError";
  }
}



/**
 * Infer gender from a physical description string.
 * Returns "man", "woman", or "person" when ambiguous.
 */
function inferGender(description: string): "man" | "woman" | "person" {
  const d = description.toLowerCase();
  const femaleSignals = /\b(woman|female|girl|she|her|lady|feminine|petite)\b/;
  const maleSignals = /\b(man|male|boy|he|his|guy|gentleman|masculine)\b/;
  if (femaleSignals.test(d)) return "woman";
  if (maleSignals.test(d)) return "man";
  return "person";
}

/**
 * Extract a short (3–6 word) visual descriptor from a character's physical description.
 * Picks the most visually distinctive trait — clothing first, then hair, then age/build.
 */
function extractVisualDescriptor(
  description: string,
  gender: "man" | "woman" | "person",
): string {
  const d = description.toLowerCase();

  // Try clothing: "wearing a/an …" or "dressed in …"
  const clothingMatch = d.match(/(?:wearing\s+(?:a\s+)?|dressed\s+in\s+(?:a\s+)?)([\w\s-]+?)(?:\.|,|;|$)/);
  if (clothingMatch) {
    const clothing = clothingMatch[1].trim().replace(/\s+/g, " ");
    // Keep it short — at most 4 words from the clothing phrase
    const words = clothing.split(" ").slice(0, 4).join(" ");
    return `the ${gender} in the ${words}`;
  }

  // Try hair color
  const hairMatch = d.match(/\b(blonde?|brunette|red|auburn|black|dark(?:\s+brown)?|brown|grey|gray|white|silver|ginger|strawberry\s+blonde?|sandy|golden|platinum)\b[^.]*?\bhair\b/);
  if (hairMatch) {
    const hairColor = hairMatch[1].trim();
    return `the ${gender} with ${hairColor} hair`;
  }

  // Try age cue
  const ageMatch = d.match(/\b(young|elderly|older|teenage|middle-aged|old)\b/);
  if (ageMatch) {
    return `the ${ageMatch[1]} ${gender}`;
  }

  // Fallback
  return `the ${gender}`;
}

/**
 * Build a map of character name → short visual descriptor.
 * Ensures descriptors are unique across all characters in the shot.
 * Falls back to appending distinguishing traits when two characters would
 * otherwise receive the same label.
 */
export function buildCharacterDescriptors(
  names: string[],
  descriptions: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  const validNames = names.filter((n) => !!n);

  if (validNames.length === 0) return result;

  // First pass: generate descriptors
  for (const name of validNames) {
    const desc = descriptions[name] ?? "";
    const gender = inferGender(desc || name);
    if (desc) {
      result[name] = extractVisualDescriptor(desc, gender);
    } else {
      result[name] = `the ${gender}`;
    }
  }

  // Second pass: resolve collisions by appending hair or build info
  const labelCounts = new Map<string, string[]>();
  for (const [name, label] of Object.entries(result)) {
    const existing = labelCounts.get(label) || [];
    existing.push(name);
    labelCounts.set(label, existing);
  }

  for (const [label, namesWithLabel] of labelCounts) {
    if (namesWithLabel.length <= 1) continue;
    // Try to disambiguate with a secondary feature
    for (let i = 0; i < namesWithLabel.length; i++) {
      const name = namesWithLabel[i];
      const desc = (descriptions[name] ?? "").toLowerCase();
      const gender = inferGender(desc || name);
      // Already used clothing? Try hair. Already used hair? Try clothing.
      if (label.includes("in the")) {
        // Clothing was used, try hair
        const hairMatch = desc.match(/\b(blonde?|brunette|red|auburn|black|dark(?:\s+brown)?|brown|grey|gray|white|silver|ginger)\b[^.]*?\bhair\b/);
        if (hairMatch) {
          result[name] = `the ${gender} with ${hairMatch[1]} hair`;
          continue;
        }
      } else if (label.includes("with") && label.includes("hair")) {
        // Hair was used, try clothing
        const clothingMatch = desc.match(/(?:wearing\s+(?:a\s+)?|dressed\s+in\s+(?:a\s+)?)([\w\s-]+?)(?:\.|,|;|$)/);
        if (clothingMatch) {
          const words = clothingMatch[1].trim().split(" ").slice(0, 4).join(" ");
          result[name] = `the ${gender} in the ${words}`;
          continue;
        }
      }
      // Last resort: add positional hint
      if (i > 0) {
        result[name] = `the other ${gender}`;
      }
    }
  }

  return result;
}



/** Shared parameter type for all video backends. */
type GenerateVideoParams = {
  shotNumber: number;
  sceneNumber: number;
  shotInScene: number;
  shotType: "first_last_frame";
  actionPrompt: string;
  dialogue: string;
  /** Who is speaking: character name, "narrator", "voiceover", or empty. */
  speaker?: string;
  /** Characters present in the shot, used to describe the speaker visually. */
  charactersPresent?: string[];
  soundEffects: string;
  cameraDirection: string;
  durationSeconds: number;
  startFramePath: string;
  outputDir: string;
  dryRun?: boolean;
  abortSignal?: AbortSignal;
  /** Character names to strip from prompts before sending to Veo. */
  characterNames?: string[];
  /** Map of character name → physicalDescription for building visual descriptors. */
  characterDescriptions?: Record<string, string>;
  /** Video backend override. Defaults to process.env.VIDEO_BACKEND or "veo". */
  videoBackend?: VideoBackend;
  /** Aspect ratio for the generated video (e.g. "16:9", "9:16"). */
  aspectRatio?: string;
  /** Progress callback for UI updates */
  onProgress?: (message: string) => void;
  /** Version number for output filename (default 1). */
  version?: number;
  /** Queue priority — forwarded to backends that support it (e.g. LTX). */
  priority?: "normal" | "high";
  /** Progress callback for LTX backend — reports queue position and generation progress. */
  onLtxProgress?: (info: LtxProgressInfo) => void;
};

/** Shared return type for all video backends. */
type GenerateVideoResult = { shotNumber: number; path: string; duration: number; finalPrompt: string };

function buildSceneShotFilename(sceneNumber: number, shotInScene: number, version: number = 1): string {
  return `scene_${String(sceneNumber).padStart(2, "0")}_shot_${String(shotInScene).padStart(2, "0")}_v${version}`;
}

function formatShotContext(params: Pick<GenerateVideoParams, "shotNumber" | "sceneNumber" | "shotInScene">): string {
  return `scene ${params.sceneNumber} shot ${params.shotInScene} (shot ${params.shotNumber})`;
}

/**
 * Build a dialogue description for the video prompt.
 * Uses the speaker field to attribute dialogue to the correct character.
 * Character names are replaced with short visual descriptors derived from
 * their physicalDescription so the video model can identify who is speaking.
 */
function buildDialoguePrompt(
  dialogue: string,
  speaker?: string,
  charactersPresent?: string[],
  characterDescriptions?: Record<string, string>,
): string {
  if (!dialogue) return "";
  const normalizedSpeaker = (speaker ?? "").trim().toLowerCase();
  if (normalizedSpeaker === "narrator" || normalizedSpeaker === "voiceover") {
    return `${normalizedSpeaker === "voiceover" ? "Voiceover" : "Narrator"} says: "${dialogue}"`;
  }

  const descriptions = characterDescriptions ?? {};
  const descriptors = buildCharacterDescriptors(charactersPresent ?? [], descriptions);

  const labelFor = (name: string): string => descriptors[name] ?? "the person";

  let speakerLabel = "the person";
  let listenerLabel = "another person";

  if (charactersPresent && charactersPresent.length > 0) {
    const speakerMatch = charactersPresent.find(c => c.trim().toLowerCase() === normalizedSpeaker);
    speakerLabel = speakerMatch
      ? labelFor(speakerMatch)
      : charactersPresent.length > 1
        ? "one of the people"
        : "the person";

    if (charactersPresent.length > 1) {
      const listenerName = speakerMatch
        ? charactersPresent.find(c => c !== speakerMatch) ?? charactersPresent[0]
        : charactersPresent[0];
      listenerLabel = labelFor(listenerName);
    }
  }

  const subject = `${speakerLabel[0].toUpperCase()}${speakerLabel.slice(1)}`;
  if (charactersPresent && charactersPresent.length > 1) {
    return `${subject} looks at ${listenerLabel} and says: "${dialogue}"`;
  }

  return `${subject} says: "${dialogue}"`;
}

export function buildVideoPrompt(params: Pick<GenerateVideoParams, "actionPrompt" | "dialogue" | "speaker" | "charactersPresent" | "characterDescriptions" | "soundEffects" | "cameraDirection">): string {
  const promptParts: string[] = [];
  if (params.actionPrompt) promptParts.push(params.actionPrompt);
  const dialoguePart = buildDialoguePrompt(params.dialogue, params.speaker, params.charactersPresent, params.characterDescriptions);
  if (dialoguePart) promptParts.push(dialoguePart);
  if (params.soundEffects) promptParts.push(`Sound effects: ${params.soundEffects}`);
  if (params.cameraDirection) promptParts.push(`Camera: ${params.cameraDirection}`);
  // Append gaze instruction to every video prompt to prevent characters looking at camera
  promptParts.push("CRITICAL: Characters must NEVER look directly at the camera. This is a cinematic film, NOT a YouTube video or interview. When characters speak, they look at the person they are speaking to, not at the viewer. When characters reflect or share experiences, they look at their conversation partner, down at their hands, or into the distance — NEVER at the camera. No character should ever appear aware of the camera's existence.");
  // Suppress music/soundtrack — per-shot music clashes when assembled; audio added in post-production.
  // Sound effects and ambient audio are intentionally kept.
  promptParts.push("No music. No soundtrack. No background music.");
  return promptParts.join(". ");
}


/**
 * Generates video clips for shots.
 * Dispatches to Veo 3.1 or Grok backend based on VIDEO_BACKEND env var.
 */
export async function generateVideo(params: GenerateVideoParams): Promise<GenerateVideoResult> {
  const backend = (params.videoBackend || process.env.VIDEO_BACKEND || "veo").toLowerCase();
  console.log(`[generateVideo] Using backend: ${backend}`);

  // actionPrompt goes directly to the video backend — the shot planner is now
  // responsible for using visual descriptors instead of character names.
  const sanitized = params;

  if (backend === "veo") {
    return generateVideoVeo(sanitized);
  } else if (backend === "grok") {
    return generateVideoGrok(sanitized);
  } else if (backend === "ltx-full") {
    return generateVideoLtxBackend(sanitized, "full");
  } else if (backend === "ltx-distilled") {
    return generateVideoLtxBackend(sanitized, "distilled");
  } else {
    throw new Error(`[generateVideo] Unknown VIDEO_BACKEND: "${backend}". Use "veo", "grok", "ltx-full", or "ltx-distilled".`);
  }
}

/**
 * Veo 3.1 backend: generates video via Google GenAI SDK.
 */
async function generateVideoVeo(params: GenerateVideoParams): Promise<GenerateVideoResult> {
  const {
    shotNumber,
    sceneNumber,
    shotInScene,
    shotType,
    durationSeconds,
    startFramePath,
    outputDir,
    dryRun = false,
    abortSignal,
    version = 1,
  } = params;

  // Ensure output directory exists
  await mkdir(outputDir, { recursive: true });

  const shotContext = formatShotContext({ shotNumber, sceneNumber, shotInScene });
  const outputPath = join(outputDir, `${buildSceneShotFilename(sceneNumber, shotInScene, version)}.mp4`);

	const finalPrompt = buildVideoPrompt(params);

  // Dry-run mode: return placeholder
  if (dryRun) {
    console.log(`[generateVideo] DRY-RUN: ${shotContext} (${shotType}, ${durationSeconds}s)`);
		  console.log(`[generateVideo] Prompt sent to API: ${finalPrompt}`);
		  return { shotNumber, path: outputPath, duration: durationSeconds, finalPrompt };
  }

  console.log(`[generateVideo] Generating ${shotContext} (${shotType}, ${durationSeconds}s)`);
		console.log(`[generateVideo] Prompt sent to API: ${finalPrompt}`);

  try {
    const client = getGoogleClient();
    const maxRetries = 5;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (!startFramePath) {
          throw new Error("startFramePath required");
        }

        // Load start image as base64 (start frame)
        const startImageBuffer = readFileSync(startFramePath);
        const startImage = {
          imageBytes: startImageBuffer.toString("base64"),
          mimeType: "image/png",
        };

        // Build config
        // Veo 3.1 image-to-video supports 4, 6, or 8 second durations.
        // Clamp the requested duration to the nearest valid value.
        const validDurations = [4, 6, 8];
        const clampedDuration = validDurations.reduce((prev, curr) =>
          Math.abs(curr - durationSeconds) < Math.abs(prev - durationSeconds) ? curr : prev
        );
        const aspectRatio = params.aspectRatio || "16:9";
        const config: Record<string, unknown> = {
          durationSeconds: clampedDuration,
          aspectRatio,
          personGeneration: "allow_adult",
        };

        console.log(`[generateVideo] Veo config: durationSeconds=${clampedDuration} (requested ${durationSeconds}), aspectRatio=${aspectRatio}`);

        const limiter = rateLimiters.get('veo');
        await limiter.acquire();
        let veoReleased = false;
        try {

        console.log(`[generateVideo] ${shotContext}: Calling Veo API (attempt ${attempt}/${maxRetries})...`);

        // Wrap the generateVideos call with a 60-second timeout to avoid hanging forever
        const veoTimeoutMs = 60000;
        let operation: Awaited<ReturnType<typeof client.models.generateVideos>>;
        const veoCallPromise = client.models.generateVideos({
          model: "veo-3.1-generate-preview",
	          prompt: finalPrompt,
          image: startImage,
          config: {
            ...config,
          } as any,
        });
        const veoTimeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Veo API call timed out after ${veoTimeoutMs / 1000}s for ${shotContext}`)), veoTimeoutMs)
        );
        operation = await Promise.race([veoCallPromise, veoTimeoutPromise]);

        console.log(`[generateVideo] ${shotContext}: Veo API returned operation: ${operation.name}, done=${operation.done}`);

        // Poll for operation completion
        console.log(`[generateVideo] Polling for completion (operation: ${operation.name})`);

        let pollCount = 0;
        while (!operation.done) {
          // Check abort signal before polling
          if (abortSignal?.aborted) {
            throw new Error("Video generation cancelled due to pipeline interruption");
          }
          await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds between polls
          pollCount++;
          console.log(`[generateVideo] ${shotContext}: Polling... (${pollCount * 10}s elapsed)`);
          operation = await client.operations.getVideosOperation({ operation });
        }

        // Extract generated video from response
        const response = operation.response;
        const generatedVideo = response?.generatedVideos?.[0];
        if (!generatedVideo?.video) {
          // Log full response for debugging (may include RAI filter info)
          const filterCount = response?.raiMediaFilteredCount;
          const filterReasons = response?.raiMediaFilteredReasons;
          const errorInfo = operation.error;
          console.error(`[generateVideo] ${shotContext}: No video returned.`);
          if (filterCount) console.error(`[generateVideo]   RAI filtered count: ${filterCount}`);
          if (filterReasons?.length) console.error(`[generateVideo]   RAI filter reasons: ${filterReasons.join(', ')}`);
          if (errorInfo) console.error(`[generateVideo]   Operation error: ${JSON.stringify(errorInfo)}`);
          if (!filterCount && !filterReasons?.length && !errorInfo) {
            console.error(`[generateVideo]   Full response: ${JSON.stringify(response)}`);
          }
          // Throw a specific error when the RAI filter mentions "celebrity" so
          // the orchestrator can regenerate frames and retry.
          if (filterReasons?.some((r: string) => r.toLowerCase().includes('celebrity'))) {
            throw new RaiCelebrityError(shotNumber, `RAI celebrity filter for ${shotContext}: ${filterReasons.join(', ')}`);
          }
          throw new Error(`No video in response for ${shotContext}${filterReasons?.length ? ` (RAI: ${filterReasons.join(', ')})` : ''}`);
        }

        // Download the video to disk
        console.log(`[generateVideo] Downloading video for ${shotContext}`);
        await client.files.download({
          file: generatedVideo.video,
          downloadPath: outputPath,
        });

        console.log(`[generateVideo] ${shotContext} saved to ${outputPath}`);
		        return { shotNumber, path: outputPath, duration: clampedDuration, finalPrompt };

        } finally {
          if (!veoReleased) {
            veoReleased = true;
            limiter.release();
          }
        }
      } catch (error: any) {
        lastError = error;
        console.error(`[generateVideo] ${shotContext}: Veo API error (attempt ${attempt}/${maxRetries}):`, error);
        // Don't retry if cancelled due to pipeline interruption
        if (error?.message?.includes('cancelled due to pipeline interruption')) {
          throw error;
        }
        // Check if it's a 429 rate limit error
        if (error?.status === 429 || error?.message?.includes('429') || error?.message?.includes('RESOURCE_EXHAUSTED')) {
          console.warn(`[generateVideo] ${shotContext}: Rate limited (429) — backing off all veo workers for 60s`);
          rateLimiters.get('veo').backoff(60000);
          continue;
        }
        // Non-retryable error: don't retry
        throw error;
      }
    }

    // All retries exhausted
    console.error(`[generateVideo] ${shotContext}: All ${maxRetries} retries exhausted`);
    throw lastError;
  } catch (error) {
    console.error(`[generateVideo] Error generating ${shotContext}:`, error);
    throw error;
  }
}

/**
 * Vercel AI SDK tool definition for generateVideo.
 * Claude calls this to generate video clips for shots.
 */
export const generateVideoTool = {
  description:
    "Generate video clips for shots using first+last frame interpolation. Backend is selected by VIDEO_BACKEND env var.",
  parameters: z.object({
    shotNumber: z.number().describe("Global shot number"),
    sceneNumber: z.number().describe("Scene number for the shot"),
    shotInScene: z.number().describe("Shot number within the scene"),
    shotType: z.literal("first_last_frame").describe("Video generation mode"),
    actionPrompt: z.string().describe("Action description for the shot"),
    dialogue: z.string().describe("Character dialogue (empty if none)"),
    soundEffects: z.string().describe("Sound effects description"),
    cameraDirection: z.string().describe("Camera movement and angle"),
    durationSeconds: z.number().describe("Video duration in seconds (0.5-15). Veo supports 4, 6, or 8 seconds; Grok supports 1-15."),
    startFramePath: z.string().describe("Path to start frame image"),
    outputDir: z.string().describe("Output directory for video file"),
    dryRun: z.boolean().optional().describe("Return placeholder without calling API"),
  }),
};


/**
 * Grok backend: generates video via xAI Grok API.
 * Uses only the start frame (ignores endFramePath). Supports 1-15s duration.
 */
async function generateVideoGrok(params: GenerateVideoParams): Promise<GenerateVideoResult> {
  const {
    shotNumber,
    sceneNumber,
    shotInScene,
    shotType,
    durationSeconds,
    startFramePath,
    outputDir,
    dryRun = false,
    abortSignal,
    version = 1,
  } = params;

  // Ensure output directory exists
  await mkdir(outputDir, { recursive: true });

  const shotContext = formatShotContext({ shotNumber, sceneNumber, shotInScene });
  const outputPath = join(outputDir, `${buildSceneShotFilename(sceneNumber, shotInScene, version)}.mp4`);

	const finalPrompt = buildVideoPrompt(params);

  // Dry-run mode: return placeholder
  if (dryRun) {
    console.log(`[generateVideo] DRY-RUN: ${shotContext} (${shotType}, ${durationSeconds}s)`);
		  console.log(`[generateVideo] Prompt sent to API: ${finalPrompt}`);
		  return { shotNumber, path: outputPath, duration: durationSeconds, finalPrompt };
  }

  if (!startFramePath) {
    throw new Error("Grok backend requires startFramePath");
  }

  console.log(`[generateVideo] Generating ${shotContext} via Grok (${shotType}, ${durationSeconds}s)`);
		console.log(`[generateVideo] Prompt sent to API: ${finalPrompt}`);

  // Convert start frame to base64 data URI
  const imageBuffer = readFileSync(startFramePath);
  const ext = startFramePath.toLowerCase().endsWith(".png") ? "png" : "jpeg";
  const dataUri = `data:image/${ext};base64,${imageBuffer.toString("base64")}`;

  // Clamp duration to Grok's supported range (1-15s)
  const clampedDuration = Math.max(1, Math.min(15, durationSeconds));

  try {
    // grok-client already handles retries with exponential backoff
    const result = await grokGenerateVideo(finalPrompt, {
      image: dataUri,
      duration: clampedDuration,
      aspectRatio: params.aspectRatio || "16:9",
      resolution: "720p",
      outputPath,
      abortSignal,
    });

    if (result.duration !== clampedDuration) {
      console.warn(`[generateVideo] WARNING: Requested ${clampedDuration}s but Grok returned ${result.duration}s`);
    }

    console.log(`[generateVideo] ${shotContext} saved to ${result.path}`);
		    return { shotNumber, path: result.path, duration: clampedDuration, finalPrompt };
  } catch (error) {
    console.error(`[generateVideo] Error generating ${shotContext} via Grok:`, error);
    throw error;
  }
}


/**
 * LTX Video 2.3 backend: generates video via self-hosted LTX API.
 * Uses image-to-video when a start frame is available; supports arbitrary durations.
 * Defaults to distilled mode for faster generation.
 */
async function generateVideoLtxBackend(params: GenerateVideoParams, mode: "full" | "distilled"): Promise<GenerateVideoResult> {
  const {
    shotNumber,
    sceneNumber,
    shotInScene,
    durationSeconds,
    startFramePath,
    outputDir,
    dryRun = false,
    abortSignal,
    version = 1,
  } = params;

  await mkdir(outputDir, { recursive: true });

  const shotContext = formatShotContext({ shotNumber, sceneNumber, shotInScene });
  const outputPath = join(outputDir, `${buildSceneShotFilename(sceneNumber, shotInScene, version)}.mp4`);

  const finalPrompt = buildVideoPrompt(params);

  if (dryRun) {
    console.log(`[generateVideo] DRY-RUN: ${shotContext} via LTX (${durationSeconds}s)`);
    console.log(`[generateVideo] Prompt sent to API: ${finalPrompt}`);
    return { shotNumber, path: outputPath, duration: durationSeconds, finalPrompt };
  }

  console.log(`[generateVideo] Generating ${shotContext} via LTX (${durationSeconds}s)`);
  console.log(`[generateVideo] Prompt sent to API: ${finalPrompt}`);

  // Resolve aspect ratio to LTX pixel dimensions
  const aspectRatio = params.aspectRatio || "16:9";
  let width: number;
  let height: number;
  if (aspectRatio === "16:9") {
    width = 1408; height = 768;
  } else if (aspectRatio === "9:16") {
    width = 768; height = 1408;
  } else {
    width = 1024; height = 1024;
  }

  try {
    const result = await ltxGenerateVideo(finalPrompt, {
      image: startFramePath || undefined,
      duration: durationSeconds,
      width,
      height,
      mode,
      priority: params.priority,
      outputPath,
      abortSignal,
      onProgress: params.onLtxProgress,
    });

    console.log(`[generateVideo] ${shotContext} saved to ${result.path} (LTX adjusted duration: ${result.duration}s)`);
    return { shotNumber, path: result.path, duration: result.duration, finalPrompt };
  } catch (error) {
    console.error(`[generateVideo] Error generating ${shotContext} via LTX:`, error);
    throw error;
  }
}