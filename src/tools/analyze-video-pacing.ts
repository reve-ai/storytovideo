import { getGoogleClient } from "../google-client";
import type { Part } from "@google/genai";
import * as fs from "fs";
import * as path from "path";
import { rateLimiters } from "../queue/rate-limiter-registry.js";
import {
  ANALYZE_VIDEO_CRITERIA,
  ANALYZE_VIDEO_ADDITIONAL_CHECKS,
  ANALYZE_VIDEO_REPLACEMENT_RULES,
  ANALYZE_VIDEO_RESPONSE_FORMAT,
} from "../prompts.js";

// --- Structured video analysis (used by analyze_video work items) ---

export interface VideoRecommendation {
  type: 'redo_video' | 'redo_frame' | 'no_change';
  commentary: string;        // explains what the AI changed and why
  suggestedInputs?: {
    videoPrompt?: string;
    dialogue?: string;
    startFramePrompt?: string;
    durationSeconds?: number;
    cameraDirection?: string;
  };
}

export interface VideoClipAnalysis {
  matchScore: number;            // 0-100, how well the video matches the intended shot
  issues: string[];              // list of specific issues found
  recommendations: VideoRecommendation[];
}

export interface AnalyzeVideoResult {
  analysis: VideoClipAnalysis;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface AnalyzeVideoClipOptions {
  videoPath: string;
  shotNumber: number;
  startFramePath: string;
  referenceImagePaths: string[];
  dialogue?: string;
  videoPrompt: string;
  durationSeconds: number;
  cameraDirection?: string;
  startFramePrompt?: string;
}

export function buildAnalyzeVideoPrompt(opts: Pick<AnalyzeVideoClipOptions, "shotNumber" | "dialogue" | "videoPrompt" | "durationSeconds" | "cameraDirection" | "startFramePrompt" | "referenceImagePaths"> & { hasStartFrame: boolean }): string {
  return `Analyze this video clip (shot ${opts.shotNumber}, ${opts.durationSeconds}s) for quality and accuracy.

The video direction was: "${opts.videoPrompt}"
${opts.dialogue ? `Dialogue: "${opts.dialogue}"` : "No dialogue in this shot."}
Current camera direction: "${opts.cameraDirection || 'not specified'}"
Current start frame prompt: "${opts.startFramePrompt || 'not specified'}"

${opts.hasStartFrame
    ? "The images are labeled with text markers: START FRAME and REFERENCE IMAGES. The start frame is the image that was used as input to generate this clip."
    : "No start frame available for comparison — it was missing at analysis time."}
${opts.referenceImagePaths.length > 0 ? "Reference images are character/location/object reference sheets from the asset library." : ""}

${ANALYZE_VIDEO_CRITERIA}

${ANALYZE_VIDEO_ADDITIONAL_CHECKS}

${ANALYZE_VIDEO_REPLACEMENT_RULES}

${ANALYZE_VIDEO_RESPONSE_FORMAT}`;
}

export async function analyzeVideoClip(opts: AnalyzeVideoClipOptions): Promise<AnalyzeVideoResult> {
  const client = getGoogleClient();

  const videoData = fs.readFileSync(opts.videoPath);
  const videoB64 = videoData.toString("base64");

  console.log(`[analyze_video] Analyzing shot ${opts.shotNumber}: ${opts.videoPath} (${(videoData.length / 1024 / 1024).toFixed(1)}MB)`);

  const parts: Part[] = [
    {
      inlineData: {
        mimeType: "video/mp4",
        data: videoB64,
      },
    },
  ];

  // Include start frame with explicit label
  const hasStartFrame = fs.existsSync(opts.startFramePath);
  if (hasStartFrame) {
    parts.push({ text: "START FRAME:" });
    const startFrameData = fs.readFileSync(opts.startFramePath);
    parts.push({
      inlineData: {
        mimeType: "image/png",
        data: startFrameData.toString("base64"),
      },
    });
  } else {
    console.warn(`[analyze_video] WARNING: Start frame not found at ${opts.startFramePath} — analysis will proceed without start frame comparison`);
  }

  // Include reference images from asset library with explicit label
  const existingRefPaths = opts.referenceImagePaths.filter(p => fs.existsSync(p));
  if (existingRefPaths.length > 0) {
    parts.push({ text: "REFERENCE IMAGES:" });
    for (const refPath of existingRefPaths) {
      const refData = fs.readFileSync(refPath);
      const ext = path.extname(refPath).toLowerCase();
      const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
      parts.push({
        inlineData: {
          mimeType,
          data: refData.toString("base64"),
        },
      });
    }
  }

  parts.push({
    text: buildAnalyzeVideoPrompt({ ...opts, hasStartFrame }),
  });

  const limiter = rateLimiters.get('gemini');
  await limiter.acquire();
  try {
    const response = await client.models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: [{ role: "user", parts }],
      config: {
        responseMimeType: "application/json",
        temperature: 0.2,
      },
    });

    const text = response.text ?? "";
    const result = JSON.parse(text) as VideoClipAnalysis;
    result.matchScore = Math.max(0, Math.min(100, Math.round(result.matchScore)));

    // Extract token usage from Gemini response
    const usageMeta = (response as any).usageMetadata;
    const usage = usageMeta
      ? { promptTokens: usageMeta.promptTokenCount ?? 0, completionTokens: usageMeta.candidatesTokenCount ?? 0 }
      : undefined;

    return { analysis: result, usage };
  } catch (error: any) {
    if (error?.status === 429 || error?.message?.includes('429') || error?.message?.includes('RESOURCE_EXHAUSTED')) {
      const retryMs = 5000;
      console.warn(`[analyzeVideoClip] 429 rate limited — backing off all gemini workers for ${retryMs}ms`);
      limiter.backoff(retryMs);
    }
    throw error;
  } finally {
    limiter.release();
  }
}
