import { z } from "zod";
import { mkdir } from "fs/promises";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getGoogleClient } from "../google-client";
import { getGoogleVertexClient } from "../google-vertex-client";
import { generateVideoGrok as grokGenerateVideo } from "../grok-client";
import { generateVideoLtx as ltxGenerateVideo, type LtxProgressInfo } from "../ltx-client";
import { rateLimiters } from "../queue/rate-limiter-registry.js";
import type { VideoBackend } from "../types";
import {
  VIDEO_PROMPT_PREAMBLE_WITH_CHARACTERS,
  VIDEO_PROMPT_PREAMBLE_NO_CHARACTERS,
  VIDEO_PROMPT_SUFFIX,
} from "../prompts.js";

// Custom error for RAI celebrity filter rejections — allows orchestrator to
// catch this specific failure and regenerate frames before retrying.
export class RaiCelebrityError extends Error {
  constructor(_shotNumber: number, message: string) {
    super(message);
    this.name = "RaiCelebrityError";
  }
}







/** Shared parameter type for all video backends. */
type GenerateVideoParams = {
  shotNumber: number;
  sceneNumber: number;
  shotInScene: number;
  shotType: "first_last_frame";
  dialogue: string;
  /** Who is speaking: character name, "narrator", "voiceover", or empty. */
  speaker?: string;
  /** Characters present in the shot, used to describe the speaker visually. */
  charactersPresent?: string[];
  soundEffects: string;
  cameraDirection: string;
  /** Complete video direction as natural prose from the planner. */
  videoPrompt: string;
  durationSeconds: number;
  startFramePath: string;
  outputDir: string;
  dryRun?: boolean;
  abortSignal?: AbortSignal;
  /** Video backend override. Defaults to process.env.VIDEO_BACKEND or "veo". */
  videoBackend?: VideoBackend;
  /** Aspect ratio for the generated video (e.g. "16:9", "9:16"). */
  aspectRatio?: string;
  /** Progress callback for UI updates */
  onProgress?: (message: string) => void;
  /** Version number for output filename (default 1). */
  version?: number;
  /** Queue priority — forwarded to backends that support it (e.g. LTX). */
  priority?: "normal" | "high";
  /** Optional director's note appended to the video prompt. */
  directorsNote?: string;
  /** Progress callback for LTX backend — reports queue position and generation progress. */
  onLtxProgress?: (info: LtxProgressInfo) => void;
};

/** Shared return type for all video backends. */
type GenerateVideoResult = { shotNumber: number; path: string; duration: number; finalPrompt: string };

function buildSceneShotFilename(sceneNumber: number, shotInScene: number, version: number = 1): string {
  return `scene_${String(sceneNumber).padStart(2, "0")}_shot_${String(shotInScene).padStart(2, "0")}_v${version}`;
}

function formatShotContext(params: Pick<GenerateVideoParams, "shotNumber" | "sceneNumber" | "shotInScene">): string {
  return `scene ${params.sceneNumber} shot ${params.shotInScene} (shot ${params.shotNumber})`;
}

export function buildVideoPrompt(params: Pick<GenerateVideoParams, "videoPrompt" | "charactersPresent" | "directorsNote">): string {
  const promptParts: string[] = [];
  const hasCharacters = params.charactersPresent && params.charactersPresent.length > 0;
  // Scene direction first — the most important content for the video model.
  if (params.videoPrompt) promptParts.push(params.videoPrompt);
  // Concise style tag + character-awareness instruction at the end.
  // Only include character-awareness text when characters are actually present;
  // otherwise the video model reads "characters" and hallucinates people into the scene.
  if (hasCharacters) {
    promptParts.push(VIDEO_PROMPT_PREAMBLE_WITH_CHARACTERS);
  } else {
    promptParts.push(VIDEO_PROMPT_PREAMBLE_NO_CHARACTERS);
  }
  // Suppress music/soundtrack — per-shot music clashes when assembled; audio added in post-production.
  promptParts.push(VIDEO_PROMPT_SUFFIX);
  // Strip trailing periods from each part before joining to avoid double-period artifacts.
  let prompt = promptParts.map(p => p.replace(/\.+$/, "")).join(". ") + ".";
  if (params.directorsNote) {
    prompt += `\n\nDirector's note: ${params.directorsNote}`;
  }
  return prompt;
}


/**
 * Generates video clips for shots.
 * Dispatches to Veo 3.1 or Grok backend based on VIDEO_BACKEND env var.
 */
export async function generateVideo(params: GenerateVideoParams): Promise<GenerateVideoResult> {
  const backend = (params.videoBackend || process.env.VIDEO_BACKEND || "veo").toLowerCase();
  console.log(`[generateVideo] Using backend: ${backend}`);

  if (backend === "veo") {
    return generateVideoVeo(params);
  } else if (backend === "veo-reve") {
    return generateVideoVeoReve(params);
  } else if (backend === "grok") {
    return generateVideoGrok(params);
  } else if (backend === "ltx-full") {
    return generateVideoLtxBackend(params, "full");
  } else if (backend === "ltx-distilled") {
    return generateVideoLtxBackend(params, "distilled");
  } else {
    throw new Error(`[generateVideo] Unknown VIDEO_BACKEND: "${backend}". Use "veo", "veo-reve", "grok", "ltx-full", or "ltx-distilled".`);
  }
}

/**
 * Veo 3.1 backend: generates video via Google GenAI SDK.
 */
async function generateVideoVeo(params: GenerateVideoParams): Promise<GenerateVideoResult> {
  const {
    shotNumber,
    sceneNumber,
    shotInScene,
    shotType,
    durationSeconds,
    startFramePath,
    outputDir,
    dryRun = false,
    abortSignal,
    version = 1,
  } = params;

  // Ensure output directory exists
  await mkdir(outputDir, { recursive: true });

  const shotContext = formatShotContext({ shotNumber, sceneNumber, shotInScene });
  const outputPath = join(outputDir, `${buildSceneShotFilename(sceneNumber, shotInScene, version)}.mp4`);

	const finalPrompt = buildVideoPrompt(params);

  // Dry-run mode: return placeholder
  if (dryRun) {
    console.log(`[generateVideo] DRY-RUN: ${shotContext} (${shotType}, ${durationSeconds}s)`);
		  console.log(`[generateVideo] Prompt sent to API: ${finalPrompt}`);
		  return { shotNumber, path: outputPath, duration: durationSeconds, finalPrompt };
  }

  console.log(`[generateVideo] Generating ${shotContext} (${shotType}, ${durationSeconds}s)`);
		console.log(`[generateVideo] Prompt sent to API: ${finalPrompt}`);

  try {
    const client = getGoogleClient();
    const maxRetries = 5;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (!startFramePath) {
          throw new Error("startFramePath required");
        }

        // Load start image as base64 (start frame)
        const startImageBuffer = readFileSync(startFramePath);
        const startImage = {
          imageBytes: startImageBuffer.toString("base64"),
          mimeType: "image/png",
        };

        // Build config
        // Veo 3.1 image-to-video supports 4, 6, or 8 second durations.
        // Clamp the requested duration to the nearest valid value.
        const validDurations = [4, 6, 8];
        const clampedDuration = validDurations.reduce((prev, curr) =>
          Math.abs(curr - durationSeconds) < Math.abs(prev - durationSeconds) ? curr : prev
        );
        const aspectRatio = params.aspectRatio || "16:9";
        const config: Record<string, unknown> = {
          durationSeconds: clampedDuration,
          aspectRatio,
          personGeneration: "allow_adult",
        };

        console.log(`[generateVideo] Veo config: durationSeconds=${clampedDuration} (requested ${durationSeconds}), aspectRatio=${aspectRatio}`);

        const limiter = rateLimiters.get('veo');
        await limiter.acquire();
        let veoReleased = false;
        try {

        console.log(`[generateVideo] ${shotContext}: Calling Veo API (attempt ${attempt}/${maxRetries})...`);

        // Wrap the generateVideos call with a 60-second timeout to avoid hanging forever
        const veoTimeoutMs = 60000;
        let operation: Awaited<ReturnType<typeof client.models.generateVideos>>;
        const veoCallPromise = client.models.generateVideos({
          model: "veo-3.1-generate-preview",
	          prompt: finalPrompt,
          image: startImage,
          config: {
            ...config,
          } as any,
        });
        const veoTimeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Veo API call timed out after ${veoTimeoutMs / 1000}s for ${shotContext}`)), veoTimeoutMs)
        );
        operation = await Promise.race([veoCallPromise, veoTimeoutPromise]);

        console.log(`[generateVideo] ${shotContext}: Veo API returned operation: ${operation.name}, done=${operation.done}`);

        // Poll for operation completion
        console.log(`[generateVideo] Polling for completion (operation: ${operation.name})`);

        let pollCount = 0;
        while (!operation.done) {
          // Check abort signal before polling
          if (abortSignal?.aborted) {
            throw new Error("Video generation cancelled due to pipeline interruption");
          }
          await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds between polls
          pollCount++;
          console.log(`[generateVideo] ${shotContext}: Polling... (${pollCount * 10}s elapsed)`);
          operation = await client.operations.getVideosOperation({ operation });
        }

        // Extract generated video from response
        const response = operation.response;
        const generatedVideo = response?.generatedVideos?.[0];
        if (!generatedVideo?.video) {
          // Log full response for debugging (may include RAI filter info)
          const filterCount = response?.raiMediaFilteredCount;
          const filterReasons = response?.raiMediaFilteredReasons;
          const errorInfo = operation.error;
          console.error(`[generateVideo] ${shotContext}: No video returned.`);
          if (filterCount) console.error(`[generateVideo]   RAI filtered count: ${filterCount}`);
          if (filterReasons?.length) console.error(`[generateVideo]   RAI filter reasons: ${filterReasons.join(', ')}`);
          if (errorInfo) console.error(`[generateVideo]   Operation error: ${JSON.stringify(errorInfo)}`);
          if (!filterCount && !filterReasons?.length && !errorInfo) {
            console.error(`[generateVideo]   Full response: ${JSON.stringify(response)}`);
          }
          // Throw a specific error when the RAI filter mentions "celebrity" so
          // the orchestrator can regenerate frames and retry.
          if (filterReasons?.some((r: string) => r.toLowerCase().includes('celebrity'))) {
            throw new RaiCelebrityError(shotNumber, `RAI celebrity filter for ${shotContext}: ${filterReasons.join(', ')}`);
          }
          throw new Error(`No video in response for ${shotContext}${filterReasons?.length ? ` (RAI: ${filterReasons.join(', ')})` : ''}`);
        }

        // Download the video to disk
        console.log(`[generateVideo] Downloading video for ${shotContext}`);
        await client.files.download({
          file: generatedVideo.video,
          downloadPath: outputPath,
        });

        console.log(`[generateVideo] ${shotContext} saved to ${outputPath}`);
		        return { shotNumber, path: outputPath, duration: clampedDuration, finalPrompt };

        } finally {
          if (!veoReleased) {
            veoReleased = true;
            limiter.release();
          }
        }
      } catch (error: any) {
        lastError = error;
        console.error(`[generateVideo] ${shotContext}: Veo API error (attempt ${attempt}/${maxRetries}):`, error);
        // Don't retry if cancelled due to pipeline interruption
        if (error?.message?.includes('cancelled due to pipeline interruption')) {
          throw error;
        }
        // Check if it's a 429 rate limit error
        if (error?.status === 429 || error?.message?.includes('429') || error?.message?.includes('RESOURCE_EXHAUSTED')) {
          console.warn(`[generateVideo] ${shotContext}: Rate limited (429) — backing off all veo workers for 60s`);
          rateLimiters.get('veo').backoff(60000);
          continue;
        }
        // Non-retryable error: don't retry
        throw error;
      }
    }

    // All retries exhausted
    console.error(`[generateVideo] ${shotContext}: All ${maxRetries} retries exhausted`);
    throw lastError;
  } catch (error) {
    console.error(`[generateVideo] Error generating ${shotContext}:`, error);
    throw error;
  }
}

/**
 * Veo 3.1 backend via Vertex AI with service account credentials.
 */
async function generateVideoVeoReve(params: GenerateVideoParams): Promise<GenerateVideoResult> {
  const {
    shotNumber,
    sceneNumber,
    shotInScene,
    shotType,
    durationSeconds,
    startFramePath,
    outputDir,
    dryRun = false,
    abortSignal,
    version = 1,
  } = params;

  // Ensure output directory exists
  await mkdir(outputDir, { recursive: true });

  const shotContext = formatShotContext({ shotNumber, sceneNumber, shotInScene });
  const outputPath = join(outputDir, `${buildSceneShotFilename(sceneNumber, shotInScene, version)}.mp4`);

	const finalPrompt = buildVideoPrompt(params);

  // Dry-run mode: return placeholder
  if (dryRun) {
    console.log(`[generateVideo] DRY-RUN (veo-reve): ${shotContext} (${shotType}, ${durationSeconds}s)`);
		  console.log(`[generateVideo] Prompt sent to API: ${finalPrompt}`);
		  return { shotNumber, path: outputPath, duration: durationSeconds, finalPrompt };
  }

  console.log(`[generateVideo] Generating via veo-reve ${shotContext} (${shotType}, ${durationSeconds}s)`);
		console.log(`[generateVideo] Prompt sent to API: ${finalPrompt}`);

  try {
    const client = getGoogleVertexClient();
    const maxRetries = 5;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (!startFramePath) {
          throw new Error("startFramePath required");
        }

        // Load start image as base64 (start frame)
        const startImageBuffer = readFileSync(startFramePath);
        const startImage = {
          imageBytes: startImageBuffer.toString("base64"),
          mimeType: "image/png",
        };

        // Veo 3.1 image-to-video supports 4, 6, or 8 second durations.
        const validDurations = [4, 6, 8];
        const clampedDuration = validDurations.reduce((prev, curr) =>
          Math.abs(curr - durationSeconds) < Math.abs(prev - durationSeconds) ? curr : prev
        );
        const aspectRatio = params.aspectRatio || "16:9";
        const config: Record<string, unknown> = {
          durationSeconds: clampedDuration,
          aspectRatio,
          personGeneration: "allow_adult",
        };

        console.log(`[generateVideo] veo-reve config: durationSeconds=${clampedDuration} (requested ${durationSeconds}), aspectRatio=${aspectRatio}`);

        const limiter = rateLimiters.get('veo-reve');
        await limiter.acquire();
        let veoReleased = false;
        try {

        console.log(`[generateVideo] ${shotContext}: Calling veo-reve API (attempt ${attempt}/${maxRetries})...`);

        const veoTimeoutMs = 60000;
        let operation: Awaited<ReturnType<typeof client.models.generateVideos>>;
        const veoCallPromise = client.models.generateVideos({
          model: "veo-3.1-generate-001",
          prompt: finalPrompt,
          image: startImage,
          config: {
            ...config,
          } as any,
        });
        const veoTimeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`veo-reve API call timed out after ${veoTimeoutMs / 1000}s for ${shotContext}`)), veoTimeoutMs)
        );
        operation = await Promise.race([veoCallPromise, veoTimeoutPromise]);

        console.log(`[generateVideo] ${shotContext}: veo-reve API returned operation: ${operation.name}, done=${operation.done}`);

        // Poll for operation completion
        console.log(`[generateVideo] veo-reve polling for completion (operation: ${operation.name})`);

        let pollCount = 0;
        while (!operation.done) {
          if (abortSignal?.aborted) {
            throw new Error("Video generation cancelled due to pipeline interruption");
          }
          await new Promise((resolve) => setTimeout(resolve, 10000));
          pollCount++;
          console.log(`[generateVideo] ${shotContext}: veo-reve polling... (${pollCount * 10}s elapsed)`);
          operation = await client.operations.getVideosOperation({ operation });
        }

        // Extract generated video from response
        const response = operation.response;
        const generatedVideo = response?.generatedVideos?.[0];
        if (!generatedVideo?.video) {
          const filterCount = response?.raiMediaFilteredCount;
          const filterReasons = response?.raiMediaFilteredReasons;
          const errorInfo = operation.error;
          console.error(`[generateVideo] ${shotContext}: veo-reve no video returned.`);
          if (filterCount) console.error(`[generateVideo]   RAI filtered count: ${filterCount}`);
          if (filterReasons?.length) console.error(`[generateVideo]   RAI filter reasons: ${filterReasons.join(', ')}`);
          if (errorInfo) console.error(`[generateVideo]   Operation error: ${JSON.stringify(errorInfo)}`);
          if (!filterCount && !filterReasons?.length && !errorInfo) {
            console.error(`[generateVideo]   Full response: ${JSON.stringify(response)}`);
          }
          if (filterReasons?.some((r: string) => r.toLowerCase().includes('celebrity'))) {
            throw new RaiCelebrityError(shotNumber, `RAI celebrity filter for ${shotContext}: ${filterReasons.join(', ')}`);
          }
          throw new Error(`No video in response for ${shotContext}${filterReasons?.length ? ` (RAI: ${filterReasons.join(', ')})` : ''}`);
        }

        // Download the video to disk
        console.log(`[generateVideo] veo-reve downloading video for ${shotContext}`);
        if (generatedVideo.video.videoBytes) {
          writeFileSync(outputPath, Buffer.from(generatedVideo.video.videoBytes, 'base64'));
        } else {
          await client.files.download({
            file: generatedVideo.video,
            downloadPath: outputPath,
          });
        }

        console.log(`[generateVideo] veo-reve ${shotContext} saved to ${outputPath}`);
		        return { shotNumber, path: outputPath, duration: clampedDuration, finalPrompt };

        } finally {
          if (!veoReleased) {
            veoReleased = true;
            limiter.release();
          }
        }
      } catch (error: any) {
        lastError = error;
        console.error(`[generateVideo] ${shotContext}: veo-reve API error (attempt ${attempt}/${maxRetries}):`, error);
        if (error?.message?.includes('cancelled due to pipeline interruption')) {
          throw error;
        }
        if (error?.status === 429 || error?.message?.includes('429') || error?.message?.includes('RESOURCE_EXHAUSTED')) {
          console.warn(`[generateVideo] ${shotContext}: veo-reve rate limited (429) — backing off for 60s`);
          rateLimiters.get('veo-reve').backoff(60000);
          continue;
        }
        throw error;
      }
    }

    // All retries exhausted
    console.error(`[generateVideo] ${shotContext}: veo-reve all ${maxRetries} retries exhausted`);
    throw lastError;
  } catch (error) {
    console.error(`[generateVideo] veo-reve error generating ${shotContext}:`, error);
    throw error;
  }
}


/**
 * Vercel AI SDK tool definition for generateVideo.
 * Claude calls this to generate video clips for shots.
 */
export const generateVideoTool = {
  description:
    "Generate video clips for shots using first+last frame interpolation. Backend is selected by VIDEO_BACKEND env var.",
  parameters: z.object({
    shotNumber: z.number().describe("Global shot number"),
    sceneNumber: z.number().describe("Scene number for the shot"),
    shotInScene: z.number().describe("Shot number within the scene"),
    shotType: z.literal("first_last_frame").describe("Video generation mode"),
    dialogue: z.string().describe("Character dialogue (empty if none)"),
    soundEffects: z.string().describe("Sound effects description"),
    cameraDirection: z.string().describe("Camera movement and angle"),
    videoPrompt: z.string().describe("Complete video direction as natural prose from the planner"),
    durationSeconds: z.number().describe("Video duration in seconds (0.5-15). Veo supports 4, 6, or 8 seconds; Grok supports 1-15."),
    startFramePath: z.string().describe("Path to start frame image"),
    outputDir: z.string().describe("Output directory for video file"),
    dryRun: z.boolean().optional().describe("Return placeholder without calling API"),
  }),
};


/**
 * Grok backend: generates video via xAI Grok API.
 * Uses only the start frame (ignores endFramePath). Supports 1-15s duration.
 */
async function generateVideoGrok(params: GenerateVideoParams): Promise<GenerateVideoResult> {
  const {
    shotNumber,
    sceneNumber,
    shotInScene,
    shotType,
    durationSeconds,
    startFramePath,
    outputDir,
    dryRun = false,
    abortSignal,
    version = 1,
  } = params;

  // Ensure output directory exists
  await mkdir(outputDir, { recursive: true });

  const shotContext = formatShotContext({ shotNumber, sceneNumber, shotInScene });
  const outputPath = join(outputDir, `${buildSceneShotFilename(sceneNumber, shotInScene, version)}.mp4`);

	const finalPrompt = buildVideoPrompt(params);

  // Dry-run mode: return placeholder
  if (dryRun) {
    console.log(`[generateVideo] DRY-RUN: ${shotContext} (${shotType}, ${durationSeconds}s)`);
		  console.log(`[generateVideo] Prompt sent to API: ${finalPrompt}`);
		  return { shotNumber, path: outputPath, duration: durationSeconds, finalPrompt };
  }

  if (!startFramePath) {
    throw new Error("Grok backend requires startFramePath");
  }

  console.log(`[generateVideo] Generating ${shotContext} via Grok (${shotType}, ${durationSeconds}s)`);
		console.log(`[generateVideo] Prompt sent to API: ${finalPrompt}`);

  // Convert start frame to base64 data URI
  const imageBuffer = readFileSync(startFramePath);
  const ext = startFramePath.toLowerCase().endsWith(".png") ? "png" : "jpeg";
  const dataUri = `data:image/${ext};base64,${imageBuffer.toString("base64")}`;

  // Clamp duration to Grok's supported range (1-15s)
  const clampedDuration = Math.max(1, Math.min(15, durationSeconds));

  try {
    // grok-client already handles retries with exponential backoff
    const result = await grokGenerateVideo(finalPrompt, {
      image: dataUri,
      duration: clampedDuration,
      aspectRatio: params.aspectRatio || "16:9",
      resolution: "720p",
      outputPath,
      abortSignal,
    });

    if (result.duration !== clampedDuration) {
      console.warn(`[generateVideo] WARNING: Requested ${clampedDuration}s but Grok returned ${result.duration}s`);
    }

    console.log(`[generateVideo] ${shotContext} saved to ${result.path}`);
		    return { shotNumber, path: result.path, duration: clampedDuration, finalPrompt };
  } catch (error) {
    console.error(`[generateVideo] Error generating ${shotContext} via Grok:`, error);
    throw error;
  }
}


/**
 * LTX Video 2.3 backend: generates video via self-hosted LTX API.
 * Uses image-to-video when a start frame is available; supports arbitrary durations.
 * Defaults to distilled mode for faster generation.
 */
async function generateVideoLtxBackend(params: GenerateVideoParams, mode: "full" | "distilled"): Promise<GenerateVideoResult> {
  const {
    shotNumber,
    sceneNumber,
    shotInScene,
    durationSeconds,
    startFramePath,
    outputDir,
    dryRun = false,
    abortSignal,
    version = 1,
  } = params;

  await mkdir(outputDir, { recursive: true });

  const shotContext = formatShotContext({ shotNumber, sceneNumber, shotInScene });
  const outputPath = join(outputDir, `${buildSceneShotFilename(sceneNumber, shotInScene, version)}.mp4`);

  const finalPrompt = buildVideoPrompt(params);

  if (dryRun) {
    console.log(`[generateVideo] DRY-RUN: ${shotContext} via LTX (${durationSeconds}s)`);
    console.log(`[generateVideo] Prompt sent to API: ${finalPrompt}`);
    return { shotNumber, path: outputPath, duration: durationSeconds, finalPrompt };
  }

  console.log(`[generateVideo] Generating ${shotContext} via LTX (${durationSeconds}s)`);
  console.log(`[generateVideo] Prompt sent to API: ${finalPrompt}`);

  // Resolve aspect ratio to LTX pixel dimensions
  const aspectRatio = params.aspectRatio || "16:9";
  let width: number;
  let height: number;
  if (aspectRatio === "16:9") {
    width = 1408; height = 768;
  } else if (aspectRatio === "9:16") {
    width = 768; height = 1408;
  } else {
    width = 1024; height = 1024;
  }

  try {
    const result = await ltxGenerateVideo(finalPrompt, {
      image: startFramePath || undefined,
      duration: durationSeconds,
      width,
      height,
      mode,
      priority: params.priority,
      outputPath,
      abortSignal,
      onProgress: params.onLtxProgress,
    });

    console.log(`[generateVideo] ${shotContext} saved to ${result.path} (LTX adjusted duration: ${result.duration}s)`);
    return { shotNumber, path: result.path, duration: result.duration, finalPrompt };
  } catch (error) {
    console.error(`[generateVideo] Error generating ${shotContext} via LTX:`, error);
    throw error;
  }
}