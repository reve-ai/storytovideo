import * as fs from "fs";
import * as path from "path";
import { generateText } from "ai";
import { rateLimiters } from "./queue/rate-limiter-registry.js";
import { getLlmModel, getLlmProviderName } from "./llm-provider.js";

const API_BASE_URL = "https://api.reve.com/v1";
const MAX_RETRIES = 3;
const CONTENT_VIOLATION_MAX_RETRIES = 3;

function getApiKey(): string {
  const key = process.env.REVE_API_KEY;
  if (!key) {
    throw new Error("REVE_API_KEY environment variable is not set");
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

interface RateLimitError {
  error_code: string;
  params?: { retry_after?: string; requested_amount?: number; available_amount?: number };
}

/**
 * Revises a prompt using the LLM to avoid content filter violations.
 */
async function revisePromptForContentViolation(currentPrompt: string): Promise<string> {
  const limiter = rateLimiters.get(getLlmProviderName());
  await limiter.acquire();
  try {
    const { text } = await generateText({
      model: getLlmModel('fast'),
      prompt: `This image generation prompt was rejected by a content filter. Rewrite it to describe the same visual scene while avoiding anything that could trigger content moderation. Keep the same artistic intent, composition, and subject matter but use safer language. Return ONLY the revised prompt, nothing else.\n\nOriginal prompt:\n${currentPrompt}`,
      maxTokens: 1024,
    } as any);
    return text.trim();
  } finally {
    limiter.release();
  }
}

function truncatePrompt(prompt: string, maxLen = 200): string {
  return prompt.length > maxLen ? prompt.slice(0, maxLen) + "..." : prompt;
}

async function requestWithRetry(
  url: string,
  body: Record<string, unknown>,
  promptKey?: string
): Promise<ArrayBuffer> {
  const apiKey = getApiKey();
  const limiter = rateLimiters.get('reve');
  let attempt = 0;
  let contentViolationAttempts = 0;

  while (attempt < MAX_RETRIES) {
    await limiter.acquire();
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Accept": "image/png",
        },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        if (response.headers.get("X-Reve-Content-Violation")) {
          contentViolationAttempts++;
          // On first violation, dump all headers so we can discover the request ID header name
          if (contentViolationAttempts === 1) {
            console.warn("[reve] Content violation — response headers:", Object.fromEntries(response.headers.entries()));
          }
          const requestId = response.headers.get("x-request-id") ?? response.headers.get("x-reve-request-id") ?? "unknown";
          const currentPrompt = promptKey && typeof body[promptKey] === "string" ? body[promptKey] as string : undefined;

          if (contentViolationAttempts >= CONTENT_VIOLATION_MAX_RETRIES) {
            const truncated = currentPrompt ? truncatePrompt(currentPrompt) : "(no prompt)";
            throw new Error(`Reve API: content violation on all ${CONTENT_VIOLATION_MAX_RETRIES} attempts after LLM revision (request: ${requestId}), prompt: ${truncated} — prompt may need manual revision`);
          }

          // Use LLM to revise the prompt before retrying
          if (currentPrompt && promptKey) {
            console.warn(`[reve] Content violation on attempt ${contentViolationAttempts}/${CONTENT_VIOLATION_MAX_RETRIES} (request: ${requestId}). Original prompt: ${truncatePrompt(currentPrompt)}. Requesting LLM revision...`);
            const revisedPrompt = await revisePromptForContentViolation(currentPrompt);
            body[promptKey] = revisedPrompt;
            console.warn(`[reve] Revised prompt: ${truncatePrompt(revisedPrompt)}. Retrying...`);
          } else {
            console.warn(`[reve] Content violation on attempt ${contentViolationAttempts}/${CONTENT_VIOLATION_MAX_RETRIES} (request: ${requestId}), no prompt key to revise. Retrying...`);
          }
          attempt++;
          continue;
        }
        return response.arrayBuffer();
      }

      // Try to parse error body for rate-limit / budget errors
      let errorData: RateLimitError | null = null;
      try {
        errorData = (await response.json()) as RateLimitError;
      } catch {
        // non-JSON error body — fall through to generic throw
      }

      if (errorData?.error_code === "PARTNER_API_BUDGET_EXHAUSTED") {
        const params = errorData.params;
        let msg = "Reve API budget exhausted.";
        if (params?.requested_amount !== undefined && params?.available_amount !== undefined) {
          msg += ` Requested: ${params.requested_amount}, Available: ${params.available_amount}`;
        }
        throw new Error(msg);
      }

      if (
        errorData?.error_code === "PARTNER_API_TOKEN_RATE_LIMIT_EXCEEDED" &&
        attempt < MAX_RETRIES - 1
      ) {
        const retryAfter = errorData.params?.retry_after;
        let waitMs = 5000;
        if (retryAfter) {
          waitMs = Math.max(0, new Date(retryAfter).getTime() - Date.now()) + 1000;
        }
        console.warn(`[reve] 429 rate limited — backing off all reve workers for ${waitMs}ms`);
        limiter.backoff(waitMs);
        attempt++;
        continue;
      }

      throw new Error(
        `Reve API error ${response.status}: ${errorData ? JSON.stringify(errorData) : response.statusText}`
      );
    } finally {
      limiter.release();
    }
  }

  throw new Error("Reve API: max retries exceeded");
}

export async function createImage(
  prompt: string,
  options?: { aspectRatio?: string; version?: string; outputPath: string }
): Promise<string> {
  const outputPath = options?.outputPath ?? "output.png";
  const aspectRatio = options?.aspectRatio ?? "16:9";
  const version = options?.version ?? "latest";

  const imageBuffer = await requestWithRetry(`${API_BASE_URL}/image/create`, {
    prompt,
    aspect_ratio: aspectRatio,
    version,
  }, "prompt");

  ensureDir(outputPath);
  fs.writeFileSync(outputPath, Buffer.from(imageBuffer));
  return outputPath;
}

export async function editImage(
  referenceImagePath: string,
  editInstruction: string,
  options?: { version?: string; outputPath: string }
): Promise<string> {
  const outputPath = options?.outputPath ?? "output.png";
  const version = options?.version ?? "latest";
  const imageBase64 = loadImageAsBase64(referenceImagePath);

  const imageBuffer = await requestWithRetry(`${API_BASE_URL}/image/edit`, {
    reference_image: imageBase64,
    edit_instruction: editInstruction,
    version,
  }, "edit_instruction");

  ensureDir(outputPath);
  fs.writeFileSync(outputPath, Buffer.from(imageBuffer));
  return outputPath;
}

export async function remixImage(
  prompt: string,
  referenceImagePaths: string[],
  options?: { aspectRatio?: string; outputPath: string }
): Promise<string> {
  if (referenceImagePaths.length < 1 || referenceImagePaths.length > 6) {
    throw new Error("remixImage requires 1-6 reference images");
  }

  const outputPath = options?.outputPath ?? "output.png";
  const aspectRatio = options?.aspectRatio ?? "16:9";
  const referenceImages = referenceImagePaths.map(loadImageAsBase64);

  const imageBuffer = await requestWithRetry(`${API_BASE_URL}/image/remix`, {
    prompt,
    reference_images: referenceImages,
    aspect_ratio: aspectRatio,
  }, "prompt");

  ensureDir(outputPath);
  fs.writeFileSync(outputPath, Buffer.from(imageBuffer));
  return outputPath;
}

