import { z } from "zod";
import { createImage, remixImage } from "../reve-client";
import { createImageGrok, remixImageGrok } from "../grok-image-client";
import { createImageNanoBanana, remixImageNanoBanana } from "../nano-banana-image-client";
import type { ImageBackend, VideoBackend } from "../types";
import * as fs from "fs";
import * as path from "path";
import {
  ASSET_EDIT_PROMPT_PREFIX,
  CHARACTER_ASSET_PROMPT_TEMPLATE,
  OBJECT_ASSET_PROMPT_TEMPLATE,
  OBJECT_ASSET_PROMPT_SUFFIX,
  LOCATION_ASSET_PROMPT_PREFIX,
} from "../prompts.js";

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
    return `${ASSET_EDIT_PROMPT_PREFIX}${description}`;
  }

  let prompt: string;
  if (assetType === "character") {
    prompt = `Art style: ${artStyle}. A ${CHARACTER_ASSET_PROMPT_TEMPLATE}${description}`;
  } else if (assetType === "object") {
    prompt = `Art style: ${artStyle}. An ${OBJECT_ASSET_PROMPT_TEMPLATE}${description}${OBJECT_ASSET_PROMPT_SUFFIX}`;
  } else {
    prompt = `Art style: ${artStyle}. A ${LOCATION_ASSET_PROMPT_PREFIX}${description}`;
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
  const angleType = "front";

  if (characterName) {
    assetType = "character";
    assetName = characterName;
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
    console.log(`[generateAsset] Generating new ${assetType}: ${assetName}\n  Prompt: ${prompt}`);
  }

  // Call the selected image API with retry logic
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Ensure output directory exists
      const assetDir = path.join(outputDir, `${assetType}s`);
      fs.mkdirSync(assetDir, { recursive: true });

      // Save image
      const sanitizedName = assetName.toLowerCase().replace(/\//g, '-').replace(/\s+/g, ' ').trim();
      const filename = `${sanitizedName}_${angleType}_v${version}.png`;
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

