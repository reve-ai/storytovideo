import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";

const execFileAsync = promisify(execFile);

export interface ShotInfo {
  shotNumber: number;
  clipPath: string;
  firstFramePath: string;
  lastFramePath: string;
  audioPath: string | null;
  durationSeconds: number;
}

/**
 * Check that ffmpeg and ffprobe are available on PATH.
 */
async function ensureFfmpeg(): Promise<void> {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    await execFileAsync("ffprobe", ["-version"]);
  } catch {
    throw new Error(
      "ffmpeg/ffprobe not found on PATH. Install ffmpeg: https://ffmpeg.org/download.html"
    );
  }
}

/**
 * Get duration of a media file in seconds via ffprobe.
 */
export async function probeDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  return parseFloat(stdout.trim());
}

/**
 * Check whether a file has an audio stream.
 */
async function hasAudioStream(filePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "a",
      "-show_entries", "stream=codec_type",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Run ffmpeg scene detection and return an array of cut timestamps (seconds).
 */
async function detectScenes(
  videoPath: string,
  threshold: number,
): Promise<number[]> {
  const { stderr } = await execFileAsync("ffmpeg", [
    "-i", videoPath,
    "-vf", `select='gt(scene,${threshold})',showinfo`,
    "-f", "null",
    "-",
  ], { maxBuffer: 50 * 1024 * 1024 });

  const timestamps: number[] = [];
  // showinfo lines contain pts_time:FLOAT
  const regex = /pts_time:\s*([\d.]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(stderr)) !== null) {
    timestamps.push(parseFloat(match[1]));
  }
  return timestamps;
}

/**
 * Split a video into clips, extract frames and audio for each.
 */
export async function splitVideo(params: {
  videoPath: string;
  outputDir: string;
  sceneThreshold?: number;
}): Promise<ShotInfo[]> {
  const { videoPath, outputDir, sceneThreshold = 0.1 } = params;

  await ensureFfmpeg();

  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  const importDir = path.join(outputDir, "import");
  fs.mkdirSync(importDir, { recursive: true });

  const totalDuration = await probeDuration(videoPath);
  const cutPoints = await detectScenes(videoPath, sceneThreshold);

  // Build segment boundaries: [0, cut1, cut2, ..., totalDuration]
  const boundaries = [0, ...cutPoints, totalDuration];
  // Deduplicate and sort
  const unique = [...new Set(boundaries)].sort((a, b) => a - b);

  // Build segments
  type Segment = { start: number; end: number };
  const segments: Segment[] = [];
  for (let i = 0; i < unique.length - 1; i++) {
    const start = unique[i];
    const end = unique[i + 1];
    if (end - start >= 0.1) { // skip degenerate segments
      segments.push({ start, end });
    }
  }

  // If no segments (shouldn't happen, but safety), treat whole video as one shot
  if (segments.length === 0) {
    segments.push({ start: 0, end: totalDuration });
  }

  // Filter out very short clips (<0.5s) unless it's the only segment
  const filtered =
    segments.length === 1
      ? segments
      : segments.filter((s) => s.end - s.start >= 0.5);
  const finalSegments = filtered.length > 0 ? filtered : segments;

  const sourceHasAudio = await hasAudioStream(videoPath);
  const shots: ShotInfo[] = [];

  for (let i = 0; i < finalSegments.length; i++) {
    const seg = finalSegments[i];
    const num = String(i + 1).padStart(3, "0");
    const clipPath = path.join(importDir, `scene_${num}.mp4`);
    const firstFramePath = path.join(importDir, `scene_${num}_first.jpg`);
    const lastFramePath = path.join(importDir, `scene_${num}_last.jpg`);
    const audioPath = path.join(importDir, `scene_${num}_audio.aac`);

    // 1. Extract clip
    await execFileAsync("ffmpeg", [
      "-y", "-i", videoPath,
      "-ss", String(seg.start),
      "-to", String(seg.end),
      "-c:v", "libx264", "-preset", "fast", "-crf", "18",
      ...(sourceHasAudio ? ["-c:a", "aac"] : ["-an"]),
      clipPath,
    ]);

    // 2. First frame (-strict unofficial handles non-full-range YUV → MJPEG)
    await execFileAsync("ffmpeg", [
      "-y", "-ss", String(seg.start),
      "-i", videoPath,
      "-frames:v", "1",
      "-q:v", "2",
      "-strict", "unofficial",
      firstFramePath,
    ]);

    // 3. Last frame using -sseof trick on the clip (fallback: copy first frame)
    try {
      await execFileAsync("ffmpeg", [
        "-y", "-sseof", "-0.1",
        "-i", clipPath,
        "-frames:v", "1",
        "-q:v", "2",
        "-strict", "unofficial",
        lastFramePath,
      ]);
      // ffmpeg may exit 0 but produce no output for very short clips
      if (!fs.existsSync(lastFramePath) || fs.statSync(lastFramePath).size === 0) {
        throw new Error("Empty or missing output");
      }
    } catch {
      // Clip too short for -sseof — duplicate the first frame
      console.log(`[split-video] Last frame extraction failed for scene_${num}, copying first frame`);
      fs.copyFileSync(firstFramePath, lastFramePath);
    }

    // 4. Audio extraction
    let finalAudioPath: string | null = null;
    if (sourceHasAudio) {
      try {
        await execFileAsync("ffmpeg", [
          "-y", "-i", clipPath,
          "-vn", "-acodec", "aac",
          audioPath,
        ]);
        finalAudioPath = audioPath;
      } catch {
        // No audio in this clip — leave null
      }
    }

    // 5. Measure actual clip duration
    const actualDuration = await probeDuration(clipPath);

    shots.push({
      shotNumber: i + 1,
      clipPath,
      firstFramePath,
      lastFramePath,
      audioPath: finalAudioPath,
      durationSeconds: Math.round(actualDuration * 1000) / 1000,
    });
  }

  return shots;
}

/**
 * Vercel AI SDK tool definition for splitVideo.
 */
export const splitVideoTool = {
  description:
    "Split a video into scene clips using ffmpeg scene detection. Extracts first/last frames, audio, and measures duration for each clip.",
  parameters: z.object({
    videoPath: z.string().describe("Path to the input video file"),
    outputDir: z.string().describe("Output directory (clips go into {outputDir}/import/)"),
    sceneThreshold: z
      .number()
      .optional()
      .describe("Scene detection threshold (0-1, default 0.1). Lower = more sensitive"),
  }),
};

