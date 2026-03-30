import { z } from "zod";
import { createImage, remixImage } from "../reve-client";
import { createImageGrok, remixImageGrok } from "../grok-image-client";
import { createImageNanoBanana, remixImageNanoBanana } from "../nano-banana-image-client";
import type { ImageBackend, VideoBackend } from "../types";
import * as fs from "fs";
import * as path from "path";

type LegacyImageBackend = VideoBackend | "comfy";

function resolveImageBackend(imageBackend?: ImageBackend, videoBackend?: LegacyImageBackend): ImageBackend {
  if (imageBackend) {
    return imageBackend;
  }

  return videoBackend === "grok" ? "grok" : "reve";
}

export function buildAssetPrompt(params: {
  assetType: "character" | "location" | "object";
  description: string;
  artStyle: string;
  isEditing: boolean;
}): string {
  const { assetType, description, artStyle, isEditing } = params;

  if (isEditing) {
    if (assetType === "character") {
      return `Edit this image to show the same character from a different angle/perspective. Keep their exact appearance, clothing, facial features, body proportions, and color palette identical. Only change the viewing angle to a 3/4 perspective. The character must have a completely original appearance (NOT resembling any real celebrity or public figure). Character details: ${description}`;
    }

    return `Edit this image to show the same location from a different vantage point. Keep the exact same architecture, lighting, color palette, and atmosphere. Location details: ${description}`;
  }

  let prompt = `Generate a ${artStyle} style reference image of `;
  if (assetType === "character") {
    prompt += `a character with a completely original appearance (NOT resembling any real celebrity or public figure): ${description}`;
  } else if (assetType === "object") {
    prompt += `an object/product: ${description}. Show the object clearly against a neutral background for reference.`;
  } else {
    prompt += `a location: ${description}`;
  }

  return prompt;
}

/**
 * Generates reference images for characters and locations using the Reve API.
 * Returns file path for the generated image.
 */
export async function generateAsset(params: {
  characterName?: string;
  locationName?: string;
  objectName?: string;
  description: string;
  artStyle: string;
  outputDir: string;
  dryRun?: boolean;
  referenceImagePath?: string;
  imageBackend?: ImageBackend;
  videoBackend?: LegacyImageBackend;
  aspectRatio?: string;
  version?: number;
}): Promise<{ key: string; path: string; finalPrompt: string }> {
  const {
    characterName,
    locationName,
    objectName,
    description,
    artStyle,
    outputDir,
    dryRun = false,
    referenceImagePath,
    version = 1,
  } = params;

  // Determine asset type and key
  let assetType: "character" | "location" | "object";
  let assetName: string;
  let angleType: "front" | "angle" = "front";

  if (characterName) {
    assetType = "character";
    assetName = characterName;
    // If reference image provided, this is an angle shot
    if (referenceImagePath) {
      angleType = "angle";
    }
  } else if (locationName) {
    assetType = "location";
    assetName = locationName;
  } else if (objectName) {
    assetType = "object";
    assetName = objectName;
  } else {
    throw new Error("Either characterName, locationName, or objectName must be provided");
  }

  const key = `${assetType}:${assetName}:${angleType}`;

  // Build the prompt
  const isEditing = Boolean(referenceImagePath && fs.existsSync(referenceImagePath));
  const prompt = buildAssetPrompt({
    assetType,
    description,
    artStyle,
    isEditing,
  });
  const imageBackend = resolveImageBackend(params.imageBackend, params.videoBackend);

  // Dry-run mode: return placeholder path
  if (dryRun) {
    const placeholder = `[dry-run] assets/${assetType}s/${assetName}_${angleType}.png`;
    return { key, path: placeholder, finalPrompt: prompt };
  }

  // Log the operation
  if (isEditing) {
    console.log(`[generateAsset] Editing reference image for ${assetType}: ${assetName} (${angleType})`);
  } else {
    console.log(`[generateAsset] Generating new ${assetType}: ${assetName}`);
  }

  // Call the selected image API with retry logic
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Ensure output directory exists
      const assetDir = path.join(outputDir, "assets", `${assetType}s`);
      fs.mkdirSync(assetDir, { recursive: true });

      // Save image
      const filename = `${assetName.toLowerCase()}_${angleType}_v${version}.png`;
      const filePath = path.join(assetDir, filename);
      // Characters and objects use 1:1 (reference images); locations use the run's aspect ratio
      const assetAspectRatio = (assetType === "character" || assetType === "object") ? "1:1" : (params.aspectRatio ?? "16:9");

      let resultPath: string;
      if (isEditing) {
        switch (imageBackend) {
          case "grok":
            resultPath = await remixImageGrok(prompt, [referenceImagePath!], {
              aspectRatio: assetAspectRatio,
              outputPath: filePath,
            });
            break;
          case "nano-banana":
            resultPath = await remixImageNanoBanana(prompt, [referenceImagePath!], {
              aspectRatio: assetAspectRatio,
              outputPath: filePath,
            });
            break;
          case "reve":
            resultPath = await remixImage(prompt, [referenceImagePath!], {
              aspectRatio: assetAspectRatio,
              outputPath: filePath,
            });
            break;
        }
      } else {
        switch (imageBackend) {
          case "grok":
            resultPath = await createImageGrok(prompt, {
              aspectRatio: assetAspectRatio,
              outputPath: filePath,
            });
            break;
          case "nano-banana":
            resultPath = await createImageNanoBanana(prompt, {
              aspectRatio: assetAspectRatio,
              outputPath: filePath,
            });
            break;
          case "reve":
            resultPath = await createImage(prompt, {
              aspectRatio: assetAspectRatio,
              outputPath: filePath,
            });
            break;
        }
      }

      return { key, path: resultPath, finalPrompt: prompt };
    } catch (error) {
      lastError = error as Error;
      // Don't retry if cancelled due to pipeline interruption
      if ((error as Error)?.message?.includes('cancelled due to pipeline interruption')) {
        throw error;
      }
      if (attempt < 3) {
        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  throw new Error(
    `Failed to generate asset after 3 attempts: ${lastError?.message}`
  );
}

/**
 * Vercel AI SDK tool definition for generateAsset.
 * Claude calls this to generate character and location reference images.
 * When a referenceImagePath is provided, uses image editing to create variations
 * while maintaining exact consistency with the reference image.
 */
export const generateAssetTool = {
  description:
    "Generate reference images for characters, locations, and objects using the configured image backend. When referenceImagePath is provided, remix the reference image to create variations while maintaining consistency.",
  parameters: z.object({
    characterName: z.string().optional(),
    locationName: z.string().optional(),
    objectName: z.string().optional(),
    description: z.string(),
    artStyle: z.string(),
    outputDir: z.string(),
    dryRun: z.boolean().optional(),
    referenceImagePath: z.string().optional(),
  }),
};

