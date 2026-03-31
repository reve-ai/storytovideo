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

Evaluate:
1. How well does the generated video match the intended direction and start frame?
2. Are there visual artifacts, glitches, or quality issues?
3. Do characters/objects match their reference images?
4. Is the pacing appropriate for the content?
5. Are there static/frozen frames or unnecessary repetition?

For each recommendation, provide a structured object with:
- "type": "redo_video" if only the video prompt needs changing, "redo_frame" if the start frame prompt needs changing, "no_change" if the shot is good
- "commentary": explain what you're changing and why
- "suggestedInputs": an object with the COMPLETE REWRITTEN values for any fields you want to change. Only include fields that need changes. Available fields: videoPrompt, dialogue, startFramePrompt, durationSeconds, cameraDirection.

Additional checks:
6. Are there any people visible who are NOT in the reference images? Flag unwanted humans (waiters, background diners, staff, extras).
7. Is there audible music or soundtrack in the video? There should be none — only ambient sounds and dialogue.
8. Do characters look directly at the camera? They should never appear aware of the camera.
9. Do any faces appear mid-shot that were not visible in the start frame? The video model cannot generate correct faces from scratch.

IMPORTANT: When suggesting changes to videoPrompt or startFramePrompt, provide the FULL rewritten prompt, not just a description of what to change.

CRITICAL RULES FOR REPLACEMENT PROMPTS: When writing suggestedInputs for videoPrompt or startFramePrompt:
- NEVER mention any human figure not in the reference images (no waiters, background diners, staff, extras)
- NEVER mention music, jazz, soundtrack, or any musical element — only non-musical ambient sounds
- NEVER describe a character's face being revealed if it was not visible in the start frame (no turning around, no walking into frame face-first)
- Characters must NEVER look at the camera
- Use visual descriptors ('the man', 'the woman') not character names in videoPrompt

Return JSON:
{
  "matchScore": <0-100>,
  "issues": ["<specific issue 1>", "<specific issue 2>"],
  "recommendations": [
    {
      "type": "redo_video" | "redo_frame" | "no_change",
      "commentary": "<explanation of the change>",
      "suggestedInputs": {
        "videoPrompt": "<complete rewritten video prompt if changing>",
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
