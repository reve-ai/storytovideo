import { z } from "zod";
import { mkdir } from "fs/promises";
import { readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { getGoogleClient } from "../google-client";
import { uploadAsset, runWorkflow, pollJob, downloadAsset, checkJob } from "../comfy-client";
import { generateVideoGrok as grokGenerateVideo } from "../grok-client";
import { rateLimiters } from "../queue/rate-limiter-registry.js";

const execFileAsync = promisify(execFileCb);

/**
 * Resize an image to target dimensions using ffmpeg, preserving aspect ratio
 * with padding (letterbox/pillarbox). Returns path to resized temp file.
 */
async function resizeForComfy(
  inputPath: string,
  width: number,
  height: number,
): Promise<string> {
  const tmpPath = inputPath.replace(/(\.\w+)$/, `_comfy_${width}x${height}$1`);
  await execFileAsync("ffmpeg", [
    "-y", "-i", inputPath,
    "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
    "-q:v", "2",
    "-strict", "unofficial",
    tmpPath,
  ]);
  return tmpPath;
}

// Custom error for RAI celebrity filter rejections — allows orchestrator to
// catch this specific failure and regenerate frames before retrying.
export class RaiCelebrityError extends Error {
  constructor(_shotNumber: number, message: string) {
    super(message);
    this.name = "RaiCelebrityError";
  }
}



/**
 * Strip character names from text to avoid triggering Veo's RAI celebrity filter.
 * Replaces whole-word occurrences of each name with "the character".
 */
export function stripCharacterNames(text: string, names: string[]): string {
  let result = text;
  for (const name of names) {
    if (!name) continue;
    // Escape regex special characters in the name
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Replace whole-word occurrences (case-insensitive)
    const re = new RegExp(`\\b${escaped}\\b`, "gi");
    result = result.replace(re, "the character");
  }
  return result;
}

/** Shared parameter type for all video backends. */
type GenerateVideoParams = {
  shotNumber: number;
  sceneNumber: number;
  shotInScene: number;
  shotType: "first_last_frame";
  actionPrompt: string;
  dialogue: string;
  /** Who is speaking: character name, "narrator", "voiceover", or empty. */
  speaker?: string;
  /** Characters present in the shot, used to describe the speaker visually. */
  charactersPresent?: string[];
  soundEffects: string;
  cameraDirection: string;
  durationSeconds: number;
  startFramePath: string;
  outputDir: string;
  dryRun?: boolean;
  abortSignal?: AbortSignal;
  /** Character names to strip from prompts before sending to Veo. */
  characterNames?: string[];
  /** Video backend override. Defaults to process.env.VIDEO_BACKEND or "veo". */
  videoBackend?: "veo" | "comfy" | "grok";
  /** Aspect ratio for the generated video (e.g. "16:9", "9:16"). */
  aspectRatio?: string;
  /** Progress callback for UI updates */
  onProgress?: (message: string) => void;
  pendingJobStore?: {
    get: (key: string) => { jobId: string; outputPath: string } | undefined;
    set: (key: string, value: { jobId: string; outputPath: string }) => Promise<void>;
    delete: (key: string) => Promise<void>;
  };
  /** Version number for output filename (default 1). */
  version?: number;
};

/** Shared return type for all video backends. */
type GenerateVideoResult = { shotNumber: number; path: string; duration: number; promptSent?: string };

function buildSceneShotFilename(sceneNumber: number, shotInScene: number, version: number = 1): string {
  return `scene_${String(sceneNumber).padStart(2, "0")}_shot_${String(shotInScene).padStart(2, "0")}_v${version}`;
}

function formatShotContext(params: Pick<GenerateVideoParams, "shotNumber" | "sceneNumber" | "shotInScene">): string {
  return `scene ${params.sceneNumber} shot ${params.shotInScene} (shot ${params.shotNumber})`;
}

/**
 * Build a dialogue description for the video prompt.
 * Uses the speaker field to attribute dialogue to the correct character.
 * Character names are replaced with visual descriptions since names get stripped.
 */
function buildDialoguePrompt(dialogue: string, speaker?: string, charactersPresent?: string[]): string {
  if (!dialogue) return "";
  const s = (speaker ?? "").trim().toLowerCase();
  if (!s || s === "narrator" || s === "voiceover") {
    return `${s === "voiceover" ? "Voiceover" : "Narrator"} says: "${dialogue}"`;
  }
  // Speaker is a character name — describe them visually based on position in the cast
  let label: string;
  if (charactersPresent && charactersPresent.length > 0) {
    const idx = charactersPresent.findIndex(c => c.toLowerCase() === s);
    if (charactersPresent.length === 1) {
      label = "the person";
    } else if (idx === 0) {
      label = "the first person";
    } else if (idx === 1) {
      label = "the second person";
    } else {
      label = "one of the people";
    }
  } else {
    label = "the person";
  }
  return `${label[0].toUpperCase() + label.slice(1)} speaks: "${dialogue}"`;
}


/**
 * Generates video clips for shots.
 * Dispatches to Veo 3.1 or ComfyUI backend based on VIDEO_BACKEND env var.
 */
export async function generateVideo(params: GenerateVideoParams): Promise<GenerateVideoResult> {
  const backend = (params.videoBackend || process.env.VIDEO_BACKEND || "veo").toLowerCase();
  console.log(`[generateVideo] Using backend: ${backend}`);

  // Strip character names from prompts to avoid triggering Veo's RAI celebrity filter.
  // Veo already has start/end frame images so it doesn't need names to identify characters.
  let sanitized = params;
  if (params.characterNames && params.characterNames.length > 0) {
    sanitized = {
      ...params,
      actionPrompt: stripCharacterNames(params.actionPrompt, params.characterNames),
      // Do NOT strip names from dialogue — it's spoken text for TTS, names should be preserved
    };
  }

  if (backend === "comfy") {
    return generateVideoComfy(sanitized);
  } else if (backend === "veo") {
    return generateVideoVeo(sanitized);
  } else if (backend === "grok") {
    return generateVideoGrok(sanitized);
  } else {
    throw new Error(`[generateVideo] Unknown VIDEO_BACKEND: "${backend}". Use "veo", "comfy", or "grok".`);
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
    actionPrompt,
    dialogue,
    soundEffects,
    cameraDirection,
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

	// Build video prompt from components
	const promptParts: string[] = [];
	if (actionPrompt) promptParts.push(actionPrompt);
	const dialoguePart = buildDialoguePrompt(dialogue, params.speaker, params.charactersPresent);
	if (dialoguePart) promptParts.push(dialoguePart);
	if (soundEffects) promptParts.push(`Sound effects: ${soundEffects}`);
	if (cameraDirection) promptParts.push(`Camera: ${cameraDirection}`);
	const videoPrompt = promptParts.join(". ");

  // Dry-run mode: return placeholder
  if (dryRun) {
    console.log(`[generateVideo] DRY-RUN: ${shotContext} (${shotType}, ${durationSeconds}s)`);
	  console.log(`[generateVideo] Prompt sent to API: ${videoPrompt}`);
	  return { shotNumber, path: outputPath, duration: durationSeconds, promptSent: videoPrompt };
  }

  console.log(`[generateVideo] Generating ${shotContext} (${shotType}, ${durationSeconds}s)`);
	console.log(`[generateVideo] Prompt sent to API: ${videoPrompt}`);

  try {
    const client = getGoogleClient();
    const maxRetries = 5;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (!startFramePath) {
          throw new Error("first_last_frame requires startFramePath");
        }

        // Load start image as base64 (used for both start and end frame)
        const startImageBuffer = readFileSync(startFramePath);
        const startImage = {
          imageBytes: startImageBuffer.toString("base64"),
          mimeType: "image/png",
        };

        const endImage = startImage; // Use same frame for both

        // Build config
        // Veo 3.1 interpolation only supports 8s duration.
        const config: Record<string, unknown> = {
          durationSeconds: 8,
          aspectRatio: "16:9",
          personGeneration: "allow_adult",
        };

        console.log(`[generateVideo] Config: durationSeconds=${config.durationSeconds}, aspectRatio=${config.aspectRatio}`);

        const limiter = rateLimiters.get('veo');
        await limiter.acquire();
        let veoReleased = false;
        try {

        let operation = await client.models.generateVideos({
          model: "veo-3.1-generate-preview",
          prompt: videoPrompt,
          image: startImage,
          config: {
            ...config,
            lastFrame: endImage,
          } as any,
        });

        // Poll for operation completion
        console.log(`[generateVideo] Polling for completion (operation: ${operation.name})`);

        while (!operation.done) {
          // Check abort signal before polling
          if (abortSignal?.aborted) {
            throw new Error("Video generation cancelled due to pipeline interruption");
          }
          await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds between polls
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
	        return { shotNumber, path: outputPath, duration: 8, promptSent: videoPrompt };

        } finally {
          if (!veoReleased) {
            veoReleased = true;
            limiter.release();
          }
        }
      } catch (error: any) {
        lastError = error;
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
    actionPrompt: z.string().describe("Action description for the shot"),
    dialogue: z.string().describe("Character dialogue (empty if none)"),
    soundEffects: z.string().describe("Sound effects description"),
    cameraDirection: z.string().describe("Camera movement and angle"),
    durationSeconds: z.number().describe("Video duration in seconds (0.5-10). Veo always uses 8; ComfyUI supports arbitrary."),
    startFramePath: z.string().describe("Path to start frame image"),
    outputDir: z.string().describe("Output directory for video file"),
    dryRun: z.boolean().optional().describe("Return placeholder without calling API"),
  }),
};

/**
 * ComfyUI backend: generates video via ComfyUI frame_to_video workflow.
 * Uses exponential backoff retry (5s, 10s, 20s, 40s, 80s).
 */
async function generateVideoComfy(params: GenerateVideoParams): Promise<GenerateVideoResult> {
  const {
    shotNumber,
    sceneNumber,
    shotInScene,
    shotType,
    actionPrompt,
    dialogue,
    soundEffects,
    cameraDirection,
    durationSeconds,
    startFramePath,
    outputDir,
    dryRun = false,
    abortSignal,
    pendingJobStore,
    version = 1,
  } = params;

  // Ensure output directory exists
  await mkdir(outputDir, { recursive: true });

  const shotContext = formatShotContext({ shotNumber, sceneNumber, shotInScene });
  const outputPath = join(outputDir, `${buildSceneShotFilename(sceneNumber, shotInScene, version)}.mp4`);

	// Build video prompt from components
	const promptParts: string[] = [];
	if (actionPrompt) promptParts.push(actionPrompt);
	const dialoguePart = buildDialoguePrompt(dialogue, params.speaker, params.charactersPresent);
	if (dialoguePart) promptParts.push(dialoguePart);
	if (soundEffects) promptParts.push(`Sound effects: ${soundEffects}`);
	if (cameraDirection) promptParts.push(`Camera: ${cameraDirection}`);
	const videoPrompt = promptParts.join(". ");

  // Dry-run mode: return placeholder
  if (dryRun) {
    console.log(`[generateVideo] DRY-RUN: ${shotContext} (${shotType}, ${durationSeconds}s)`);
	  console.log(`[generateVideo] Prompt sent to API: ${videoPrompt}`);
	  return { shotNumber, path: outputPath, duration: durationSeconds, promptSent: videoPrompt };
  }

  // Check for a pending job from a previous run
  const jobKey = `video-${buildSceneShotFilename(sceneNumber, shotInScene, version)}`;
  if (pendingJobStore) {
    const pending = pendingJobStore.get(jobKey);
    if (pending) {
      console.log(`[generateVideo] Found pending job ${pending.jobId} for ${shotContext}, checking status...`);
      const status = await checkJob(pending.jobId);
      if (status && status.status === "completed" && status.outputAssetIds.length > 0) {
        console.log(`[generateVideo] Pending job ${pending.jobId} for ${shotContext} already completed, downloading...`);
        await downloadAsset(status.outputAssetIds[0], outputPath);
        await pendingJobStore.delete(jobKey);
        console.log(`[generateVideo] ${shotContext} saved to ${outputPath}`);
	        return { shotNumber, path: outputPath, duration: durationSeconds, promptSent: videoPrompt };
      }
      if (status && (status.status === "running" || status.status === "queued")) {
        // Job is still in progress — poll it to completion instead of re-submitting
        console.log(`[generateVideo] Pending job ${pending.jobId} for ${shotContext} still ${status.status}, resuming poll...`);
        const progressCb = params.onProgress;
        const result = await pollJob(pending.jobId, abortSignal, (progress) => {
          const msg = `[video_generation] ${shotContext}: ${progress}% complete`;
          console.log(msg);
          progressCb?.(msg);
        });
        if (result.status === "completed" && result.outputAssetIds.length > 0) {
          await downloadAsset(result.outputAssetIds[0], outputPath);
          await pendingJobStore.delete(jobKey);
          console.log(`[generateVideo] ${shotContext} saved to ${outputPath}`);
	          return { shotNumber, path: outputPath, duration: durationSeconds, promptSent: videoPrompt };
        }
        // If poll ended without success, fall through to re-submit
      }
      // Job failed or unreachable — clear and re-submit
      console.log(`[generateVideo] Pending job ${pending.jobId} not usable (status: ${status?.status ?? "unreachable"}), re-submitting...`);
      await pendingJobStore.delete(jobKey);
    }
  }

  console.log(`[generateVideo] Generating ${shotContext} (${shotType}, ${durationSeconds}s)`);
	console.log(`[generateVideo] Prompt sent to API: ${videoPrompt}`);

  try {
    const maxRetries = 5;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (!startFramePath) {
          throw new Error("first_last_frame requires startFramePath");
        }

        // Resize frame to match ComfyUI workflow dimensions, then upload
        const comfyWidth = 640;
        const comfyHeight = 640;
        const tmpFiles: string[] = [];

        console.log(`[generateVideo] Resizing and uploading start frame for ${shotContext}`);
        const resizedStart = await resizeForComfy(startFramePath, comfyWidth, comfyHeight);
        tmpFiles.push(resizedStart);
        const startAssetId = await uploadAsset(resizedStart);
        console.log(`[generateVideo] Start frame uploaded: ${startAssetId}`);

        // Use start frame as end frame too
        const endAssetId = startAssetId;

        // Clean up temp resized files
        for (const tmp of tmpFiles) {
          try { unlinkSync(tmp); } catch {}
        }

        // Convert duration to frame count (fps=16)
        // ComfyUI requires length to be 4k+1 (e.g., 5, 9, 13, ..., 81, 85)
        const rawLength = Math.round(16 * durationSeconds);
        const length = Math.round((rawLength - 1) / 4) * 4 + 1;
        console.log(`[generateVideo] Duration: ${durationSeconds}s → ${length} frames (fps=16)`);

        // Run the frame_to_video workflow
        console.log(`[generateVideo] Running frame_to_video workflow for ${shotContext}`);
        const jobId = await runWorkflow("frame_to_video", {
          prompt: videoPrompt,
          start_asset_id: startAssetId,
          end_asset_id: endAssetId,
          width: comfyWidth,
          height: comfyHeight,
          length,
          fps: 16,
        });
        console.log(`[generateVideo] Workflow started: job ${jobId}`);

        // Store pending job for resume capability
        if (pendingJobStore) {
          await pendingJobStore.set(jobKey, { jobId, outputPath });
        }

        // Poll for job completion
        console.log(`[generateVideo] Polling for completion (job: ${jobId})`);
        const progressCb = params.onProgress;
        const result = await pollJob(jobId, abortSignal, (progress) => {
          const msg = `[video_generation] ${shotContext}: ${progress}% complete`;
          console.log(msg);
          progressCb?.(msg);
        });

        if (result.status !== "completed") {
          throw new Error(`Job ${jobId} did not complete successfully: ${result.status}`);
        }

        if (!result.outputAssetIds || result.outputAssetIds.length === 0) {
          throw new Error(`No output assets returned for job ${jobId}`);
        }

        // Download the output video
        console.log(`[generateVideo] Downloading video for ${shotContext}`);
        await downloadAsset(result.outputAssetIds[0], outputPath);

        // Clear pending job on success
        if (pendingJobStore) {
          await pendingJobStore.delete(jobKey);
        }

        console.log(`[generateVideo] ${shotContext} saved to ${outputPath}`);
	        return { shotNumber, path: outputPath, duration: durationSeconds, promptSent: videoPrompt };
      } catch (error: any) {
        lastError = error;
        // Don't retry if cancelled due to pipeline interruption
        if (error?.message?.includes('cancelled due to pipeline interruption')) {
          throw error;
        }
        const backoffMs = Math.pow(2, attempt - 1) * 5000; // Exponential backoff: 5s, 10s, 20s, 40s, 80s
        if (attempt < maxRetries) {
          console.warn(`[generateVideo] ${shotContext}: Error on attempt ${attempt}/${maxRetries}. Retrying in ${backoffMs}ms...`);
          console.warn(`[generateVideo] Error details:`, error?.message || error);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
        // Last attempt failed
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
 * Grok backend: generates video via xAI Grok API.
 * Uses only the start frame (ignores endFramePath). Supports 1-15s duration.
 */
async function generateVideoGrok(params: GenerateVideoParams): Promise<GenerateVideoResult> {
  const {
    shotNumber,
    sceneNumber,
    shotInScene,
    shotType,
    actionPrompt,
    dialogue,
    soundEffects,
    cameraDirection,
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

	// Build video prompt from components
	const promptParts: string[] = [];
	if (actionPrompt) promptParts.push(actionPrompt);
	const dialoguePart = buildDialoguePrompt(dialogue, params.speaker, params.charactersPresent);
	if (dialoguePart) promptParts.push(dialoguePart);
	if (soundEffects) promptParts.push(`Sound effects: ${soundEffects}`);
	if (cameraDirection) promptParts.push(`Camera: ${cameraDirection}`);
	const videoPrompt = promptParts.join(". ");

  // Dry-run mode: return placeholder
  if (dryRun) {
    console.log(`[generateVideo] DRY-RUN: ${shotContext} (${shotType}, ${durationSeconds}s)`);
	  console.log(`[generateVideo] Prompt sent to API: ${videoPrompt}`);
	  return { shotNumber, path: outputPath, duration: durationSeconds, promptSent: videoPrompt };
  }

  if (!startFramePath) {
    throw new Error("Grok backend requires startFramePath");
  }

  console.log(`[generateVideo] Generating ${shotContext} via Grok (${shotType}, ${durationSeconds}s)`);
	console.log(`[generateVideo] Prompt sent to API: ${videoPrompt}`);

  // Convert start frame to base64 data URI
  const imageBuffer = readFileSync(startFramePath);
  const ext = startFramePath.toLowerCase().endsWith(".png") ? "png" : "jpeg";
  const dataUri = `data:image/${ext};base64,${imageBuffer.toString("base64")}`;

  // Clamp duration to Grok's supported range (1-15s)
  const clampedDuration = Math.max(1, Math.min(15, durationSeconds));

  try {
    // grok-client already handles retries with exponential backoff
    const result = await grokGenerateVideo(videoPrompt, {
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
	    return { shotNumber, path: result.path, duration: clampedDuration, promptSent: videoPrompt };
  } catch (error) {
    console.error(`[generateVideo] Error generating ${shotContext} via Grok:`, error);
    throw error;
  }
}