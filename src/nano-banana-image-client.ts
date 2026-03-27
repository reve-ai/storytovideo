import { Modality, type Part } from "@google/genai";
import * as fs from "fs";
import * as path from "path";
import { getGoogleClient } from "./google-client";
import { rateLimiters } from "./queue/rate-limiter-registry.js";

const MODEL = "gemini-3.1-flash-image-preview";
const MAX_RETRIES = 3;

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getMimeType(imagePath: string): string {
  const ext = path.extname(imagePath).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

function createInlineImagePart(imagePath: string): Part {
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image file not found: ${imagePath}`);
  }

  return {
    inlineData: {
      mimeType: getMimeType(imagePath),
      data: fs.readFileSync(imagePath).toString("base64"),
    },
  };
}

function extractImageData(response: Awaited<ReturnType<ReturnType<typeof getGoogleClient>["models"]["generateContent"]>>): { data: string; mimeType: string } {
  for (const candidate of response.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.inlineData?.data) {
        return {
          data: part.inlineData.data,
          mimeType: part.inlineData.mimeType ?? "image/png",
        };
      }
    }
  }

  throw new Error("Nano Banana did not return any image data");
}

async function generateImage(parts: Part[], aspectRatio: string): Promise<{ data: string; mimeType: string }> {
  const client = getGoogleClient();
  const limiter = rateLimiters.get("nano-banana");

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await limiter.acquire();
    try {
      const response = await client.models.generateContent({
        model: MODEL,
        contents: [{ role: "user", parts }],
        config: {
          responseModalities: [Modality.IMAGE],
          imageConfig: {
            aspectRatio,
          },
        },
      });

      return extractImageData(response);
    } catch (error: any) {
      const isRateLimited = error?.status === 429
        || error?.message?.includes("429")
        || error?.message?.includes("RESOURCE_EXHAUSTED");

      if (isRateLimited && attempt < MAX_RETRIES) {
        const retryMs = 5000;
        console.warn(`[nano-banana] 429 rate limited — backing off all nano-banana workers for ${retryMs}ms`);
        limiter.backoff(retryMs);
        continue;
      }

      throw error;
    } finally {
      limiter.release();
    }
  }

  throw new Error("Nano Banana image generation: max retries exceeded");
}

export async function createImageNanoBanana(
  prompt: string,
  options?: { aspectRatio?: string; outputPath: string }
): Promise<string> {
  const outputPath = options?.outputPath ?? "output.png";
  const aspectRatio = options?.aspectRatio ?? "16:9";

  const image = await generateImage([{ text: prompt }], aspectRatio);
  ensureDir(outputPath);
  fs.writeFileSync(outputPath, Buffer.from(image.data, "base64"));
  console.log(`[nano-banana] Generated image: ${outputPath} (${image.mimeType})`);
  return outputPath;
}

export async function remixImageNanoBanana(
  prompt: string,
  referenceImagePaths: string[],
  options?: { aspectRatio?: string; outputPath: string }
): Promise<string> {
  if (referenceImagePaths.length < 1) {
    throw new Error("Nano Banana remix requires at least 1 reference image");
  }

  const outputPath = options?.outputPath ?? "output.png";
  const aspectRatio = options?.aspectRatio ?? "16:9";
  const parts: Part[] = [
    ...referenceImagePaths.map(createInlineImagePart),
    { text: prompt },
  ];

  const image = await generateImage(parts, aspectRatio);
  ensureDir(outputPath);
  fs.writeFileSync(outputPath, Buffer.from(image.data, "base64"));
  console.log(`[nano-banana] Generated remixed image: ${outputPath} (${image.mimeType})`);
  return outputPath;
}