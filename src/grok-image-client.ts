import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { rateLimiters } from "./queue/rate-limiter-registry.js";

const API_BASE_URL = "https://api.x.ai/v1";
const MAX_RETRIES = 3;

function getApiKey(): string {
  const key = process.env.XAI_API_KEY;
  if (!key) {
    throw new Error("XAI_API_KEY environment variable is not set");
  }
  return key;
}

/**
 * Pad an image to match a target aspect ratio by adding black letterbox/pillarbox bars.
 * This works around the Grok /images/edits API ignoring the aspect_ratio parameter
 * when editing with reference images — the output always matches the input's aspect ratio.
 */
async function padImageToAspectRatio(imagePath: string, targetAspectRatio: string): Promise<Buffer> {
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image file not found: ${imagePath}`);
  }

  const metadata = await sharp(imagePath).metadata();
  const srcWidth = metadata.width!;
  const srcHeight = metadata.height!;

  const [arW, arH] = targetAspectRatio.split(":").map(Number);
  const targetRatio = arW / arH;
  const srcRatio = srcWidth / srcHeight;

  // If already correct ratio (within tolerance), just return original
  if (Math.abs(srcRatio - targetRatio) < 0.05) {
    return fs.readFileSync(imagePath);
  }

  let newWidth: number, newHeight: number;
  if (srcRatio > targetRatio) {
    // Image is wider than target — add height (letterbox)
    newWidth = srcWidth;
    newHeight = Math.round(srcWidth / targetRatio);
  } else {
    // Image is taller than target — add width (pillarbox)
    newHeight = srcHeight;
    newWidth = Math.round(srcHeight * targetRatio);
  }

  return sharp(imagePath)
    .resize(newWidth, newHeight, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    })
    .png()
    .toBuffer();
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function requestWithRetry(
  url: string,
  body: Record<string, unknown>
): Promise<{ data: Array<{ b64_json: string }> }> {
  const apiKey = getApiKey();
  const limiter = rateLimiters.get('grok-image');
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    await limiter.acquire();
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        return response.json() as Promise<{ data: Array<{ b64_json: string }> }>;
      }

      // Check for rate limiting (429)
      if (response.status === 429 && attempt < MAX_RETRIES - 1) {
        const retryAfter = response.headers.get("retry-after");
        let waitMs = 5000;
        if (retryAfter) {
          const seconds = parseInt(retryAfter, 10);
          waitMs = (isNaN(seconds) ? 5 : seconds) * 1000 + 1000;
        }
        console.warn(`[grok-image] 429 rate limited — backing off all grok-image workers for ${waitMs}ms`);
        limiter.backoff(waitMs);
        attempt++;
        continue;
      }

      const errorText = await response.text();
      throw new Error(`Grok image API error ${response.status}: ${errorText}`);
    } finally {
      limiter.release();
    }
  }

  throw new Error("Grok image API: max retries exceeded");
}

/** Text-to-image generation via Grok's grok-imagine-image model. */
export async function createImageGrok(
  prompt: string,
  options?: { aspectRatio?: string; outputPath: string }
): Promise<string> {
  const outputPath = options?.outputPath ?? "output.png";
  const aspectRatio = options?.aspectRatio ?? "16:9";

  const data = await requestWithRetry(`${API_BASE_URL}/images/generations`, {
    model: "grok-imagine-image",
    prompt,
    response_format: "b64_json",
    aspect_ratio: aspectRatio,
  });

  const imageBuffer = Buffer.from(data.data[0].b64_json, "base64");
  ensureDir(outputPath);
  fs.writeFileSync(outputPath, imageBuffer);
  console.log(`[grok-image] Generated image: ${outputPath}`);
  return outputPath;
}

/** Image editing with reference images (1-5) via Grok's grok-imagine-image model. */
export async function remixImageGrok(
  prompt: string,
  referenceImagePaths: string[],
  options?: { aspectRatio?: string; outputPath: string }
): Promise<string> {
  if (referenceImagePaths.length < 1 || referenceImagePaths.length > 5) {
    throw new Error("Grok image edit supports 1-5 reference images");
  }

  const outputPath = options?.outputPath ?? "output.png";
  const aspectRatio = options?.aspectRatio ?? "16:9";

  // Pad reference images to target aspect ratio so the API outputs the correct ratio.
  // The /images/edits endpoint ignores aspect_ratio and matches the input image instead.
  const images = [];
  for (const p of referenceImagePaths) {
    const paddedBuffer = await padImageToAspectRatio(p, aspectRatio);
    const b64 = paddedBuffer.toString("base64");
    images.push({
      type: "image_url",
      url: `data:image/png;base64,${b64}`,
    });
  }

  const body: Record<string, unknown> = {
    model: "grok-imagine-image",
    prompt,
    response_format: "b64_json",
    aspect_ratio: aspectRatio,
  };

  // Always use "images" array — the "image" (singular) field ignores aspect_ratio
  body.images = images;

  console.log(`[grok-image] Editing with ${images.length} reference(s), aspect_ratio=${aspectRatio}`);
  const data = await requestWithRetry(`${API_BASE_URL}/images/edits`, body);

  const imageBuffer = Buffer.from(data.data[0].b64_json, "base64");
  ensureDir(outputPath);
  fs.writeFileSync(outputPath, imageBuffer);
  console.log(`[grok-image] Generated edited image: ${outputPath}`);
  return outputPath;
}

