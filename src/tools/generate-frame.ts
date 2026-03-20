import { z } from "zod";
import { createImage, remixImage } from "../reve-client";
import type { Shot, AssetLibrary } from "../types";
import * as fs from "fs";
import * as path from "path";

/**
 * Returns the aspect ratio frames should be generated at for a given video backend.
 */
export function getFrameAspectRatio(videoBackend?: "veo" | "comfy"): string {
  return videoBackend === "veo" ? "16:9" : "1:1";
}

/**
 * Generates start/end keyframe images for shots using the Reve API.
 * For first_last_frame shots: generates both start and end frames.
 * For extension shots: returns immediately (no frames needed).
 */
export async function generateFrame(params: {
  shot: Shot;
  artStyle: string;
  assetLibrary: AssetLibrary;
  outputDir: string;
  dryRun?: boolean;
  previousEndFramePath?: string;
  videoBackend?: "veo" | "comfy";
}): Promise<{ shotNumber: number; startPath?: string; endPath?: string }> {
  const { shot, artStyle, assetLibrary, outputDir, dryRun = false, previousEndFramePath, videoBackend } = params;

  // Create frames directory if it doesn't exist
  const framesDir = path.join(outputDir, "frames");
  if (!dryRun && !fs.existsSync(framesDir)) {
    fs.mkdirSync(framesDir, { recursive: true });
  }

  const startPath = path.join(framesDir, `shot_${shot.shotNumber}_start.png`);
  const endPath = path.join(framesDir, `shot_${shot.shotNumber}_end.png`);

  if (dryRun) {
    // Return placeholder paths without calling API
    return {
      shotNumber: shot.shotNumber,
      startPath,
      endPath,
    };
  }

  // Hard continuity: copy previous shot's end frame as this shot's start frame
  if (shot.continuousFromPrevious && previousEndFramePath && fs.existsSync(previousEndFramePath)) {
    console.log(`[generateFrame] Shot ${shot.shotNumber}: copying previous end frame for continuity`);
    fs.copyFileSync(previousEndFramePath, startPath);

    // Generate only the end frame
    const endFramePath = await generateSingleFrame({
      shot,
      artStyle,
      assetLibrary,
      isEndFrame: true,
      previousStartFramePath: startPath,
      outputPath: endPath,
      videoBackend,
    });

    return {
      shotNumber: shot.shotNumber,
      startPath,
      endPath: endFramePath,
    };
  }

  // Non-continuous path: generate both frames from prompts
  const continuityRefPath = previousEndFramePath && fs.existsSync(previousEndFramePath)
    ? previousEndFramePath
    : undefined;

  try {
    // Generate start frame
    const startFramePath = await generateSingleFrame({
      shot,
      artStyle,
      assetLibrary,
      isEndFrame: false,
      previousStartFramePath: undefined,
      previousEndFramePath: continuityRefPath,
      outputPath: startPath,
      videoBackend,
    });

    // Generate end frame (with start frame as additional input for continuity)
    const endFramePath = await generateSingleFrame({
      shot,
      artStyle,
      assetLibrary,
      isEndFrame: true,
      previousStartFramePath: startFramePath,
      outputPath: endPath,
      videoBackend,
    });

    return {
      shotNumber: shot.shotNumber,
      startPath: startFramePath,
      endPath: endFramePath,
    };
  } catch (error) {
    throw new Error(
      `Failed to generate frames for shot ${shot.shotNumber}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Generates a single frame (start or end) with reference images using the Reve API.
 */
async function generateSingleFrame(params: {
  shot: Shot;
  artStyle: string;
  assetLibrary: AssetLibrary;
  isEndFrame: boolean;
  previousStartFramePath?: string;
  previousEndFramePath?: string;
  outputPath: string;
  videoBackend?: "veo" | "comfy";
}): Promise<string> {
  const {
    shot,
    artStyle,
    assetLibrary,
    isEndFrame,
    previousStartFramePath,
    previousEndFramePath,
    outputPath,
    videoBackend,
  } = params;

  // Build the prompt
  const framePrompt = isEndFrame ? shot.endFramePrompt : shot.startFramePrompt;
  const prompt = buildFramePrompt({
    artStyle,
    composition: shot.composition,
    locationDescription: shot.location,
    charactersPresent: shot.charactersPresent,
    framePrompt,
    cameraDirection: shot.cameraDirection,
  });

  // Collect reference image file paths.
  // Order: location > character > continuity (previous end frame as low-priority style ref).
  const referenceImagePaths: string[] = [];

  // Determine continuity reference path (previous end frame for start frames,
  // or this shot's start frame for end frames)
  let continuityRefPath: string | undefined;
  if (!isEndFrame && previousEndFramePath && fs.existsSync(previousEndFramePath)) {
    continuityRefPath = previousEndFramePath;
  } else if (isEndFrame && previousStartFramePath && fs.existsSync(previousStartFramePath)) {
    continuityRefPath = previousStartFramePath;
  }

  // Add location reference image if available
  const locationRef = assetLibrary.locationImages[shot.location];
  if (locationRef && fs.existsSync(locationRef)) {
    referenceImagePaths.push(locationRef);
  }

  // Add character reference images for all characters present
  for (const charName of shot.charactersPresent) {
    const charRefs = assetLibrary.characterImages[charName];
    if (charRefs) {
      const refPath = charRefs.front || charRefs.angle;
      if (refPath && fs.existsSync(refPath)) {
        referenceImagePaths.push(refPath);
      }
    }
  }

  // Add continuity ref LAST (low-priority style reference)
  if (continuityRefPath) {
    referenceImagePaths.push(continuityRefPath);
  }

  // Limit to max 6 reference images (Reve supports up to 6)
  const limitedReferencePaths = referenceImagePaths.slice(0, 6);

  if (limitedReferencePaths.length > 0) {
    // Build a set of character ref paths for labeling
    const characterRefPaths = new Map<string, string>(); // path -> character name
    for (const charName of shot.charactersPresent) {
      const charRefs = assetLibrary.characterImages[charName];
      if (charRefs) {
        const refPath = charRefs.front || charRefs.angle;
        if (refPath) characterRefPaths.set(refPath, charName);
      }
    }

    // Build <img> tag prefix to reference images by index
    const imgTagParts: string[] = [];
    for (let i = 0; i < limitedReferencePaths.length; i++) {
      const refPath = limitedReferencePaths[i];
      if (refPath === locationRef) {
        imgTagParts.push(`<img>${i}</img> location`);
      } else if (characterRefPaths.has(refPath)) {
        imgTagParts.push(`<img>${i}</img> ${characterRefPaths.get(refPath)} ref`);
      } else {
        imgTagParts.push(`<img>${i}</img> continuity (style only)`);
      }
    }
    const imgPrefix = `Using ${imgTagParts.join(", ")}: `;
    const remixPrompt = imgPrefix + prompt;
    if (remixPrompt.length > 2560) {
      console.warn(`[generateFrame] Shot ${shot.shotNumber}: Prompt is ${remixPrompt.length} chars (limit 2560). May be rejected by Reve.`);
    }

    return await remixImage(remixPrompt, limitedReferencePaths, {
      aspectRatio: getFrameAspectRatio(videoBackend),
      outputPath,
    });
  } else {
    // No reference images — use text-to-image generation
    if (prompt.length > 2560) {
      console.warn(`[generateFrame] Shot ${shot.shotNumber}: Prompt is ${prompt.length} chars (limit 2560). May be rejected by Reve.`);
    }
    return await createImage(prompt, {
      aspectRatio: getFrameAspectRatio(videoBackend),
      outputPath,
    });
  }
}

/**
 * Builds a detailed prompt for frame generation.
 */
function buildFramePrompt(params: {
  artStyle: string;
  composition: string;
  locationDescription: string;
  charactersPresent: string[];
  framePrompt: string;
  cameraDirection: string;
}): string {
  const { artStyle, composition, locationDescription, charactersPresent, framePrompt, cameraDirection } = params;

  const parts = [
    `Style: ${artStyle}.`,
    `${composition} shot, ${cameraDirection}.`,
    `Location: ${locationDescription}.`,
    charactersPresent.length > 0 ? `Characters: ${charactersPresent.join(", ")}. All characters must have original appearances — no celebrity likenesses.` : "",
    framePrompt,
  ].filter(Boolean);

  return parts.join(" ");
}

/**
 * Zod-based tool definition for Claude to call generateFrame.
 */
export const generateFrameTool = {
  description:
    "Generate start and end keyframe images for a shot using the Reve API.",
  parameters: z.object({
    shot: z.object({
      shotNumber: z.number(),
      sceneNumber: z.number(),
      shotInScene: z.number(),
      durationSeconds: z.number().min(0.5).max(10),
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
    }).describe("The shot to generate keyframes for"),
    artStyle: z.string().describe("The visual art style for the entire video"),
    assetLibrary: z.object({
      characterImages: z.record(z.string(), z.object({ front: z.string(), angle: z.string() })),
      locationImages: z.record(z.string(), z.string()),
    }).describe("AssetLibrary with character and location reference image paths"),
    outputDir: z.string().describe("Output directory for saving frame images"),
    dryRun: z
      .boolean()
      .optional()
      .describe("If true, return placeholder paths without calling API"),
    previousEndFramePath: z
      .string()
      .optional()
      .describe("Path to the previous shot's end frame image for cross-shot visual continuity"),
  }),
};

