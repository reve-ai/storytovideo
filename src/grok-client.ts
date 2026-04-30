import * as fs from "fs";
import * as path from "path";
import { mkdir } from "fs/promises";
import { rateLimiters } from "./queue/rate-limiter-registry.js";

const API_BASE = "https://api.x.ai/v1";
const MODEL = "grok-imagine-video";
const MAX_RETRIES = 5;
const POLL_INTERVAL_MS = 10_000;

function getApiKey(): string {
  const key = process.env.XAI_API_KEY;
  if (!key) throw new Error("XAI_API_KEY environment variable is not set");
  return key;
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export type GrokVideoOptions = {
  image?: string | { url: string };
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
  outputPath: string;
  abortSignal?: AbortSignal;
};

export type GrokVideoExtensionOptions = {
  /** Source video to extend, as a public URL or a base64 data URL
   *  (`data:video/mp4;base64,...`). The Grok API accepts either; this
   *  client always passes a data URL today. */
  video: string | { url: string };
  /** Extension segment length in seconds (Grok accepts 1–10). Defaults
   *  to 6 server-side if omitted. */
  duration?: number;
  outputPath: string;
  abortSignal?: AbortSignal;
};

export type GrokVideoResult = {
  url: string;
  duration: number;
  path: string;
};

type GenerationResponse = { request_id: string };

type PollResponse = {
  status: "pending" | "done" | "expired" | "failed";
  video?: { url: string; duration: number };
  model?: string;
  error?: string;
};

async function apiRequest<T>(
  method: "GET" | "POST",
  endpoint: string,
  body?: Record<string, unknown>,
  abortSignal?: AbortSignal,
): Promise<T> {
  const limiter = rateLimiters.get('grok-video');
  await limiter.acquire();
  try {
    const url = `${API_BASE}${endpoint}`;
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: abortSignal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      const err = Object.assign(
        new Error(`Grok API error ${response.status}: ${text}`),
        { status: response.status },
      );
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        const retryMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
        console.warn(`[grok] 429 rate limited — backing off all grok-video workers for ${retryMs}ms`);
        limiter.backoff(retryMs);
      }
      throw err;
    }
    return (await response.json()) as T;
  } finally {
    limiter.release();
  }
}

async function submitGeneration(
  prompt: string,
  options: GrokVideoOptions,
  abortSignal?: AbortSignal,
): Promise<string> {
  const body: Record<string, unknown> = { model: MODEL, prompt };
  if (options.image) {
    body.image = typeof options.image === "string" ? { url: options.image } : options.image;
  }
  if (options.duration !== undefined) body.duration = Math.max(2, Math.round(options.duration));
  if (options.aspectRatio) body.aspect_ratio = options.aspectRatio;
  if (options.resolution) body.resolution = options.resolution;
  const resp = await apiRequest<GenerationResponse>("POST", "/videos/generations", body, abortSignal);
  return resp.request_id;
}

async function submitExtension(
  prompt: string,
  options: GrokVideoExtensionOptions,
  abortSignal?: AbortSignal,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: MODEL,
    prompt,
    video: typeof options.video === "string" ? { url: options.video } : options.video,
  };
  if (options.duration !== undefined) body.duration = Math.max(1, Math.min(10, Math.round(options.duration)));
  const resp = await apiRequest<GenerationResponse>("POST", "/videos/extensions", body, abortSignal);
  return resp.request_id;
}

async function pollUntilDone(requestId: string, abortSignal?: AbortSignal): Promise<PollResponse> {
  while (true) {
    if (abortSignal?.aborted) {
      throw new Error("Video generation cancelled due to pipeline interruption");
    }
    const resp = await apiRequest<PollResponse>("GET", `/videos/${requestId}`, undefined, abortSignal);
    if (resp.status === "done" || resp.status === "expired" || resp.status === "failed") {
      return resp;
    }
    console.log(`[grok] ${requestId}: status=${resp.status}, polling in ${POLL_INTERVAL_MS / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function downloadVideo(videoUrl: string, outputPath: string, abortSignal?: AbortSignal): Promise<void> {
  const response = await fetch(videoUrl, { signal: abortSignal });
  if (!response.ok) {
    throw new Error(`Failed to download video: ${response.status} ${response.statusText}`);
  }
  ensureDir(outputPath);
  fs.writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));
}

/**
 * Generate a video using the Grok Imagine Video API.
 * Handles submission, async polling, download, and retry with exponential backoff.
 */
export async function generateVideoGrok(
  prompt: string,
  options: GrokVideoOptions,
): Promise<GrokVideoResult> {
  const { outputPath, abortSignal } = options;
  await mkdir(path.dirname(outputPath), { recursive: true });

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (abortSignal?.aborted) {
        throw new Error("Video generation cancelled due to pipeline interruption");
      }
      console.log(`[grok] Submitting generation (attempt ${attempt}/${MAX_RETRIES})`);
      const requestId = await submitGeneration(prompt, options, abortSignal);
      console.log(`[grok] Request submitted: ${requestId}`);

      const result = await pollUntilDone(requestId, abortSignal);
      if (result.status === "failed") {
        throw new Error(`Grok video generation failed: ${result.error ?? "unknown error"}`);
      }
      if (result.status === "expired") {
        throw new Error("Grok video generation request expired");
      }
      if (!result.video?.url) {
        throw new Error("Grok video generation completed but no video URL returned");
      }

      console.log(`[grok] Downloading video (${result.video.duration}s) to ${outputPath}`);
      await downloadVideo(result.video.url, outputPath, abortSignal);
      console.log(`[grok] Video saved to ${outputPath}`);
      return { url: result.video.url, duration: result.video.duration, path: outputPath };
    } catch (error: unknown) {
      lastError = error;
      const err = error as { message?: string; status?: number };
      if (err.message?.includes("cancelled due to pipeline interruption") || abortSignal?.aborted) {
        throw error;
      }
      const isContentModeration = err.status === 400 && err.message?.includes("content moderation");
      const isRetryable = err.status === 429 || (err.status !== undefined && err.status >= 500) || isContentModeration;
      if (isRetryable && attempt < MAX_RETRIES) {
        if (isContentModeration) {
          console.warn("[grok] Content moderation rejection, retrying...");
        }
        const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 60_000);
        console.warn(`[grok] Retryable error (${err.status}), backoff ${backoffMs / 1000}s (retry ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      if (attempt >= MAX_RETRIES) {
        console.error(`[grok] All ${MAX_RETRIES} retries exhausted`);
      }
      throw error;
    }
  }
  throw lastError;
}

/**
 * Extend an existing video using the Grok Imagine Video API.
 * Same async-poll + retry plumbing as `generateVideoGrok`; only the submit
 * endpoint and request body shape differ. The source video is encoded as a
 * `data:video/mp4;base64,...` URL by the caller.
 */
export async function extendVideoGrok(
  prompt: string,
  options: GrokVideoExtensionOptions,
): Promise<GrokVideoResult> {
  const { outputPath, abortSignal } = options;
  await mkdir(path.dirname(outputPath), { recursive: true });

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (abortSignal?.aborted) {
        throw new Error("Video generation cancelled due to pipeline interruption");
      }
      console.log(`[grok] Submitting extension (attempt ${attempt}/${MAX_RETRIES})`);
      const requestId = await submitExtension(prompt, options, abortSignal);
      console.log(`[grok] Extension request submitted: ${requestId}`);

      const result = await pollUntilDone(requestId, abortSignal);
      if (result.status === "failed") {
        throw new Error(`Grok video extension failed: ${result.error ?? "unknown error"}`);
      }
      if (result.status === "expired") {
        throw new Error("Grok video extension request expired");
      }
      if (!result.video?.url) {
        throw new Error("Grok video extension completed but no video URL returned");
      }

      console.log(`[grok] Downloading extended video (${result.video.duration}s) to ${outputPath}`);
      await downloadVideo(result.video.url, outputPath, abortSignal);
      console.log(`[grok] Extended video saved to ${outputPath}`);
      return { url: result.video.url, duration: result.video.duration, path: outputPath };
    } catch (error: unknown) {
      lastError = error;
      const err = error as { message?: string; status?: number };
      if (err.message?.includes("cancelled due to pipeline interruption") || abortSignal?.aborted) {
        throw error;
      }
      const isContentModeration = err.status === 400 && err.message?.includes("content moderation");
      const isRetryable = err.status === 429 || (err.status !== undefined && err.status >= 500) || isContentModeration;
      if (isRetryable && attempt < MAX_RETRIES) {
        if (isContentModeration) {
          console.warn("[grok] Content moderation rejection on extension, retrying...");
        }
        const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 60_000);
        console.warn(`[grok] Retryable error (${err.status}), backoff ${backoffMs / 1000}s (retry ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      if (attempt >= MAX_RETRIES) {
        console.error(`[grok] All ${MAX_RETRIES} extension retries exhausted`);
      }
      throw error;
    }
  }
  throw lastError;
}
