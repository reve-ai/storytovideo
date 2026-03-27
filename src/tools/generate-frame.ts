import { z } from "zod";
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

function formatShotContext(shot: Pick<Shot, "shotNumber" | "sceneNumber" | "shotInScene">): string {
  return `scene ${shot.sceneNumber} shot ${shot.shotInScene} (shot ${shot.shotNumber})`;
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
}): Promise<{
  shotNumber: number;
  startPath?: string;
  startReferences?: FrameReference[];
}> {
  const { shot, artStyle, assetLibrary, outputDir, dryRun = false, imageBackend, videoBackend, aspectRatio, version = 1 } = params;
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

  // Pre-check whether any reference images exist in the asset library
  const hasAnyCharRef = shot.charactersPresent.some(name => {
    const refs = assetLibrary.characterImages[name];
    return refs && (refs.front || refs.angle);
  });
  const hasLocationRef = Boolean(assetLibrary.locationImages[shot.location]);
  const hasReferenceImages = hasAnyCharRef || hasLocationRef;

  // Build the prompt
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

  const shotContext = formatShotContext(shot);

  console.log(`[generateFrame] ${shotContext} (start): Building references...`);
  console.log(`[generateFrame]   assetLibrary.characterImages:`, JSON.stringify(assetLibrary.characterImages));
  console.log(`[generateFrame]   assetLibrary.locationImages:`, JSON.stringify(assetLibrary.locationImages));
  console.log(`[generateFrame]   shot.charactersPresent:`, shot.charactersPresent);
  console.log(`[generateFrame]   shot.location:`, shot.location);

  // Collect reference image file paths.
  // Order: location > character > object.
  const characterRefPaths = new Map<string, string>(); // path -> character name
  const objectRefPaths = new Map<string, string>(); // path -> object name
  const referenceImagePaths: string[] = [];

  // Add location reference image if available
  const locationRef = assetLibrary.locationImages[shot.location];
  if (locationRef && fs.existsSync(locationRef)) {
    referenceImagePaths.push(locationRef);
  }
  console.log(`[generateFrame]   Location ref "${shot.location}": path=${JSON.stringify(locationRef)}, exists=${locationRef ? fs.existsSync(locationRef) : 'N/A'}`);

  // Add character reference images for all characters present
  for (const charName of shot.charactersPresent) {
    const charRefs = assetLibrary.characterImages[charName];
    if (charRefs) {
      const refPath = charRefs.front || charRefs.angle;
      if (refPath && fs.existsSync(refPath)) {
        referenceImagePaths.push(refPath);
        characterRefPaths.set(refPath, charName);
      }
      console.log(`[generateFrame]   Character ref "${charName}": front=${JSON.stringify(charRefs?.front)}, angle=${JSON.stringify(charRefs?.angle)}, chosen=${JSON.stringify(refPath)}, exists=${refPath ? fs.existsSync(refPath) : 'N/A'}`);
    } else {
      console.log(`[generateFrame]   Character ref "${charName}": NOT FOUND in assetLibrary`);
    }
  }

  // Add object reference images for all objects present
  const objectImages = assetLibrary.objectImages ?? {};
  for (const objName of (shot.objectsPresent ?? [])) {
    const objRef = objectImages[objName];
    if (objRef && fs.existsSync(objRef)) {
      referenceImagePaths.push(objRef);
      objectRefPaths.set(objRef, objName);
    }
  }

  // Limit reference images: Grok supports up to 5, Reve and Nano Banana up to 6 here.
  const maxRefs = imageBackend === "grok" ? 5 : 6;
  const limitedReferencePaths = referenceImagePaths.slice(0, maxRefs);
  const referencesUsed = limitedReferencePaths.map((refPath): FrameReference => {
    if (refPath === locationRef) {
      return { type: "location", name: shot.location, path: refPath };
    }
    if (characterRefPaths.has(refPath)) {
      return { type: "character", name: characterRefPaths.get(refPath)!, path: refPath };
    }
    if (objectRefPaths.has(refPath)) {
      return { type: "object", name: objectRefPaths.get(refPath)!, path: refPath };
    }
    return {
      type: "continuity",
      name: "Previous shot frame",
      path: refPath,
    };
  });

  if (limitedReferencePaths.length > 0) {
    // Build <img> tag prefix to reference images by index
    const imgTagParts: string[] = [];
    for (let i = 0; i < limitedReferencePaths.length; i++) {
      const refPath = limitedReferencePaths[i];
      if (refPath === locationRef) {
        imgTagParts.push(`<img>${i}</img> location`);
      } else if (characterRefPaths.has(refPath)) {
        imgTagParts.push(`<img>${i}</img> ${characterRefPaths.get(refPath)} ref`);
      } else if (objectRefPaths.has(refPath)) {
        imgTagParts.push(`<img>${i}</img> ${objectRefPaths.get(refPath)} object ref`);
      } else {
        imgTagParts.push(`<img>${i}</img> continuity (style only)`);
      }
    }
    const imgPrefix = `Using ${imgTagParts.join(", ")}: `;
    const remixPrompt = imgPrefix + prompt;
    if (imageBackend === "reve" && remixPrompt.length > 2560) {
      console.warn(`[generateFrame] ${shotContext}: Prompt is ${remixPrompt.length} chars (limit 2560). May be rejected by Reve.`);
    }

    console.log(`[generateFrame]   Final reference paths (${limitedReferencePaths.length}):`, limitedReferencePaths);
    console.log(`[generateFrame]   Prompt (first 200 chars): ${remixPrompt.substring(0, 200)}...`);

    switch (imageBackend) {
      case "grok":
        return {
          path: await remixImageGrok(remixPrompt, limitedReferencePaths, {
            aspectRatio: aspectRatio ?? "16:9",
            outputPath,
          }),
          referencesUsed,
        };
      case "nano-banana":
        return {
          path: await remixImageNanoBanana(remixPrompt, limitedReferencePaths, {
            aspectRatio: aspectRatio ?? "16:9",
            outputPath,
          }),
          referencesUsed,
        };
      case "reve":
        return {
          path: await remixImage(remixPrompt, limitedReferencePaths, {
            aspectRatio: aspectRatio ?? "16:9",
            outputPath,
          }),
          referencesUsed,
        };
    }
  } else {
    // No reference images — use text-to-image generation
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
    dryRun: z
      .boolean()
      .optional()
      .describe("If true, return placeholder paths without calling API"),
  }),
};

