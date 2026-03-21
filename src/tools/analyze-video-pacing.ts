import { getGoogleClient } from "../google-client";
import { FileState } from "@google/genai";
import * as fs from "fs";


export interface TrimRecommendation {
  totalDuration: number;
  recommendedDuration: number;
  shots: Array<{
    shotIndex: number;
    currentStart: number;
    currentEnd: number;
    description: string;
    shouldTrim: boolean;
    trimStart: number | null;
    trimEnd: number | null;
    trimReason: string | null;
    confidence: "high" | "medium" | "low";
  }>;
}

async function uploadVideoToGemini(videoPath: string): Promise<string> {
  const client = getGoogleClient();

  // Upload using the File API
  const uploadResult = await client.files.upload({
    file: videoPath,
    config: {
      mimeType: "video/mp4",
    },
  });

  console.log(`[pacing] Uploaded video: ${uploadResult.name}`);

  // Wait for processing
  let file = await client.files.get({ name: uploadResult.name! });
  while (file.state === FileState.PROCESSING) {
    console.log("[pacing] Waiting for video processing...");
    await new Promise((r) => setTimeout(r, 5000));
    file = await client.files.get({ name: uploadResult.name! });
  }

  if (file.state === FileState.FAILED) {
    throw new Error("Video processing failed");
  }

  console.log(`[pacing] Video ready (state: ${file.state})`);
  return uploadResult.name!;
}

export async function analyzeVideoPacing(
  videoPath: string,
  shotPlan?: any,
): Promise<TrimRecommendation> {
  const client = getGoogleClient();

  const fileName = await uploadVideoToGemini(videoPath);

  const shotContext = shotPlan
    ? `\n\nHere is the shot plan with intended durations:\n${JSON.stringify(shotPlan, null, 2)}`
    : "";

  const response = await client.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          {
            fileData: {
              fileUri: `https://generativelanguage.googleapis.com/v1beta/${fileName}`,
              mimeType: "video/mp4",
            },
          },
          {
            text: `You are a professional video editor analyzing this video for pacing improvements.

The video is composed of multiple shots/scenes concatenated together. Many shots feel too long and could benefit from trimming.

For each distinct shot/scene in the video, provide:
1. The approximate start and end timestamp of the shot as it appears in the video
2. A brief description of what's happening in the shot
3. Whether it should be trimmed, and if so:
   - Recommended new start time (trim from beginning)
   - Recommended new end time (trim from end)
   - Reason for the trim (e.g., "static opening with no action", "repetitive movement at end", "holds too long on same frame")
4. Confidence level (high/medium/low)

Focus on:
- Removing static/frozen frames at the start or end of shots
- Cutting repetitive or redundant motion
- Tightening pacing where the action has clearly concluded but the shot continues
- Maintaining narrative flow and not cutting important dialogue or action

Return your analysis as JSON:${shotContext}

\`\`\`json
{
  "totalDuration": <current total in seconds>,
  "recommendedDuration": <estimated total after trims>,
  "shots": [
    {
      "shotIndex": 1,
      "currentStart": <seconds>,
      "currentEnd": <seconds>,
      "description": "...",
      "shouldTrim": true/false,
      "trimStart": <new start seconds or null>,
      "trimEnd": <new end seconds or null>,
      "trimReason": "..." or null,
      "confidence": "high"/"medium"/"low"
    }
  ]
}
\`\`\``,
          },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      temperature: 0.2,
    },
  });

  const text = response.text ?? "";
  console.log("[pacing] Raw response:", text);

  try {
    const result = JSON.parse(text) as TrimRecommendation;
    return result;
  } catch {
    console.error("[pacing] Failed to parse response as JSON");
    return text as any;
  }
}

// CLI entry point
const isCli =
  process.argv[1]?.endsWith("analyze-video-pacing.ts") ||
  process.argv[1]?.endsWith("analyze-video-pacing.js");

if (isCli) {
  await import("dotenv/config");
  const videoPath = process.argv[2] || "output/thelastquestion.mp4";

  if (!fs.existsSync(videoPath)) {
    console.error(`Video not found: ${videoPath}`);
    process.exit(1);
  }

  console.log(`[pacing] Analyzing: ${videoPath}`);
  const result = await analyzeVideoPacing(videoPath);
  console.log("\n=== TRIM RECOMMENDATIONS ===");
  console.log(JSON.stringify(result, null, 2));
}

