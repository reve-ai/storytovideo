import { getGoogleClient } from "../google-client";
import { FileState } from "@google/genai";
import * as fs from "fs";
import * as path from "path";


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

export interface ClipAnalysis {
  shotNumber: number;
  currentDuration: number;
  recommendedDuration: number;
  trimFromStart: number;
  trimFromEnd: number;
  reason: string;
  confidence: "high" | "medium" | "low";
  hasStaticOpening: boolean;
  hasStaticEnding: boolean;
  actionCompletesEarly: boolean;
}

export async function analyzeClipPacing(
  clipPath: string,
  shotNumber: number,
  originalDuration: number,
): Promise<ClipAnalysis> {
  const client = getGoogleClient();

  const videoData = fs.readFileSync(clipPath);
  const b64 = videoData.toString("base64");

  console.log(`[pacing] Analyzing clip: ${clipPath} (${(videoData.length / 1024 / 1024).toFixed(1)}MB)`);

  const response = await client.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: "video/mp4",
              data: b64,
            },
          },
          {
            text: `Analyze this video clip (shot ${shotNumber}, ${originalDuration}s) for pacing.

This clip is one shot from a larger video. Evaluate whether it could be shorter.

Look for:
- Static/frozen frames at the start or end
- Repetitive or redundant motion
- The action completing before the clip ends
- Unnecessary pauses or holds

Return JSON:
\`\`\`json
{
  "shotNumber": ${shotNumber},
  "currentDuration": ${originalDuration},
  "recommendedDuration": <number - how long this clip should be>,
  "trimFromStart": <seconds to trim from beginning, 0 if none>,
  "trimFromEnd": <seconds to trim from end, 0 if none>,
  "reason": "<brief explanation>",
  "confidence": "high" | "medium" | "low",
  "hasStaticOpening": <boolean>,
  "hasStaticEnding": <boolean>,
  "actionCompletesEarly": <boolean>
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
  return JSON.parse(text);
}

export async function getClipDuration(clipPath: string): Promise<number> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "quiet",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    clipPath,
  ]);
  return parseFloat(stdout.trim());
}

export async function analyzeAllClips(
  clipsDir: string,
): Promise<ClipAnalysis[]> {
  const files = fs.readdirSync(clipsDir)
    .filter(f => f.match(/^shot_\d+\.mp4$/))
    .sort();

  console.log(`[pacing] Found ${files.length} clips to analyze`);

  const results: ClipAnalysis[] = [];
  for (const file of files) {
    const shotNumber = parseInt(file.match(/shot_(\d+)/)?.[1] ?? "0", 10);
    const clipPath = path.join(clipsDir, file);

    // Get duration with ffprobe
    const duration = await getClipDuration(clipPath);

    try {
      const analysis = await analyzeClipPacing(clipPath, shotNumber, duration);
      results.push(analysis);
      console.log(`[pacing] Shot ${shotNumber}: ${duration}s → ${analysis.recommendedDuration}s (${analysis.reason})`);
    } catch (err) {
      console.error(`[pacing] Failed to analyze shot ${shotNumber}:`, err);
    }
  }

  const totalCurrent = results.reduce((sum, r) => sum + r.currentDuration, 0);
  const totalRecommended = results.reduce((sum, r) => sum + r.recommendedDuration, 0);
  console.log(`\n[pacing] Total: ${totalCurrent}s → ${totalRecommended}s (save ${totalCurrent - totalRecommended}s)`);

  return results;
}

// CLI entry point
const isCli =
  process.argv[1]?.endsWith("analyze-video-pacing.ts") ||
  process.argv[1]?.endsWith("analyze-video-pacing.js");

if (isCli) {
  await import("dotenv/config");
  const target = process.argv[2] || "output/runs/3eeda4d3-7ca2-4a8c-8f29-638139b390e2/videos";

  if (!fs.existsSync(target)) {
    console.error(`Target not found: ${target}`);
    process.exit(1);
  }

  if (fs.statSync(target).isDirectory()) {
    // Analyze all clips in directory
    const results = await analyzeAllClips(target);
    console.log("\n=== CLIP ANALYSIS ===");
    console.log(JSON.stringify(results, null, 2));
  } else {
    // Single file - use original full video analysis
    console.log(`[pacing] Analyzing full video: ${target}`);
    const result = await analyzeVideoPacing(target);
    console.log("\n=== TRIM RECOMMENDATIONS ===");
    console.log(JSON.stringify(result, null, 2));
  }
}

