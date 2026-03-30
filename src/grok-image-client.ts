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

const MAX_REF_LONG_EDGE = 1024;
const MAX_TOTAL_BASE64_BYTES = 15 * 1024 * 1024; // 15 MB

/**
 * Pad an image to match a target aspect ratio by adding black letterbox/pillarbox bars,
 * then cap the long edge at MAX_REF_LONG_EDGE to keep payload size down.
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

  let padWidth: number, padHeight: number;
  if (Math.abs(srcRatio - targetRatio) < 0.05) {
    padWidth = srcWidth;
    padHeight = srcHeight;
  } else if (srcRatio > targetRatio) {
    padWidth = srcWidth;
    padHeight = Math.round(srcWidth / targetRatio);
  } else {
    padHeight = srcHeight;
    padWidth = Math.round(srcHeight * targetRatio);
  }

  // Cap the long edge at MAX_REF_LONG_EDGE
  const longEdge = Math.max(padWidth, padHeight);
  let finalWidth = padWidth;
  let finalHeight = padHeight;
  if (longEdge > MAX_REF_LONG_EDGE) {
    const scale = MAX_REF_LONG_EDGE / longEdge;
    finalWidth = Math.round(padWidth * scale);
    finalHeight = Math.round(padHeight * scale);
  }

  return sharp(imagePath)
    .resize(finalWidth, finalHeight, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    })
    .jpeg({ quality: 85 })
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
    resolution: "2k",
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

  // Pad + resize reference images to target aspect ratio and cap size.
  const images: { type: string; url: string }[] = [];
  let totalBase64Bytes = 0;
  for (const p of referenceImagePaths) {
    const paddedBuffer = await padImageToAspectRatio(p, aspectRatio);
    const b64 = paddedBuffer.toString("base64");
    totalBase64Bytes += b64.length;

    // If adding this image would exceed the payload cap, drop it (lowest priority = last)
    if (images.length > 0 && totalBase64Bytes > MAX_TOTAL_BASE64_BYTES) {
      console.warn(`[grok-image] Dropping reference ${images.length + 1}/${referenceImagePaths.length} — total base64 would exceed ${Math.round(MAX_TOTAL_BASE64_BYTES / 1024 / 1024)}MB cap`);
      break;
    }

    images.push({
      type: "image_url",
      url: `data:image/jpeg;base64,${b64}`,
    });
  }

  const body: Record<string, unknown> = {
    model: "grok-imagine-image",
    prompt,
    response_format: "b64_json",
    aspect_ratio: aspectRatio,
    resolution: "2k",
  };

  body.images = images;

  console.log(`[grok-image] Editing with ${images.length} reference(s), aspect_ratio=${aspectRatio}, payload ~${Math.round(totalBase64Bytes / 1024)}KB`);
  const data = await requestWithRetry(`${API_BASE_URL}/images/edits`, body);

  const imageBuffer = Buffer.from(data.data[0].b64_json, "base64");
  ensureDir(outputPath);
  fs.writeFileSync(outputPath, imageBuffer);
  console.log(`[grok-image] Generated edited image: ${outputPath}`);
  return outputPath;
}

