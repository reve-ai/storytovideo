import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { assembleVideo, getVideoDuration } from "./tools/assemble-video.js";
import type { Scene } from "./types.js";

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
 * Internal: upload a video to the ElevenLabs Video-to-Music API and write the
 * resulting MP3 to outMp3Path. Shared by both the legacy single-call flow and
 * the per-scene flow.
 */
async function uploadVideoForMusic(
  videoPath: string,
  outMp3Path: string,
): Promise<string> {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  const apiKey = getApiKey();
  ensureDir(outMp3Path);

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
  fs.writeFileSync(outMp3Path, audioBuffer);
  console.log(`[elevenlabs] Music generated: ${outMp3Path} (${(audioBuffer.length / 1024 / 1024).toFixed(1)}MB)`);

  return outMp3Path;
}

/**
 * Call the ElevenLabs Video-to-Music API to generate a music track from a video.
 * Returns the path to the generated music file (MP3).
 */
export async function generateMusicFromVideo(
  videoPath: string,
  outputPath: string,
): Promise<string> {
  return uploadVideoForMusic(videoPath, outputPath);
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

  const videoDuration = await getVideoDuration(videoPath);

  // Step 2: Pre-pad the WAV to exact video duration in a separate ffmpeg pass.
  // The in-graph filter does NOT propagate duration properly through amerge,
  // so we pad the music WAV here instead of inside the mix filter chain.
  const musicPadded = musicWav.replace(/\.wav$/, "-padded.wav");
  console.log("[elevenlabs] Pre-padding music WAV to video duration...");
  await execFileAsync("ffmpeg", [
    "-y",
    "-i", musicWav,
    "-af", `apad=whole_dur=${videoDuration}`,
    "-ar", "44100",
    "-ac", "2",
    "-sample_fmt", "s16",
    musicPadded,
  ]);

  // Step 3: Mix original audio with music using amerge (not amix — amix causes timestamp drift)
  console.log("[elevenlabs] Mixing music into video...");
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i", videoPath,
      "-i", musicPadded,
      "-filter_complex",
      `[0:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[orig];[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${volume}[music];[orig][music]amerge=inputs=2,pan=stereo|c0=c0+c2|c1=c1+c3[out]`,
      "-map", "0:v",
      "-map", "[out]",
      "-map", "0:s?",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-c:s", "copy",
      "-t", String(videoDuration),
      outputPath,
    ]);
  } finally {
    // Clean up intermediate wav files
    try { fs.unlinkSync(musicWav); } catch { /* ignore */ }
    try { fs.unlinkSync(musicPadded); } catch { /* ignore */ }
  }

  console.log(`[elevenlabs] Final video with music: ${outputPath}`);
  return outputPath;
}

/**
 * Generate one music track per scene using the ElevenLabs Video-to-Music API.
 *
 * For each scene:
 *   1. Resolve the highest-version mp4 in `videosDir` for each non-skipped
 *      shot (filename pattern `scene_NN_shot_NN_vN.mp4`).
 *   2. Stitch the shot mp4s into a single per-scene source mp4 under
 *      `outputDir/temp/music-source/scene-NN.mp4` (resolution-normalized
 *      concat via `assembleVideo`).
 *   3. Upload the source mp4, save the returned MP3 to
 *      `outputDir/music/scene-NN.mp3`.
 *   4. Delete the per-scene source mp4 (try/finally).
 *
 * Returns paths to the generated per-scene MP3s and the duration of each
 * scene's source mp4 (used for cost tracking).
 */
export async function generatePerSceneMusic(
  scenes: Scene[],
  videosDir: string,
  outputDir: string,
): Promise<{ compositePath: string; scenePaths: string[]; sceneDurations: number[] }> {
  const musicDir = path.join(outputDir, "music");
  const tempDir = path.join(outputDir, "temp", "music-source");
  fs.mkdirSync(musicDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });

  // Index videos/ once: for each (sceneNumber, shotInScene) keep the highest version.
  const versionMap = new Map<string, { version: number; file: string }>();
  const videoRe = /^scene_(\d{2})_shot_(\d{2})_v(\d+)\.mp4$/;
  if (fs.existsSync(videosDir)) {
    for (const f of fs.readdirSync(videosDir)) {
      const m = videoRe.exec(f);
      if (!m) continue;
      const sceneNum = parseInt(m[1], 10);
      const shotIn = parseInt(m[2], 10);
      const version = parseInt(m[3], 10);
      const key = `${sceneNum}:${shotIn}`;
      const existing = versionMap.get(key);
      if (!existing || version > existing.version) {
        versionMap.set(key, { version, file: f });
      }
    }
  }

  const scenePaths: string[] = [];
  const sceneDurations: number[] = [];

  for (const scene of scenes) {
    const padded = String(scene.sceneNumber).padStart(2, "0");
    const shots = (scene.shots || [])
      .filter((s) => s.skipped !== true)
      .sort((a, b) => a.shotInScene - b.shotInScene);

    const shotVideoPaths: string[] = [];
    for (const shot of shots) {
      const entry = versionMap.get(`${shot.sceneNumber}:${shot.shotInScene}`);
      if (!entry) continue;
      shotVideoPaths.push(path.join(videosDir, entry.file));
    }

    if (shotVideoPaths.length === 0) {
      console.warn(`[elevenlabs] No shot videos found for scene ${padded}; skipping`);
      continue;
    }

    const sourceMp4 = path.join(tempDir, `scene-${padded}.mp4`);
    const sceneMp3 = path.join(musicDir, `scene-${padded}.mp3`);

    try {
      console.log(`[elevenlabs] Assembling scene ${padded} source mp4 from ${shotVideoPaths.length} shot(s)...`);
      await assembleVideo({
        videoPaths: shotVideoPaths,
        transitions: shotVideoPaths.slice(1).map(() => ({ type: "cut", durationMs: 0 })),
        outputDir: tempDir,
        outputFile: `scene-${padded}.mp4`,
      });

      const duration = await getVideoDuration(sourceMp4);
      await uploadVideoForMusic(sourceMp4, sceneMp3);
      scenePaths.push(sceneMp3);
      sceneDurations.push(duration);
    } finally {
      try { fs.unlinkSync(sourceMp4); } catch { /* ignore */ }
    }
  }

  if (scenePaths.length === 0) {
    throw new Error("generatePerSceneMusic: no scenes produced music tracks (no matching shot videos found)");
  }

  return {
    compositePath: path.join(outputDir, "generated-music.mp3"),
    scenePaths,
    sceneDurations,
  };
}

/**
 * Compose multiple per-scene MP3 tracks into a single MP3 with 0.5s crossfades
 * between adjacent tracks, then trim/pad the result to exactly `targetDuration`.
 *
 * The crossfade chain is built pairwise:
 *   [0:a][1:a]acrossfade=d=0.5 → [a01]
 *   [a01][2:a]acrossfade=d=0.5 → [a012]
 *   ... and so on.
 *
 * The final stage applies `atrim=0:T,apad=whole_dur=T` and writes a WAV
 * intermediate, which is then re-encoded to MP3 (libmp3lame, 192k).
 */
export async function composeSceneMusicTracks(
  mp3Paths: string[],
  targetDuration: number,
  outputPath: string,
): Promise<string> {
  if (mp3Paths.length === 0) {
    throw new Error("composeSceneMusicTracks: at least one mp3 is required");
  }
  ensureDir(outputPath);

  const inputs: string[] = [];
  for (const p of mp3Paths) {
    inputs.push("-i", p);
  }

  let filterComplex = "";
  let lastLabel: string;
  if (mp3Paths.length === 1) {
    lastLabel = "0:a";
  } else {
    let labelTail = "0";
    let prevLabel = "0:a";
    for (let i = 1; i < mp3Paths.length; i++) {
      labelTail += String(i);
      const out = `a${labelTail}`;
      filterComplex += `[${prevLabel}][${i}:a]acrossfade=d=0.5:c1=tri:c2=tri[${out}];`;
      prevLabel = out;
    }
    lastLabel = prevLabel;
  }
  filterComplex += `[${lastLabel}]atrim=0:${targetDuration},apad=whole_dur=${targetDuration}[out]`;

  const wavPath = outputPath.replace(/\.mp3$/, ".wav");
  console.log(`[elevenlabs] Composing ${mp3Paths.length} scene track(s) → ${wavPath} (target ${targetDuration.toFixed(2)}s)...`);
  await execFileAsync("ffmpeg", [
    "-y",
    ...inputs,
    "-filter_complex", filterComplex,
    "-map", "[out]",
    "-ar", "44100",
    "-ac", "2",
    "-sample_fmt", "s16",
    wavPath,
  ]);

  console.log(`[elevenlabs] Encoding composite WAV → MP3: ${outputPath}`);
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i", wavPath,
      "-c:a", "libmp3lame",
      "-b:a", "192k",
      outputPath,
    ]);
  } finally {
    try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
  }

  return outputPath;
}