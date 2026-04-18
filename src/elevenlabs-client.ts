import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Check whether the ElevenLabs API key is configured.
 */
export function isElevenLabsAvailable(): boolean {
  return Boolean(process.env.ELEVENLABS_API_KEY);
}

function getApiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    throw new Error("ELEVENLABS_API_KEY environment variable is not set");
  }
  return key;
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Call the ElevenLabs Video-to-Music API to generate a music track from a video.
 * Returns the path to the generated music file (MP3).
 */
export async function generateMusicFromVideo(
  videoPath: string,
  outputPath: string,
): Promise<string> {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  const apiKey = getApiKey();
  ensureDir(outputPath);

  const videoBuffer = fs.readFileSync(videoPath);
  const blob = new Blob([videoBuffer], { type: "video/mp4" });

  const formData = new FormData();
  formData.append("videos", blob, path.basename(videoPath));

  console.log(`[elevenlabs] Uploading video to Video-to-Music API (${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB)...`);

  const response = await fetch("https://api.elevenlabs.io/v1/music/video-to-music", {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Accept": "audio/mpeg",
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`ElevenLabs API error ${response.status}: ${errorText}`);
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, audioBuffer);
  console.log(`[elevenlabs] Music generated: ${outputPath} (${(audioBuffer.length / 1024 / 1024).toFixed(1)}MB)`);

  return outputPath;
}

/**
 * Mix a music track into a video using ffmpeg.
 * CRITICAL: Decodes mp3 to wav first to avoid progressive audio drift from mp3 frame padding.
 * Uses amerge (NOT amix) for sample-accurate interleaving.
 */
export async function mixMusicIntoVideo(
  videoPath: string,
  musicPath: string,
  outputPath: string,
  volume: number = 0.3,
): Promise<string> {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }
  if (!fs.existsSync(musicPath)) {
    throw new Error(`Music file not found: ${musicPath}`);
  }

  ensureDir(outputPath);

  // Step 1: Decode mp3 to wav to eliminate mp3 frame padding/delay drift
  const musicWav = musicPath.replace(/\.mp3$/, ".wav");
  console.log("[elevenlabs] Decoding music MP3 to WAV to avoid drift...");
  await execFileAsync("ffmpeg", [
    "-y",
    "-i", musicPath,
    "-ar", "44100",
    "-ac", "2",
    "-sample_fmt", "s16",
    musicWav,
  ]);

  // Step 2: Mix original audio with music using amerge (not amix — amix causes timestamp drift)
  console.log("[elevenlabs] Mixing music into video...");
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i", videoPath,
      "-i", musicWav,
      "-filter_complex",
      `[0:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[orig];[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${volume},apad[music];[orig][music]amerge=inputs=2,pan=stereo|c0=c0+c2|c1=c1+c3[out]`,
      "-map", "0:v",
      "-map", "[out]",
      "-map", "0:s?",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-c:s", "copy",
      outputPath,
    ]);
  } finally {
    // Clean up intermediate wav file
    try { fs.unlinkSync(musicWav); } catch { /* ignore */ }
  }

  console.log(`[elevenlabs] Final video with music: ${outputPath}`);
  return outputPath;
}
