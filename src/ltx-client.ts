import * as fs from "fs";
import * as path from "path";
import { mkdir } from "fs/promises";
import { rateLimiters } from "./queue/rate-limiter-registry.js";

const API_BASE = process.env.LTX_API_BASE || "http://api.revemovies.com:8080";
const MAX_RETRIES = 5;
const POLL_INTERVAL_MS = 10_000;

function getApiKey(): string {
  const key = process.env.LTX_API_KEY;
  if (!key) throw new Error("LTX_API_KEY environment variable is not set");
  return key;
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export type LtxProgressInfo = {
  status: "pending" | "running";
  progress?: number;       // 0.0–1.0
  step?: number;
  totalSteps?: number;
  queuePosition?: number;
};

export type LtxVideoOptions = {
  image?: string;          // path to input image for image-to-video
  duration?: number;       // seconds (default 5)
  width?: number;
  height?: number;
  mode?: "full" | "distilled";
  priority?: "normal" | "high";
  seed?: number;
  frameRate?: number;
  outputPath: string;
  abortSignal?: AbortSignal;
  onProgress?: (info: LtxProgressInfo) => void;
};

export type LtxVideoResult = {
  jobId: string;
  duration: number;
  path: string;
};

type GenerateResponse = {
  job_id: string;
  status: string;
  queue_position: number;
  params: {
    mode: string;
    width: number;
    height: number;
    num_frames: number;
    seconds: number;
    frame_rate: number;
    has_image: boolean;
  };
};

type StatusResponse = {
  job_id: string;
  status: "pending" | "running" | "completed" | "failed";
  created_at?: number;
  started_at?: number;
  completed_at?: number;
  generation_time?: number;
  progress?: number;         // 0.0–1.0 fraction complete (running jobs)
  step?: number;             // current diffusion step
  total_steps?: number;      // total diffusion steps
  params?: string;
  video_url?: string;
  error?: string;
};

async function submitGeneration(
  prompt: string,
  options: LtxVideoOptions,
  abortSignal?: AbortSignal,
): Promise<GenerateResponse> {
  const limiter = rateLimiters.get("ltx");
  await limiter.acquire();
  try {
    const apiKey = getApiKey();

    if (options.image) {
      const form = new FormData();
      form.append("prompt", prompt);
      const imageBuffer = fs.readFileSync(options.image);
      const ext = path.extname(options.image).toLowerCase();
      const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
      form.append("image", new Blob([imageBuffer], { type: mimeType }), path.basename(options.image));
      if (options.mode) form.append("mode", options.mode);
      if (options.duration !== undefined) form.append("seconds", String(options.duration));
      if (options.width !== undefined) form.append("width", String(options.width));
      if (options.height !== undefined) form.append("height", String(options.height));
      if (options.priority) form.append("priority", options.priority);
      if (options.seed !== undefined) form.append("seed", String(options.seed));
      if (options.frameRate !== undefined) form.append("frame_rate", String(options.frameRate));

      const response = await fetch(`${API_BASE}/generate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: abortSignal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        throw Object.assign(new Error(`LTX API error ${response.status}: ${text}`), { status: response.status });
      }
      return (await response.json()) as GenerateResponse;
    }

    // JSON body for text-to-video
    const body: Record<string, unknown> = { prompt };
    if (options.mode) body.mode = options.mode;
    if (options.duration !== undefined) body.seconds = options.duration;
    if (options.width !== undefined) body.width = options.width;
    if (options.height !== undefined) body.height = options.height;
    if (options.priority) body.priority = options.priority;
    if (options.seed !== undefined) body.seed = options.seed;
    if (options.frameRate !== undefined) body.frame_rate = options.frameRate;

    const response = await fetch(`${API_BASE}/generate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abortSignal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw Object.assign(new Error(`LTX API error ${response.status}: ${text}`), { status: response.status });
    }
    return (await response.json()) as GenerateResponse;
  } finally {
    limiter.release();
  }
}

/**
 * Cancel a running or pending LTX job. Best-effort — errors are logged but not thrown.
 */
export async function cancelJob(jobId: string): Promise<void> {
  const apiKey = getApiKey();
  const response = await fetch(`${API_BASE}/cancel/${jobId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    console.warn(`[ltx] Failed to cancel job ${jobId}: ${response.status} ${text}`);
  } else {
    console.log(`[ltx] Cancelled job ${jobId}`);
  }
}

async function pollUntilDone(
  jobId: string,
  queuePosition: number,
  abortSignal?: AbortSignal,
  onProgress?: (info: LtxProgressInfo) => void,
): Promise<StatusResponse> {
  const apiKey = getApiKey();

  // Report initial queue position
  if (onProgress) {
    onProgress({ status: "pending", queuePosition });
  }

  while (true) {
    if (abortSignal?.aborted) {
      await cancelJob(jobId).catch(() => {});
      throw new Error("Video generation cancelled due to pipeline interruption");
    }
    const response = await fetch(`${API_BASE}/status/${jobId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw Object.assign(new Error(`LTX status poll error ${response.status}: ${text}`), { status: response.status });
    }
    const resp = (await response.json()) as StatusResponse;
    if (resp.status === "completed" || resp.status === "failed") return resp;

    // Report progress
    if (onProgress) {
      onProgress({
        status: resp.status as "pending" | "running",
        progress: resp.progress,
        step: resp.step,
        totalSteps: resp.total_steps,
      });
    }

    const progressStr = resp.progress !== undefined
      ? ` ${(resp.progress * 100).toFixed(0)}%` + (resp.step !== undefined ? ` (step ${resp.step}/${resp.total_steps})` : "")
      : "";
    console.log(`[ltx] ${jobId}: status=${resp.status}${progressStr}, polling in ${POLL_INTERVAL_MS / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function downloadVideo(jobId: string, outputPath: string, abortSignal?: AbortSignal): Promise<void> {
  const apiKey = getApiKey();
  const response = await fetch(`${API_BASE}/video/${jobId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: abortSignal,
  });
  if (!response.ok) throw new Error(`Failed to download LTX video: ${response.status} ${response.statusText}`);
  ensureDir(outputPath);
  fs.writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));
}

/**
 * Generate a video using the LTX Video 2.3 API.
 * Handles submission, async polling, download, and retry with exponential backoff.
 */
export async function generateVideoLtx(
  prompt: string,
  options: LtxVideoOptions,
): Promise<LtxVideoResult> {
  const { outputPath, abortSignal, onProgress } = options;
  await mkdir(path.dirname(outputPath), { recursive: true });

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (abortSignal?.aborted) throw new Error("Video generation cancelled due to pipeline interruption");
      console.log(`[ltx] Submitting generation (attempt ${attempt}/${MAX_RETRIES}), mode=${options.mode ?? "distilled"}`);
      const genResponse = await submitGeneration(prompt, options, abortSignal);
      const jobId = genResponse.job_id;
      console.log(`[ltx] Job submitted: ${jobId} (queue pos: ${genResponse.queue_position}, adjusted duration: ${genResponse.params.seconds}s)`);

      const result = await pollUntilDone(jobId, genResponse.queue_position, abortSignal, onProgress);
      if (result.status === "failed") throw new Error(`LTX video generation failed: ${result.error ?? "unknown error"}`);

      console.log(`[ltx] Downloading video to ${outputPath} (generation_time: ${result.generation_time?.toFixed(1)}s)`);
      await downloadVideo(jobId, outputPath, abortSignal);
      console.log(`[ltx] Video saved to ${outputPath}`);

      const actualDuration = genResponse.params.seconds;
      return { jobId, duration: actualDuration, path: outputPath };
    } catch (error: unknown) {
      lastError = error;
      const err = error as { message?: string; status?: number };
      if (err.message?.includes("cancelled due to pipeline interruption") || abortSignal?.aborted) throw error;
      const isRetryable = err.status === 429 || (err.status !== undefined && err.status >= 500);
      if (isRetryable && attempt < MAX_RETRIES) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 60_000);
        console.warn(`[ltx] Retryable error (${err.status}), backoff ${backoffMs / 1000}s (retry ${attempt + 1}/${MAX_RETRIES})`);
        if (err.status === 429) rateLimiters.get("ltx").backoff(backoffMs);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      if (attempt >= MAX_RETRIES) console.error(`[ltx] All ${MAX_RETRIES} retries exhausted`);
      throw error;
    }
  }
  throw lastError;
}
