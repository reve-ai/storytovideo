import { z } from "zod";
import { readFileSync } from "fs";
import { getGoogleClient } from "../google-client";

/** Input for a single shot to analyze */
export interface ShotFrameInput {
  shotNumber: number;
  firstFramePath: string;
  lastFramePath: string;
}

/** Output from analyzing a single shot */
export interface ShotAnalysisResult {
  shotNumber: number;
  composition: string;
  actionPrompt: string;
  startFramePrompt: string;
  endFramePrompt: string;
}

const VISION_PROMPT = `You are a visual video analyzer. You are given the FIRST frame and LAST frame of a short video shot.
Based on these two images, describe the shot.

Rules:
- Use visual descriptions for characters (e.g., 'the tall man in the blue jacket', 'the woman with red hair') instead of character names.
- Describe what you SEE, not what you infer about the narrative.
- Be specific about clothing, posture, lighting, and environment.
- For composition, choose one of: wide_establishing, close_up, medium_shot, over_the_shoulder, two_shot, tracking, pov, insert_cutaway, low_angle, high_angle.

Output strictly valid JSON with no markdown block around it, containing the following keys:
{
  "composition": "medium_shot",
  "actionPrompt": "A visual description of the motion/change between the first and last frame.",
  "startFramePrompt": "A detailed visual description of the first frame.",
  "endFramePrompt": "A detailed visual description of the last frame."
}`;

function encodeImage(imagePath: string): string {
  const buffer = readFileSync(imagePath);
  return buffer.toString("base64");
}

function getMimeType(filePath: string): string {
  const ext = filePath.toLowerCase().split(".").pop();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function analyzeSingleShot(
  firstFramePath: string,
  lastFramePath: string,
): Promise<{ composition: string; actionPrompt: string; startFramePrompt: string; endFramePrompt: string }> {
  const client = getGoogleClient();

  const firstB64 = encodeImage(firstFramePath);
  const lastB64 = encodeImage(lastFramePath);

  const response = await client.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          { text: VISION_PROMPT },
          { text: "FIRST FRAME:" },
          { inlineData: { mimeType: getMimeType(firstFramePath), data: firstB64 } },
          { text: "LAST FRAME:" },
          { inlineData: { mimeType: getMimeType(lastFramePath), data: lastB64 } },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      temperature: 0.2,
    },
  });

  const text = response.text ?? "";
  return JSON.parse(text);
}

/**
 * Analyzes an array of shots by sending first/last frame pairs to Gemini Flash vision model.
 * Processes sequentially with rate limiting and retry logic.
 * Returns partial results if interrupted — already-analyzed shots are preserved.
 */
export async function analyzeShots(
  shots: ShotFrameInput[],
  onProgress?: (result: ShotAnalysisResult, index: number, total: number) => void,
): Promise<ShotAnalysisResult[]> {
  const results: ShotAnalysisResult[] = [];
  const maxRetries = 3;

  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`Analyzing shot ${shot.shotNumber} (${i + 1}/${shots.length}), attempt ${attempt}...`);
        const analysis = await analyzeSingleShot(shot.firstFramePath, shot.lastFramePath);

        const result: ShotAnalysisResult = {
          shotNumber: shot.shotNumber,
          composition: analysis.composition || "medium_shot",
          actionPrompt: analysis.actionPrompt || "",
          startFramePrompt: analysis.startFramePrompt || "",
          endFramePrompt: analysis.endFramePrompt || "",
        };

        results.push(result);
        onProgress?.(result, i, shots.length);
        lastError = null;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.error(`Error analyzing shot ${shot.shotNumber} (attempt ${attempt}/${maxRetries}): ${lastError.message}`);
        if (attempt < maxRetries) {
          await sleep(2000);
        }
      }
    }

    if (lastError) {
      console.error(`Failed to analyze shot ${shot.shotNumber} after ${maxRetries} attempts. Continuing with remaining shots.`);
    }

    // Rate limiting: 1s delay between API calls (skip after last shot)
    if (i < shots.length - 1) {
      await sleep(1000);
    }
  }

  return results;
}

/**
 * Vercel AI SDK tool definition for analyzeShots.
 */
export const analyzeShotsTool = {
  description: "Analyze video shots by sending first/last frame pairs to a vision model to get composition, action, and frame descriptions",
  parameters: z.object({
    shots: z.array(z.object({
      shotNumber: z.number(),
      firstFramePath: z.string(),
      lastFramePath: z.string(),
    })),
  }),
};

