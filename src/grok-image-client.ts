import * as fs from "fs";
import * as path from "path";

const API_BASE_URL = "https://api.x.ai/v1";
const MAX_RETRIES = 3;

function getApiKey(): string {
  const key = process.env.XAI_API_KEY;
  if (!key) {
    throw new Error("XAI_API_KEY environment variable is not set");
  }
  return key;
}

function loadImageAsBase64(imagePath: string): string {
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image file not found: ${imagePath}`);
  }
  return fs.readFileSync(imagePath).toString("base64");
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
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
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
      console.log(`[grok-image] Rate limited, waiting ${Math.ceil(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      attempt++;
      continue;
    }

    const errorText = await response.text();
    throw new Error(`Grok image API error ${response.status}: ${errorText}`);
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

  const images = referenceImagePaths.map((p) => ({
    type: "image_url",
    url: `data:image/png;base64,${loadImageAsBase64(p)}`,
  }));

  const body: Record<string, unknown> = {
    model: "grok-imagine-image",
    prompt,
    response_format: "b64_json",
    aspect_ratio: aspectRatio,
  };

  // Single image uses "image", multiple uses "images"
  if (images.length === 1) {
    body.image = images[0];
  } else {
    body.images = images;
  }

  const data = await requestWithRetry(`${API_BASE_URL}/images/edits`, body);

  const imageBuffer = Buffer.from(data.data[0].b64_json, "base64");
  ensureDir(outputPath);
  fs.writeFileSync(outputPath, imageBuffer);
  console.log(`[grok-image] Generated edited image: ${outputPath}`);
  return outputPath;
}

