import { z } from "zod";
import sharp from "sharp";
import { createImage, remixImage } from "../reve-client";
import { createImageGrok, remixImageGrok } from "../grok-image-client";
import { createImageNanoBanana, remixImageNanoBanana } from "../nano-banana-image-client";
import type { Shot, AssetLibrary, FrameReference, ImageBackend, VideoBackend } from "../types";
import * as fs from "fs";
import * as path from "path";

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
};

export type PlannedFrameReferences = {
  referenceImagePaths: string[];
  referencesUsed: FrameReference[];
  mergedReferences: FrameReference[];
  droppedReferences: FrameReference[];
};

const ORDINAL_WORDS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];

function formatShotContext(shot: Pick<Shot, "shotNumber" | "sceneNumber" | "shotInScene">): string {
  return `scene ${shot.sceneNumber} shot ${shot.shotInScene} (shot ${shot.shotNumber})`;
}

function getOrdinalWord(index: number): string {
  return ORDINAL_WORDS[index] ?? `${index + 1}th`;
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
  return path.join(parsed.dir, `${parsed.name}_reference_collage.png`);
}

async function createReferenceCollage(references: FrameReference[], outputPath: string): Promise<string> {
  const metadata = await Promise.all(references.map(reference => sharp(reference.path).metadata()));
  const cellWidth = Math.max(...metadata.map(entry => entry.width ?? 1024));
  const cellHeight = Math.max(...metadata.map(entry => entry.height ?? 1024));
  const columns = Math.ceil(Math.sqrt(references.length));
  const rows = Math.ceil(references.length / columns);

  const composites = await Promise.all(references.map(async (reference, index) => ({
    input: await sharp(reference.path)
      .resize(cellWidth, cellHeight, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 1 },
      })
      .png()
      .toBuffer(),
    left: (index % columns) * cellWidth,
    top: Math.floor(index / columns) * cellHeight,
  })));

  await sharp({
    create: {
      width: columns * cellWidth,
      height: rows * cellHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  })
    .composite(composites)
    .png()
    .toFile(outputPath);

  return outputPath;
}

export function buildReferenceLeadIn(referencesUsed: FrameReference[]): string {
  return referencesUsed.map((reference, index) => {
    const ordinal = getOrdinalWord(index);
    switch (reference.type) {
      case "character":
        return `The ${ordinal} image is ${toPossessive(reference.name)} appearance reference.`;
      case "continuity":
        return `The ${ordinal} image shows the previous shot for visual continuity.`;
      case "location":
        return `The ${ordinal} image is the location setting for ${reference.name}.`;
      case "object":
        return `The ${ordinal} image is the ${reference.name} prop reference.`;
      case "collage":
        return `The ${ordinal} image is a collage of the remaining references: ${reference.name}.`;
    }
  }).join(" ");
}

export async function buildFrameReferencePlan(params: {
  shot: Shot;
  assetLibrary: AssetLibrary;
  imageBackend: ImageBackend;
  previousFramePath?: string;
  collageOutputPath: string;
}): Promise<PlannedFrameReferences> {
  const { shot, assetLibrary, imageBackend, previousFramePath, collageOutputPath } = params;
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

  const previousFrameReference = previousFramePath
    && !shot.continuousFromPrevious
    && shot.shotInScene > 1
    && fs.existsSync(previousFramePath)
    ? { type: "continuity" as const, name: "Previous shot frame", path: previousFramePath }
    : undefined;

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

  if (previousFrameReference) {
    pushWithPriority(previousFrameReference);
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
  previousFramePath?: string;
}): Promise<{
  shotNumber: number;
  startPath?: string;
  startReferences?: FrameReference[];
}> {
  const { shot, artStyle, assetLibrary, outputDir, dryRun = false, imageBackend, videoBackend, aspectRatio, version = 1, previousFramePath } = params;
  const shotContext = formatShotContext(shot);
  const resolvedImageBackend = resolveImageBackend(imageBackend, videoBackend);

  // Create frames directory if it doesn't exist
  const framesDir = path.join(outputDir, "frames");
  if (!dryRun && !fs.existsSync(framesDir)) {
    fs.mkdirSync(framesDir, { recursive: true });
  }

  const startPath = path.join(framesDir, `scene_${shot.sceneNumber}_shot_${shot.shotInScene}_v${version}_start.png`);

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
      previousFramePath,
    });

    return {
      shotNumber: shot.shotNumber,
      startPath: startFrameResult.path,
      startReferences: startFrameResult.referencesUsed,
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
  previousFramePath?: string;
}): Promise<GeneratedSingleFrameResult> {
  const {
    shot,
    artStyle,
    assetLibrary,
    outputPath,
    imageBackend,
    aspectRatio,
    previousFramePath,
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

  console.log(`[generateFrame]   Previous frame ref: path=${JSON.stringify(previousFramePath)}, eligible=${!shot.continuousFromPrevious && shot.shotInScene > 1}, exists=${previousFramePath ? fs.existsSync(previousFramePath) : 'N/A'}`);

  const referencePlan = await buildFrameReferencePlan({
    shot,
    assetLibrary,
    imageBackend,
    previousFramePath,
    collageOutputPath: buildCollageOutputPath(outputPath),
  });

  const hasReferenceImages = referencePlan.referenceImagePaths.length > 0;
  const framePrompt = shot.startFramePrompt;
  const prompt = buildFramePrompt({
    artStyle,
    composition: shot.composition,
    locationDescription: shot.location,
    charactersPresent: shot.charactersPresent,
    objectsPresent: shot.objectsPresent,
    framePrompt,
    cameraDirection: shot.cameraDirection,
    hasCharacterDialogue,
    hasReferenceImages,
  });

  console.log(`[generateFrame]   Included refs:`, referencePlan.referencesUsed.map(summarizeReference));
  console.log(`[generateFrame]   Merged refs:`, referencePlan.mergedReferences.map(summarizeReference));
  console.log(`[generateFrame]   Dropped refs:`, referencePlan.droppedReferences.map(summarizeReference));

  if (referencePlan.referenceImagePaths.length > 0) {
    const referenceLeadIn = buildReferenceLeadIn(referencePlan.referencesUsed);
    const remixPrompt = referenceLeadIn ? `${referenceLeadIn} ${prompt}` : prompt;
    if (imageBackend === "reve" && remixPrompt.length > 2560) {
      console.warn(`[generateFrame] ${shotContext}: Prompt is ${remixPrompt.length} chars (limit 2560). May be rejected by Reve.`);
    }

    console.log(`[generateFrame]   Final reference paths (${referencePlan.referenceImagePaths.length}):`, referencePlan.referenceImagePaths);
    console.log(`[generateFrame]   Prompt (first 200 chars): ${remixPrompt.substring(0, 200)}...`);

    switch (imageBackend) {
      case "grok":
        return {
          path: await remixImageGrok(remixPrompt, referencePlan.referenceImagePaths, {
            aspectRatio: aspectRatio ?? "16:9",
            outputPath,
          }),
          referencesUsed: referencePlan.referencesUsed,
        };
      case "nano-banana":
        return {
          path: await remixImageNanoBanana(remixPrompt, referencePlan.referenceImagePaths, {
            aspectRatio: aspectRatio ?? "16:9",
            outputPath,
          }),
          referencesUsed: referencePlan.referencesUsed,
        };
      case "reve":
        return {
          path: await remixImage(remixPrompt, referencePlan.referenceImagePaths, {
            aspectRatio: aspectRatio ?? "16:9",
            outputPath,
          }),
          referencesUsed: referencePlan.referencesUsed,
        };
    }
  }

  console.log(`[generateFrame]   NO reference images found — falling back to text-to-image`);
  console.log(`[generateFrame]   Prompt (first 200 chars): ${prompt.substring(0, 200)}...`);
  if (imageBackend === "reve" && prompt.length > 2560) {
    console.warn(`[generateFrame] ${shotContext}: Prompt is ${prompt.length} chars (limit 2560). May be rejected by Reve.`);
  }

  switch (imageBackend) {
    case "grok":
      return {
        path: await createImageGrok(prompt, {
          aspectRatio: aspectRatio ?? "16:9",
          outputPath,
        }),
        referencesUsed: [],
      };
    case "nano-banana":
      return {
        path: await createImageNanoBanana(prompt, {
          aspectRatio: aspectRatio ?? "16:9",
          outputPath,
        }),
        referencesUsed: [],
      };
    case "reve":
      return {
        path: await createImage(prompt, {
          aspectRatio: aspectRatio ?? "16:9",
          outputPath,
        }),
        referencesUsed: [],
      };
  }
}

/**
 * Builds a detailed prompt for frame generation.
 *
 * When `hasReferenceImages` is true (the common case), outputs a slim prompt
 * that omits verbose location/character descriptions — those come from the
 * reference images themselves. When false (rare edge-case with no refs),
 * keeps the fuller legacy format as a fallback.
 */
function buildFramePrompt(params: {
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

  if (hasReferenceImages) {
    // Slim prompt — reference images provide character/location appearance
    const locationName = locationDescription.split(",")[0].split(".")[0].trim();
    const parts = [
      `Style: ${artStyle}.`,
      `${composition} shot, ${cameraDirection}.`,
      `Location: ${locationName}.`,
      (objectsPresent && objectsPresent.length > 0) ? `Objects/props: ${objectsPresent.join(", ")}.` : "",
      hasCharacterDialogue ? "Characters face each other, not the camera." : "",
      framePrompt,
    ].filter(Boolean);
    return parts.join(" ");
  }

  // Fallback — no reference images, include full descriptions
  const parts = [
    `Style: ${artStyle}.`,
    `${composition} shot, ${cameraDirection}.`,
    `Location: ${locationDescription}.`,
    charactersPresent.length > 0 ? `Characters: ${charactersPresent.join(", ")}. All characters must have original appearances — no celebrity likenesses.` : "",
    (objectsPresent && objectsPresent.length > 0) ? `Objects/props: ${objectsPresent.join(", ")}.` : "",
    hasCharacterDialogue ? "Characters face each other, not the camera." : "",
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
      actionPrompt: z.string(),
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
    previousFramePath: z.string().optional().describe("Optional previous shot start frame path for continuity references"),
    dryRun: z
      .boolean()
      .optional()
      .describe("If true, return placeholder paths without calling API"),
  }),
};

