import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";

const execFileAsync = promisify(execFile);

/**
 * Get the duration of a video file in seconds using ffprobe.
 */
async function getVideoDuration(videoPath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ]);
    return parseFloat(stdout.trim());
  } catch (error) {
    console.error(`Failed to get duration for ${videoPath}:`, error);
    throw error;
  }
}

/**
 * Map transition type to ffmpeg xfade transition name.
 */
function getXfadeTransitionName(transitionType: string): string {
  const mapping: Record<string, string> = {
    "fade_black": "fadeblack",
  };
  return mapping[transitionType] || "fadeblack";
}

/**
 * Format seconds to ASS timestamp format: H:MM:SS.CC (centiseconds).
 */
function formatAssTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const wholeSec = Math.floor(s);
  const centiseconds = Math.round((s - wholeSec) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(wholeSec).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

/**
 * Generate an ASS subtitle file from subtitle entries.
 * Styling: white text, black outline (2px), bottom-center, ~32px font, semi-transparent black background.
 */
export function generateAssFile(
  subtitles: Array<{ startSec: number; endSec: number; text: string }>,
  outputPath: string,
): string {
  const assContent = `[Script Info]
Title: Story Subtitles
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,32,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,3,2,0,2,20,20,30,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${subtitles.map((sub) => {
    // Escape special ASS characters: braces (override tag delimiters) and line breaks
    const escapedText = sub.text
      .replace(/\{/g, "\\{")
      .replace(/\}/g, "\\}")
      .replace(/\n/g, "\\N");
    return `Dialogue: 0,${formatAssTime(sub.startSec)},${formatAssTime(sub.endSec)},Default,,0,0,0,,${escapedText}`;
  }).join("\n")}
`;

  fs.writeFileSync(outputPath, assContent);
  return outputPath;
}

/**
 * Burn ASS subtitles into a video file using ffmpeg's ass filter.
 * Replaces the input file with the subtitled version.
 */
export async function burnSubtitles(videoPath: string, assPath: string): Promise<void> {
  const dir = path.dirname(videoPath);
  const ext = path.extname(videoPath);
  const base = path.basename(videoPath, ext);
  const tempPath = path.join(dir, `${base}_subtitled${ext}`);

  // Escape special characters in the ASS path for ffmpeg filter syntax.
  // execFile bypasses the shell, so we only need ffmpeg filter-level escaping.
  const escapedAssPath = assPath
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:");

  await execFileAsync("ffmpeg", [
    "-i", videoPath,
    "-vf", `ass=${escapedAssPath}`,
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "23",
    "-c:a", "copy",
    "-y",
    tempPath,
  ]);

  // Replace original with subtitled version
  fs.renameSync(tempPath, videoPath);
}

/**
 * Format seconds to SRT timestamp format: HH:MM:SS,mmm.
 */
function formatSrtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

/**
 * Generate an SRT subtitle file from subtitle entries.
 */
function generateSrtFile(
  subtitles: Array<{ startSec: number; endSec: number; text: string }>,
  outputPath: string,
): string {
  const srtContent = subtitles.map((sub, i) => {
    return `${i + 1}
${formatSrtTime(sub.startSec)} --> ${formatSrtTime(sub.endSec)}
${sub.text}
`;
  }).join("\n");

  fs.writeFileSync(outputPath, srtContent);
  return outputPath;
}

/**
 * Embed subtitles as a soft/native subtitle track (mov_text) into an MP4 video.
 * Uses -c:v copy -c:a copy so no re-encoding occurs — this is near-instant.
 * Replaces the input file with the subtitled version.
 */
async function embedSubtitleTrack(videoPath: string, srtPath: string): Promise<void> {
  const dir = path.dirname(videoPath);
  const ext = path.extname(videoPath);
  const base = path.basename(videoPath, ext);
  const tempPath = path.join(dir, `${base}_subtitled${ext}`);

  await execFileAsync("ffmpeg", [
    "-i", videoPath,
    "-i", srtPath,
    "-c:v", "copy",      // No re-encoding of video
    "-c:a", "copy",      // No re-encoding of audio
    "-c:s", "mov_text",  // MP4 native subtitle format
    "-metadata:s:s:0", "language=eng",
    "-y",
    tempPath,
  ]);

  // Replace original with subtitled version
  fs.renameSync(tempPath, videoPath);
}

/**
 * Overlay imported audio onto a video clip using ffmpeg.
 * If the audio is shorter than the video, it is padded with silence.
 * If the audio is longer, it is trimmed to match the video duration.
 * Returns the path to the new video file with audio mixed in.
 */
async function overlayAudio(
  videoPath: string,
  audioPath: string,
  outputPath: string,
): Promise<string> {
  const videoDuration = await getVideoDuration(videoPath);

  // Mix imported audio with any existing audio track.
  // Use amix to combine, or just add the audio if the video has none.
  // The imported audio is trimmed/padded to match video duration.
  await execFileAsync("ffmpeg", [
    "-y",
    "-i", videoPath,
    "-i", audioPath,
    "-filter_complex",
    `[1:a]apad=whole_dur=${videoDuration},atrim=0:${videoDuration}[imported];[0:a][imported]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
    "-map", "0:v",
    "-map", "[aout]",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "128k",
    "-shortest",
    outputPath,
  ]).catch(async () => {
    // Fallback: video may have no audio track — just add the imported audio directly
    await execFileAsync("ffmpeg", [
      "-y",
      "-i", videoPath,
      "-i", audioPath,
      "-filter_complex",
      `[1:a]apad=whole_dur=${videoDuration},atrim=0:${videoDuration}[aout]`,
      "-map", "0:v",
      "-map", "[aout]",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "128k",
      "-shortest",
      outputPath,
    ]);
  });

  return outputPath;
}

/**
 * Assembles multiple video clips into a single final video with optional scene transitions.
 * Uses ffmpeg xfade filter for transitions, or concat demuxer for all-cut videos.
 * Optionally embeds subtitles as a soft/native subtitle track (no re-encoding).
 * When importedAudio is provided, overlays per-clip audio before assembly.
 * Returns the path to the final assembled video.
 */
export async function assembleVideo(params: {
  videoPaths: string[];
  transitions?: Array<{ type: "cut" | "fade_black"; durationMs: number }>;
  subtitles?: Array<{ startSec: number; endSec: number; text: string }>;
  importedAudio?: Record<number, string>;
  outputDir: string;
  outputFile?: string;
  dryRun?: boolean;
}): Promise<{ path: string }> {
  const {
    videoPaths,
    transitions = [],
    subtitles = [],
    importedAudio,
    outputDir,
    outputFile = "final.mp4",
    dryRun = false,
  } = params;

  if (!videoPaths || videoPaths.length === 0) {
    throw new Error("No video paths provided for assembly");
  }

  // Dry-run mode: return mock path without calling ffmpeg
  if (dryRun) {
    const mockPath = path.join(outputDir, outputFile);
    console.log(`[dry-run] Would assemble ${videoPaths.length} videos into ${mockPath}`);
    if (subtitles.length > 0) {
      const srtPath = path.join(outputDir, "subtitles.srt");
      generateSrtFile(subtitles, srtPath);
      console.log(`[dry-run] Generated subtitle file: ${srtPath} (${subtitles.length} entries)`);
    }
    return { path: mockPath };
  }

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  // Overlay imported audio per-clip when available
  let finalVideoPaths = videoPaths;
  if (importedAudio && Object.keys(importedAudio).length > 0) {
    finalVideoPaths = [];
    for (let i = 0; i < videoPaths.length; i++) {
      const shotNumber = i + 1; // videoPaths are ordered by shot number
      const audioPath = importedAudio[shotNumber];
      if (audioPath && fs.existsSync(audioPath)) {
        const ext = path.extname(videoPaths[i]);
        const base = path.basename(videoPaths[i], ext);
        const mixedPath = path.join(outputDir, `${base}_mixed${ext}`);
        console.log(`[assembly] Overlaying imported audio for shot ${shotNumber}`);
        await overlayAudio(videoPaths[i], audioPath, mixedPath);
        finalVideoPaths.push(mixedPath);
      } else {
        finalVideoPaths.push(videoPaths[i]);
      }
    }
  }

  const outputPath = path.join(outputDir, outputFile);

  // Check if all transitions are "cut" (no xfade needed)
  const hasTransitions = transitions.length > 0 && transitions.some(t => t.type !== "cut");

  let result: { path: string };
  if (!hasTransitions) {
    // Use fast concat demuxer for all-cut videos
    result = await assembleWithConcat(finalVideoPaths, outputPath);
  } else {
    // Use xfade filter for videos with transitions
    result = await assembleWithXfade(finalVideoPaths, transitions, outputPath);
  }

  // Embed subtitles as a soft subtitle track (toggleable in players)
  if (subtitles.length > 0) {
    const srtPath = path.join(outputDir, "subtitles.srt");
    generateSrtFile(subtitles, srtPath);
    console.log(`[assembly] Generated subtitle file: ${srtPath} (${subtitles.length} entries)`);
    await embedSubtitleTrack(result.path, srtPath);
    console.log(`[assembly] Embedded subtitle track into ${result.path}`);
  }

  return result;
}

/**
 * Assemble videos using ffmpeg concat demuxer (fast, no re-encoding).
 */
async function assembleWithConcat(videoPaths: string[], outputPath: string): Promise<{ path: string }> {
  const concatListPath = path.join(path.dirname(outputPath), ".concat_list.txt");
  const concatContent = videoPaths
    .map((videoPath) => `file '${path.resolve(videoPath)}'`)
    .join("\n");

  fs.writeFileSync(concatListPath, concatContent);

  try {
    await execFileAsync("ffmpeg", [
      "-f", "concat",
      "-safe", "0",
      "-i", concatListPath,
      "-c", "copy",
      "-y",
      outputPath,
    ]);
    return { path: outputPath };
  } finally {
    try {
      fs.unlinkSync(concatListPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Assemble videos using ffmpeg xfade filter (requires re-encoding).
 */
async function assembleWithXfade(
  videoPaths: string[],
  transitions: Array<{ type: string; durationMs: number }>,
  outputPath: string,
): Promise<{ path: string }> {
  // Get durations for all videos
  const durations: number[] = [];
  for (const videoPath of videoPaths) {
    const duration = await getVideoDuration(videoPath);
    durations.push(duration);
  }

  // Build filter_complex string with chained xfade filters
  let filterComplex = "";
  const inputs: string[] = [];

  // Add input files
  for (const videoPath of videoPaths) {
    inputs.push("-i");
    inputs.push(videoPath);
  }

  // Normalize all inputs to common timebase and framerate to avoid
  // "First input link main timebase do not match" xfade errors
  for (let i = 0; i < videoPaths.length; i++) {
    filterComplex += `[${i}:v]settb=AVTB,fps=24[norm_${i}];`;
  }

  // Build filter chain
  let cumulativeDuration = durations[0];
  let previousLabel = "norm_0";

  for (let i = 1; i < videoPaths.length; i++) {
    const transition = transitions[i - 1] || { type: "cut", durationMs: 500 };
    const transitionDurationSec = transition.durationMs / 1000;

    if (transition.type === "cut") {
      // For cuts, concatenate then re-normalize timebase so subsequent xfade filters work
      const concatLabel = `concat${i}`;
      const normLabel = `cnorm${i}`;
      filterComplex += `[${previousLabel}][norm_${i}]concat=n=2:v=1:a=0[${concatLabel}];[${concatLabel}]settb=AVTB,fps=24[${normLabel}];`;
      previousLabel = normLabel;
      cumulativeDuration += durations[i];
    } else {
      // For transitions, use xfade
      const xfadeType = getXfadeTransitionName(transition.type);
      const offset = cumulativeDuration - transitionDurationSec;
      const xfadeLabel = `xfade${i}`;
      filterComplex += `[${previousLabel}][norm_${i}]xfade=transition=${xfadeType}:duration=${transitionDurationSec}:offset=${offset}[${xfadeLabel}];`;
      previousLabel = xfadeLabel;
      cumulativeDuration += durations[i] - transitionDurationSec;
    }
  }

  // Build audio concat filter chain to preserve audio tracks from all clips
  const audioInputs = videoPaths.map((_, i) => `[${i}:a]`).join("");
  filterComplex += `${audioInputs}concat=n=${videoPaths.length}:v=0:a=1[aout];`;

  // Remove trailing semicolon
  filterComplex = filterComplex.slice(0, -1);

  // Build ffmpeg command
  const ffmpegArgs = [
    ...inputs,
    "-filter_complex", filterComplex,
    "-map", `[${previousLabel}]`,
    "-map", "[aout]",
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "23",
    "-c:a", "aac",
    "-b:a", "128k",
    "-y",
    outputPath,
  ];

  await execFileAsync("ffmpeg", ffmpegArgs);
  return { path: outputPath };
}

/**
 * Vercel AI SDK tool definition for assembleVideo.
 * Claude calls this to assemble the final video from all shot clips.
 */
export const assembleVideoTool = {
  description: "Assemble multiple video clips into a single final video with optional scene transitions and soft subtitle track.",
  parameters: z.object({
    videoPaths: z.array(z.string()).describe("Ordered list of video clip paths"),
    transitions: z.array(z.object({
      type: z.enum(["cut", "fade_black"]).describe("Transition type"),
      durationMs: z.number().describe("Transition duration in milliseconds (typically 500-1000)")
    })).optional().describe("One transition per scene boundary. If omitted, all cuts."),
    subtitles: z.array(z.object({
      startSec: z.number().describe("Start time in seconds"),
      endSec: z.number().describe("End time in seconds"),
      text: z.string().describe("Subtitle text to display"),
    })).optional().describe("Subtitle entries to embed as a soft subtitle track. Each entry has start/end times and text."),
    outputDir: z.string().describe("Output directory for the final video"),
    outputFile: z.string().optional().describe("Output filename (default: final.mp4)"),
    dryRun: z.boolean().optional().describe("If true, return placeholder path without calling ffmpeg"),
  }),
};

