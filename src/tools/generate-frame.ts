import { z } from "zod";
import sharp from "sharp";
import { createImage, remixImage } from "../reve-client";
import { createImageGrok, remixImageGrok } from "../grok-image-client";
import { createImageNanoBanana, remixImageNanoBanana } from "../nano-banana-image-client";
import type { Shot, AssetLibrary, FrameReference, ImageBackend, VideoBackend } from "../types";
import * as fs from "fs";
import * as path from "path";
import {
  FRAME_PROMPT_STYLE_PREFIX,
  FRAME_PROMPT_STYLE_PREFIX_NO_CHARACTERS,
  FRAME_GAZE_WIDE,
  FRAME_GAZE_MULTI_DIALOGUE,
  FRAME_GAZE_MULTI_NO_DIALOGUE,
  FRAME_GAZE_SOLO_DIALOGUE,
  FRAME_GAZE_SOLO_NO_DIALOGUE,
} from "../prompts.js";

type LegacyImageBackend = VideoBackend | "comfy";

function resolveImageBackend(imageBackend?: ImageBackend, videoBackend?: LegacyImageBackend): ImageBackend {
  if (imageBackend) {
    return imageBackend;
  }

  return videoBackend === "grok" ? "grok" : "reve";
}

type GeneratedSingleFrameResult = {
  path: string;
  referencesUsed: FrameReference[];
  finalPrompt: string;
};

export type PlannedFrameReferences = {
  referenceImagePaths: string[];
  referencesUsed: FrameReference[];
  mergedReferences: FrameReference[];
  droppedReferences: FrameReference[];
};

function formatShotContext(shot: Pick<Shot, "shotNumber" | "sceneNumber" | "shotInScene">): string {
  return `scene ${shot.sceneNumber} shot ${shot.shotInScene} (shot ${shot.shotNumber})`;
}

function toPossessive(name: string): string {
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

function summarizeReference(reference: Pick<FrameReference, "type" | "name">): string {
  switch (reference.type) {
    case "character":
      return `character:${reference.name}`;
    case "continuity":
      return "continuity:previous-shot";
    case "location":
      return `location:${reference.name}`;
    case "object":
      return `object:${reference.name}`;
    case "collage":
      return `collage:${reference.name}`;
  }
}

function describeReferenceForCollage(reference: Pick<FrameReference, "type" | "name">): string {
  switch (reference.type) {
    case "character":
      return `${toPossessive(reference.name)} appearance`;
    case "continuity":
      return "the previous shot";
    case "location":
      return `${reference.name} location`;
    case "object":
      return `${reference.name} prop`;
    case "collage":
      return reference.name;
  }
}

function buildCollageOutputPath(outputPath: string): string {
  const parsed = path.parse(outputPath);
  return path.join(parsed.dir, `${parsed.name}_reference_collage.jpg`);
}

/** Canonical start-frame path for a shot. Exported so promotion callers
 *  (apply.ts) can compute the destination without duplicating the naming
 *  convention used by `generateFrame`. */
export function buildStartFramePath(opts: {
  outputDir: string;
  sceneNumber: number;
  shotInScene: number;
  version?: number;
}): string {
  const v = opts.version ?? 1;
  return path.join(
    opts.outputDir,
    'frames',
    `scene_${opts.sceneNumber}_shot_${opts.shotInScene}_v${v}_start.png`,
  );
}

const MAX_COLLAGE_CELL_PX = 512;

async function createReferenceCollage(references: FrameReference[], outputPath: string): Promise<string> {
  const metadata = await Promise.all(references.map(reference => sharp(reference.path).metadata()));
  let cellWidth = Math.max(...metadata.map(entry => entry.width ?? 1024));
  let cellHeight = Math.max(...metadata.map(entry => entry.height ?? 1024));

  // Cap cell size at MAX_COLLAGE_CELL_PX on the long edge
  const longEdge = Math.max(cellWidth, cellHeight);
  if (longEdge > MAX_COLLAGE_CELL_PX) {
    const scale = MAX_COLLAGE_CELL_PX / longEdge;
    cellWidth = Math.round(cellWidth * scale);
    cellHeight = Math.round(cellHeight * scale);
  }

  const columns = Math.ceil(Math.sqrt(references.length));
  const rows = Math.ceil(references.length / columns);

  const composites = await Promise.all(references.map(async (reference, index) => ({
    input: await sharp(reference.path)
      .resize(cellWidth, cellHeight, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 1 },
      })
      .jpeg({ quality: 80 })
      .toBuffer(),
    left: (index % columns) * cellWidth,
    top: Math.floor(index / columns) * cellHeight,
  })));

  await sharp({
    create: {
      width: columns * cellWidth,
      height: rows * cellHeight,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite(composites)
    .jpeg({ quality: 80 })
    .toFile(outputPath);

  return outputPath;
}

export function buildReferenceLeadIn(referencesUsed: FrameReference[]): string {
  const labels = referencesUsed.map((reference, index) => {
    const n = index + 1;
    switch (reference.type) {
      case "character":
        return `Image ${n}: ${reference.name}.`;
      case "continuity":
        return `Image ${n}: previous shot.`;
      case "location":
        return `Image ${n}: ${reference.name} location.`;
      case "object":
        return `Image ${n}: ${reference.name} prop.`;
      case "collage":
        return `Image ${n}: props collage.`;
    }
  });

  return labels.join(" ");
}

export function buildFinalFramePrompt(params: {
  artStyle: string;
  composition: string;
  locationDescription: string;
  charactersPresent: string[];
  objectsPresent?: string[];
  framePrompt: string;
  cameraDirection: string;
  hasCharacterDialogue: boolean;
  referencesUsed: FrameReference[];
  directorsNote?: string;
}): string {
  const basePrompt = buildFramePrompt({
    artStyle: params.artStyle,
    composition: params.composition,
    locationDescription: params.locationDescription,
    charactersPresent: params.charactersPresent,
    objectsPresent: params.objectsPresent,
    framePrompt: params.framePrompt,
    cameraDirection: params.cameraDirection,
    hasCharacterDialogue: params.hasCharacterDialogue,
    hasReferenceImages: params.referencesUsed.length > 0,
  });

  const referenceLeadIn = params.referencesUsed.length > 0
    ? buildReferenceLeadIn(params.referencesUsed)
    : "";

  let prompt = referenceLeadIn ? `${referenceLeadIn} ${basePrompt}` : basePrompt;
  if (params.directorsNote) {
    prompt += `\n\nDirector's note: ${params.directorsNote}`;
  }
  return prompt;
}

export async function buildFrameReferencePlan(params: {
  shot: Shot;
  assetLibrary: AssetLibrary;
  imageBackend: ImageBackend;
  collageOutputPath: string;
}): Promise<PlannedFrameReferences> {
  const { shot, assetLibrary, imageBackend, collageOutputPath } = params;
  const maxRefs = imageBackend === "grok" ? 5 : 6;
  const referencesUsed: FrameReference[] = [];
  const droppedReferences: FrameReference[] = [];
  const mergedReferences: FrameReference[] = [];

  const characterReferences = shot.charactersPresent.flatMap((name): FrameReference[] => {
    const refs = assetLibrary.characterImages[name];
    const refPath = refs?.front || refs?.angle;
    return refPath && fs.existsSync(refPath)
      ? [{ type: "character", name, path: refPath }]
      : [];
  });

  const locationRefPath = assetLibrary.locationImages[shot.location];
  const locationReference = locationRefPath && fs.existsSync(locationRefPath)
    ? { type: "location" as const, name: shot.location, path: locationRefPath }
    : undefined;

  const objectReferences = (shot.objectsPresent ?? []).flatMap((name): FrameReference[] => {
    const refPath = assetLibrary.objectImages?.[name];
    return refPath && fs.existsSync(refPath)
      ? [{ type: "object", name, path: refPath }]
      : [];
  });

  const pushWithPriority = (reference: FrameReference): void => {
    if (referencesUsed.length < maxRefs) {
      referencesUsed.push(reference);
      return;
    }
    droppedReferences.push(reference);
  };

  for (const reference of characterReferences) {
    pushWithPriority(reference);
  }

  if (locationReference) {
    pushWithPriority(locationReference);
  }

  const remainingObjectSlots = maxRefs - referencesUsed.length;
  if (remainingObjectSlots <= 0) {
    droppedReferences.push(...objectReferences);
  } else if (objectReferences.length <= remainingObjectSlots) {
    referencesUsed.push(...objectReferences);
  } else {
    const individualObjectCount = Math.max(0, remainingObjectSlots - 1);
    referencesUsed.push(...objectReferences.slice(0, individualObjectCount));
    mergedReferences.push(...objectReferences.slice(individualObjectCount));
  }

  if (mergedReferences.length > 1 && referencesUsed.length < maxRefs) {
    try {
      const collagePath = await createReferenceCollage(mergedReferences, collageOutputPath);
      referencesUsed.push({
        type: "collage",
        name: mergedReferences.map(describeReferenceForCollage).join(", "),
        path: collagePath,
      });
    } catch (error) {
      console.warn(`[generateFrame] Failed to create reference collage: ${error instanceof Error ? error.message : String(error)}`);
      droppedReferences.push(...mergedReferences);
      mergedReferences.length = 0;
    }
  }

  return {
    referenceImagePaths: referencesUsed.map(reference => reference.path),
    referencesUsed,
    mergedReferences,
    droppedReferences,
  };
}

/**
 * Generates start keyframe image for a shot using the Reve/Grok API.
 */
export async function generateFrame(params: {
  shot: Shot;
  artStyle: string;
  assetLibrary: AssetLibrary;
  outputDir: string;
  dryRun?: boolean;
  imageBackend?: ImageBackend;
  videoBackend?: LegacyImageBackend;
  aspectRatio?: string;
  version?: number;
  directorsNote?: string;
}): Promise<{
  shotNumber: number;
  startPath?: string;
  startReferences?: FrameReference[];
  finalPrompt?: string;
}> {
  const { shot, artStyle, assetLibrary, outputDir, dryRun = false, imageBackend, videoBackend, aspectRatio, version = 1 } = params;
  const shotContext = formatShotContext(shot);
  const resolvedImageBackend = resolveImageBackend(imageBackend, videoBackend);

  // Create frames directory if it doesn't exist
  const framesDir = path.join(outputDir, "frames");
  if (!dryRun && !fs.existsSync(framesDir)) {
    fs.mkdirSync(framesDir, { recursive: true });
  }

  const startPath = buildStartFramePath({
    outputDir,
    sceneNumber: shot.sceneNumber,
    shotInScene: shot.shotInScene,
    version,
  });

  if (dryRun) {
    // Return placeholder paths without calling API
    return {
      shotNumber: shot.shotNumber,
      startPath,
      startReferences: [],
    };
  }

  try {
    const startFrameResult = await generateSingleFrame({
      shot,
      artStyle,
      assetLibrary,
      outputPath: startPath,
      imageBackend: resolvedImageBackend,
      aspectRatio,
      directorsNote: params.directorsNote,
    });

    return {
      shotNumber: shot.shotNumber,
      startPath: startFrameResult.path,
      startReferences: startFrameResult.referencesUsed,
      finalPrompt: startFrameResult.finalPrompt,
    };
  } catch (error) {
    throw new Error(
      `Failed to generate frame for ${shotContext}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Generates a single start frame with reference images using the selected image backend.
 */
async function generateSingleFrame(params: {
  shot: Shot;
  artStyle: string;
  assetLibrary: AssetLibrary;
  outputPath: string;
  imageBackend: ImageBackend;
  aspectRatio?: string;
  directorsNote?: string;
}): Promise<GeneratedSingleFrameResult> {
  const {
    shot,
    artStyle,
    assetLibrary,
    outputPath,
    imageBackend,
    aspectRatio,
  } = params;

  const normalizedSpeaker = (shot.speaker ?? "").trim().toLowerCase();
  const hasCharacterDialogue = Boolean(shot.dialogue.trim())
    && shot.charactersPresent.length > 1
    && normalizedSpeaker !== "narrator"
    && normalizedSpeaker !== "voiceover";

  const shotContext = formatShotContext(shot);

  console.log(`[generateFrame] ${shotContext} (start): Building references...`);
  console.log(`[generateFrame]   assetLibrary.characterImages:`, JSON.stringify(assetLibrary.characterImages));
  console.log(`[generateFrame]   assetLibrary.locationImages:`, JSON.stringify(assetLibrary.locationImages));
  console.log(`[generateFrame]   shot.charactersPresent:`, shot.charactersPresent);
  console.log(`[generateFrame]   shot.location:`, shot.location);

  for (const charName of shot.charactersPresent) {
    const charRefs = assetLibrary.characterImages[charName];
    const refPath = charRefs?.front || charRefs?.angle;
    console.log(`[generateFrame]   Character ref "${charName}": front=${JSON.stringify(charRefs?.front)}, angle=${JSON.stringify(charRefs?.angle)}, chosen=${JSON.stringify(refPath)}, exists=${refPath ? fs.existsSync(refPath) : 'N/A'}`);
    if (!charRefs) {
      console.log(`[generateFrame]   Character ref "${charName}": NOT FOUND in assetLibrary`);
    }
  }

  const locationRef = assetLibrary.locationImages[shot.location];
  console.log(`[generateFrame]   Location ref "${shot.location}": path=${JSON.stringify(locationRef)}, exists=${locationRef ? fs.existsSync(locationRef) : 'N/A'}`);

  const referencePlan = await buildFrameReferencePlan({
    shot,
    assetLibrary,
    imageBackend,
    collageOutputPath: buildCollageOutputPath(outputPath),
  });

  const basePrompt = buildFramePrompt({
    artStyle,
    composition: shot.composition,
    locationDescription: shot.location,
    charactersPresent: shot.charactersPresent,
    objectsPresent: shot.objectsPresent,
    framePrompt: shot.startFramePrompt,
    cameraDirection: shot.cameraDirection,
    hasCharacterDialogue,
    hasReferenceImages: referencePlan.referenceImagePaths.length > 0,
  });
  const finalPrompt = buildFinalFramePrompt({
    artStyle,
    composition: shot.composition,
    locationDescription: shot.location,
    charactersPresent: shot.charactersPresent,
    objectsPresent: shot.objectsPresent,
    framePrompt: shot.startFramePrompt,
    cameraDirection: shot.cameraDirection,
    hasCharacterDialogue,
    referencesUsed: referencePlan.referencesUsed,
    directorsNote: params.directorsNote,
  });

  console.log(`[generateFrame]   Included refs:`, referencePlan.referencesUsed.map(summarizeReference));
  console.log(`[generateFrame]   Merged refs:`, referencePlan.mergedReferences.map(summarizeReference));
  console.log(`[generateFrame]   Dropped refs:`, referencePlan.droppedReferences.map(summarizeReference));

  if (referencePlan.referenceImagePaths.length > 0) {
    if (imageBackend === "reve" && finalPrompt.length > 2560) {
      console.warn(`[generateFrame] ${shotContext}: Prompt is ${finalPrompt.length} chars (limit 2560). May be rejected by Reve.`);
    }

    console.log(`[generateFrame]   Final reference paths (${referencePlan.referenceImagePaths.length}):`, referencePlan.referenceImagePaths);
    console.log(`[generateFrame]   Prompt (first 200 chars): ${finalPrompt.substring(0, 200)}...`);

    switch (imageBackend) {
      case "grok":
        return {
          path: await remixImageGrok(finalPrompt, referencePlan.referenceImagePaths, {
            aspectRatio: aspectRatio ?? "16:9",
            outputPath,
          }),
          referencesUsed: referencePlan.referencesUsed,
          finalPrompt,
        };
      case "nano-banana":
        return {
          path: await remixImageNanoBanana(finalPrompt, referencePlan.referenceImagePaths, {
            aspectRatio: aspectRatio ?? "16:9",
            outputPath,
          }),
          referencesUsed: referencePlan.referencesUsed,
          finalPrompt,
        };
      case "reve":
        return {
          path: await remixImage(finalPrompt, referencePlan.referenceImagePaths, {
            aspectRatio: aspectRatio ?? "16:9",
            outputPath,
          }),
          referencesUsed: referencePlan.referencesUsed,
          finalPrompt,
        };
    }
  }

  console.log(`[generateFrame]   NO reference images found — falling back to text-to-image`);
  console.log(`[generateFrame]   Prompt (first 200 chars): ${basePrompt.substring(0, 200)}...`);
  if (imageBackend === "reve" && finalPrompt.length > 2560) {
    console.warn(`[generateFrame] ${shotContext}: Prompt is ${finalPrompt.length} chars (limit 2560). May be rejected by Reve.`);
  }

  switch (imageBackend) {
    case "grok":
      return {
        path: await createImageGrok(finalPrompt, {
          aspectRatio: aspectRatio ?? "16:9",
          outputPath,
        }),
        referencesUsed: [],
        finalPrompt,
      };
    case "nano-banana":
      return {
        path: await createImageNanoBanana(finalPrompt, {
          aspectRatio: aspectRatio ?? "16:9",
          outputPath,
        }),
        referencesUsed: [],
        finalPrompt,
      };
    case "reve":
      return {
        path: await createImage(finalPrompt, {
          aspectRatio: aspectRatio ?? "16:9",
          outputPath,
        }),
        referencesUsed: [],
        finalPrompt,
      };
  }
}

/**
 * Returns a composition-aware gaze direction instruction for the frame prompt.
 * Every shot gets a gaze instruction — not just dialogue shots.
 */
function buildGazeInstruction(params: {
  composition: string;
  charactersPresent: string[];
  hasCharacterDialogue: boolean;
}): string {
  const { composition, charactersPresent, hasCharacterDialogue } = params;
  const comp = composition.toLowerCase();
  const charCount = charactersPresent.length;

  // Wide/establishing shots: characters engaged in environment
  if (comp.includes("wide") || comp.includes("establishing")) {
    return FRAME_GAZE_WIDE;
  }

  // Multi-character dialogue shots
  if (charCount >= 2 && hasCharacterDialogue) {
    return FRAME_GAZE_MULTI_DIALOGUE;
  }

  // Multi-character non-dialogue (reaction, group activity)
  if (charCount >= 2) {
    return FRAME_GAZE_MULTI_NO_DIALOGUE;
  }

  // Solo character with dialogue (speaking to someone off-screen)
  if (charCount === 1 && hasCharacterDialogue) {
    return FRAME_GAZE_SOLO_DIALOGUE;
  }

  // Solo character, no dialogue (thinking, reacting, doing something)
  if (charCount === 1) {
    return FRAME_GAZE_SOLO_NO_DIALOGUE;
  }

  // No characters (object shots, empty scenes)
  return "";
}

/**
 * Builds a detailed prompt for frame generation.
 *
 * When `hasReferenceImages` is true (the common case), outputs a slim prompt
 * that omits verbose location/character descriptions — those come from the
 * reference images themselves. When false (rare edge-case with no refs),
 * keeps the fuller legacy format as a fallback.
 */
export function buildFramePrompt(params: {
  artStyle: string;
  composition: string;
  locationDescription: string;
  charactersPresent: string[];
  objectsPresent?: string[];
  framePrompt: string;
  cameraDirection: string;
  hasCharacterDialogue: boolean;
  hasReferenceImages: boolean;
}): string {
  const {
    artStyle,
    composition,
    locationDescription,
    charactersPresent,
    objectsPresent,
    framePrompt,
    cameraDirection,
    hasCharacterDialogue,
    hasReferenceImages,
  } = params;

  const gazeInstruction = buildGazeInstruction({ composition, charactersPresent, hasCharacterDialogue });

  // Format composition: replace underscores with spaces (e.g. "medium_shot" → "medium shot")
  const formattedComposition = composition.replace(/_/g, " ");

  // Select style prefix based on whether characters are present
  const stylePrefix = charactersPresent.length > 0 ? FRAME_PROMPT_STYLE_PREFIX : FRAME_PROMPT_STYLE_PREFIX_NO_CHARACTERS;

  // Defensive instruction: only named characters should appear, no unnamed humans
  const humanPresenceInstruction = charactersPresent.length > 0
    ? `ONLY the following characters should appear in this image: ${charactersPresent.join(", ")}. No other people, no background figures, no staff, no unnamed humans.`
    : "No people should appear in this image. No humans, no staff, no background figures.";

  if (hasReferenceImages) {
    // Slim prompt — reference images provide character/location appearance
    const parts = [
      stylePrefix,
      `Style: ${artStyle}.`,
      `${formattedComposition}, ${cameraDirection}.`,
      (objectsPresent && objectsPresent.length > 0) ? `Objects/props: ${objectsPresent.join(", ")}.` : "",
      gazeInstruction,
      humanPresenceInstruction,
      framePrompt,
    ].filter(Boolean);
    return parts.join(" ");
  }

  // Fallback — no reference images, include full descriptions
  const parts = [
    stylePrefix,
    `Style: ${artStyle}.`,
    `${formattedComposition}, ${cameraDirection}.`,
    `Location: ${locationDescription}.`,
    charactersPresent.length > 0 ? `Characters: ${charactersPresent.join(", ")}. All characters must have original appearances — no celebrity likenesses.` : "",
    (objectsPresent && objectsPresent.length > 0) ? `Objects/props: ${objectsPresent.join(", ")}.` : "",
    gazeInstruction,
    humanPresenceInstruction,
    framePrompt,
  ].filter(Boolean);

  return parts.join(" ");
}

/**
 * Zod-based tool definition for Claude to call generateFrame.
 */
export const generateFrameTool = {
  description:
    "Generate start keyframe image for a shot using the configured image backend.",
  parameters: z.object({
    shot: z.object({
      shotNumber: z.number(),
      sceneNumber: z.number(),
      shotInScene: z.number(),
      durationSeconds: z.number(),
      shotType: z.literal("first_last_frame"),
      composition: z.string(),
      startFramePrompt: z.string(),
      dialogue: z.string(),
      speaker: z.string().optional(),
      soundEffects: z.string(),
      cameraDirection: z.string(),
      charactersPresent: z.array(z.string()),
      objectsPresent: z.array(z.string()).optional(),
      location: z.string(),
    }).describe("The shot to generate keyframes for"),
    artStyle: z.string().describe("The visual art style for the entire video"),
    assetLibrary: z.object({
      characterImages: z.record(z.string(), z.object({ front: z.string(), angle: z.string() })),
      locationImages: z.record(z.string(), z.string()),
      objectImages: z.record(z.string(), z.string()).optional(),
    }).describe("AssetLibrary with character, location, and object reference image paths"),
    outputDir: z.string().describe("Output directory for saving frame images"),
    dryRun: z
      .boolean()
      .optional()
      .describe("If true, return placeholder paths without calling API"),
  }),
};

