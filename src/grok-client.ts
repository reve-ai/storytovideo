import * as fs from "fs";
import * as path from "path";
import { mkdir } from "fs/promises";

const API_BASE = "https://api.x.ai/v1";
const MODEL = "grok-imagine-video";
const MAX_RETRIES = 5;
const POLL_INTERVAL_MS = 10_000;

// Rate-limit tracking: 1 RPS / 60 RPM
let lastCallTimestamp = 0;
const MIN_CALL_INTERVAL_MS = 1_000;

function getApiKey(): string {
  const key = process.env.XAI_API_KEY;
  if (!key) throw new Error("XAI_API_KEY environment variable is not set");
  return key;
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function enforceRateLimit(): Promise<void> {
  const elapsed = Date.now() - lastCallTimestamp;
  if (elapsed < MIN_CALL_INTERVAL_MS) {
    const waitMs = MIN_CALL_INTERVAL_MS - elapsed;
    console.log(`[grok] Rate limit: waiting ${waitMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastCallTimestamp = Date.now();
}

export type GrokVideoOptions = {
  image?: string | { url: string };
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
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
  await enforceRateLimit();
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
    throw Object.assign(
      new Error(`Grok API error ${response.status}: ${text}`),
      { status: response.status },
    );
  }
  return (await response.json()) as T;
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
      const isRetryable = err.status === 429 || (err.status !== undefined && err.status >= 500);
      if (isRetryable && attempt < MAX_RETRIES) {
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
