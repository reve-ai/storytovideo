import { z } from "zod";
import { mkdir } from "fs/promises";
import { readFileSync } from "fs";
import { join } from "path";
import { getGoogleClient } from "../google-client";
import { generateVideoGrok as grokGenerateVideo } from "../grok-client";
import { generateVideoLtx as ltxGenerateVideo, type LtxProgressInfo } from "../ltx-client";
import { rateLimiters } from "../queue/rate-limiter-registry.js";
import type { VideoBackend } from "../types";

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
  videoBackend?: VideoBackend;
  /** Aspect ratio for the generated video (e.g. "16:9", "9:16"). */
  aspectRatio?: string;
  /** Progress callback for UI updates */
  onProgress?: (message: string) => void;
  /** Version number for output filename (default 1). */
  version?: number;
  /** Queue priority — forwarded to backends that support it (e.g. LTX). */
  priority?: "normal" | "high";
  /** Progress callback for LTX backend — reports queue position and generation progress. */
  onLtxProgress?: (info: LtxProgressInfo) => void;
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
  const normalizedSpeaker = (speaker ?? "").trim().toLowerCase();
  if (normalizedSpeaker === "narrator" || normalizedSpeaker === "voiceover") {
    return `${normalizedSpeaker === "voiceover" ? "Voiceover" : "Narrator"} says: "${dialogue}"`;
  }

  const describePerson = (index: number, total: number): string => {
    if (total <= 1) return "the person";
    if (index === 0) return "the first person";
    if (index === 1) return "the second person";
    if (index === 2) return "the third person";
    return "one of the people";
  };

  let speakerLabel = "the person";
  let listenerLabel = "another person";

  if (charactersPresent && charactersPresent.length > 0) {
    const speakerIndex = charactersPresent.findIndex(c => c.trim().toLowerCase() === normalizedSpeaker);
    speakerLabel = speakerIndex >= 0
      ? describePerson(speakerIndex, charactersPresent.length)
      : charactersPresent.length > 1
        ? "one of the people"
        : "the person";

    if (charactersPresent.length > 1) {
      const listenerIndex = speakerIndex === 0 ? 1 : 0;
      listenerLabel = speakerIndex >= 0
        ? describePerson(listenerIndex, charactersPresent.length)
        : "another person";
    }
  }

  const subject = `${speakerLabel[0].toUpperCase()}${speakerLabel.slice(1)}`;
  if (charactersPresent && charactersPresent.length > 1) {
    return `${subject} looks at ${listenerLabel} and says: "${dialogue}"`;
  }

  return `${subject} says: "${dialogue}"`;
}


/**
 * Generates video clips for shots.
 * Dispatches to Veo 3.1 or Grok backend based on VIDEO_BACKEND env var.
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

  if (backend === "veo") {
    return generateVideoVeo(sanitized);
  } else if (backend === "grok") {
    return generateVideoGrok(sanitized);
  } else if (backend === "ltx-full") {
    return generateVideoLtxBackend(sanitized, "full");
  } else if (backend === "ltx-distilled") {
    return generateVideoLtxBackend(sanitized, "distilled");
  } else {
    throw new Error(`[generateVideo] Unknown VIDEO_BACKEND: "${backend}". Use "veo", "grok", "ltx-full", or "ltx-distilled".`);
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
          throw new Error("startFramePath required");
        }

        // Load start image as base64 (start frame)
        const startImageBuffer = readFileSync(startFramePath);
        const startImage = {
          imageBytes: startImageBuffer.toString("base64"),
          mimeType: "image/png",
        };

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
          } as any,
        });

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
    durationSeconds: z.number().describe("Video duration in seconds (0.5-15). Veo always uses 8; Grok supports 1-15."),
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

  if (dryRun) {
    console.log(`[generateVideo] DRY-RUN: ${shotContext} via LTX (${durationSeconds}s)`);
    console.log(`[generateVideo] Prompt sent to API: ${videoPrompt}`);
    return { shotNumber, path: outputPath, duration: durationSeconds, promptSent: videoPrompt };
  }

  console.log(`[generateVideo] Generating ${shotContext} via LTX (${durationSeconds}s)`);
  console.log(`[generateVideo] Prompt sent to API: ${videoPrompt}`);

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
    const result = await ltxGenerateVideo(videoPrompt, {
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
    return { shotNumber, path: result.path, duration: result.duration, promptSent: videoPrompt };
  } catch (error) {
    console.error(`[generateVideo] Error generating ${shotContext} via LTX:`, error);
    throw error;
  }
}