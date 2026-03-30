import { getGoogleClient } from "../google-client";
import type { Part } from "@google/genai";
import * as fs from "fs";
import * as path from "path";
import { rateLimiters } from "../queue/rate-limiter-registry.js";

// --- Structured video analysis (used by analyze_video work items) ---

export interface VideoRecommendation {
  type: 'redo_video' | 'redo_frame' | 'no_change';
  commentary: string;        // explains what the AI changed and why
  suggestedInputs?: {
    actionPrompt?: string;
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

export interface AnalyzeVideoClipOptions {
  videoPath: string;
  shotNumber: number;
  startFramePath: string;
  referenceImagePaths: string[];
  dialogue?: string;
  actionPrompt: string;
  durationSeconds: number;
  cameraDirection?: string;
  startFramePrompt?: string;
}

export function buildAnalyzeVideoPrompt(opts: Pick<AnalyzeVideoClipOptions, "shotNumber" | "dialogue" | "actionPrompt" | "durationSeconds" | "cameraDirection" | "startFramePrompt" | "referenceImagePaths">): string {
  return `Analyze this video clip (shot ${opts.shotNumber}, ${opts.durationSeconds}s) for quality and accuracy.

The intended action for this shot was: "${opts.actionPrompt}"
${opts.dialogue ? `Dialogue: "${opts.dialogue}"` : "No dialogue in this shot."}
Current camera direction: "${opts.cameraDirection || 'not specified'}"
Current start frame prompt: "${opts.startFramePrompt || 'not specified'}"

The first image after the video is the start frame that was used as input to generate this clip.
${opts.referenceImagePaths.length > 0 ? "The remaining images are character/location/object reference sheets from the asset library." : ""}

Evaluate:
1. How well does the generated video match the intended action and start frame?
2. Are there visual artifacts, glitches, or quality issues?
3. Do characters/objects match their reference images?
4. Is the pacing appropriate for the content?
5. Are there static/frozen frames or unnecessary repetition?

For each recommendation, provide a structured object with:
- "type": "redo_video" if only the video prompt needs changing, "redo_frame" if the start frame prompt needs changing, "no_change" if the shot is good
- "commentary": explain what you're changing and why
- "suggestedInputs": an object with the COMPLETE REWRITTEN values for any fields you want to change. Only include fields that need changes. Available fields: actionPrompt, dialogue, startFramePrompt, durationSeconds, cameraDirection.

IMPORTANT: When suggesting changes to actionPrompt or startFramePrompt, provide the FULL rewritten prompt, not just a description of what to change.

Return JSON:
{
  "matchScore": <0-100>,
  "issues": ["<specific issue 1>", "<specific issue 2>"],
  "recommendations": [
    {
      "type": "redo_video" | "redo_frame" | "no_change",
      "commentary": "<explanation of the change>",
      "suggestedInputs": {
        "actionPrompt": "<complete rewritten action prompt if changing>",
        "startFramePrompt": "<complete rewritten frame prompt if changing>"
      }
    }
  ]
}`;
}

export async function analyzeVideoClip(opts: AnalyzeVideoClipOptions): Promise<VideoClipAnalysis> {
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

  // Include start frame
  if (fs.existsSync(opts.startFramePath)) {
    const startFrameData = fs.readFileSync(opts.startFramePath);
    parts.push({
      inlineData: {
        mimeType: "image/png",
        data: startFrameData.toString("base64"),
      },
    });
  }

  // Include reference images from asset library
  for (const refPath of opts.referenceImagePaths) {
    if (fs.existsSync(refPath)) {
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
    text: buildAnalyzeVideoPrompt(opts),
  });

  const limiter = rateLimiters.get('gemini');
  await limiter.acquire();
  try {
    const response = await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts }],
      config: {
        responseMimeType: "application/json",
        temperature: 0.2,
      },
    });

    const text = response.text ?? "";
    const result = JSON.parse(text) as VideoClipAnalysis;
    result.matchScore = Math.max(0, Math.min(100, Math.round(result.matchScore)));
    return result;
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
