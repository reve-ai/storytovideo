import * as fs from "fs";
import * as path from "path";
import { splitVideo, ShotInfo, probeDuration } from "./tools/split-video";
import { analyzeShots, ShotAnalysisResult, ShotFrameInput } from "./tools/analyze-shots";
import { reverseEngineerMetadata, ShotDescription } from "./tools/reverse-engineer-metadata";
import { loadState, saveState } from "./tools/state";
import type { PipelineState, StoryAnalysis, AssetLibrary } from "./types";

/**
 * Write partial shot-analysis results to a sidecar JSON file so the UI
 * can display progressive analysis updates between full state saves.
 */
function savePartialAnalysis(outputDir: string, results: ShotAnalysisResult[]): void {
  const filePath = path.join(outputDir, "import_analysis_progress.json");
  fs.writeFileSync(filePath, JSON.stringify(results, null, 2));
}

/**
 * Load previously saved partial analysis results from the sidecar file.
 */
function loadPartialAnalysis(outputDir: string): ShotAnalysisResult[] {
  const filePath = path.join(outputDir, "import_analysis_progress.json");
  try {
    const data = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(data) as ShotAnalysisResult[];
  } catch {
    return [];
  }
}

/**
 * Reconstruct ShotInfo[] from existing files in the import/ directory.
 * Returns null if no split has been done yet.
 */
async function reconstructShotsFromDisk(outputDir: string): Promise<ShotInfo[] | null> {
  const importDir = path.join(outputDir, "import");
  if (!fs.existsSync(importDir)) return null;

  const files = fs.readdirSync(importDir);
  const clipFiles = files.filter(f => /^scene_\d+\.mp4$/.test(f)).sort();
  if (clipFiles.length === 0) return null;

  const shots: ShotInfo[] = [];
  for (let i = 0; i < clipFiles.length; i++) {
    const num = String(i + 1).padStart(3, "0");
    const clipPath = path.join(importDir, `scene_${num}.mp4`);
    const firstFramePath = path.join(importDir, `scene_${num}_first.jpg`);
    const lastFramePath = path.join(importDir, `scene_${num}_last.jpg`);
    const audioPath = path.join(importDir, `scene_${num}_audio.aac`);

    if (!fs.existsSync(clipPath)) continue;

    const duration = await probeDuration(clipPath);
    shots.push({
      shotNumber: i + 1,
      clipPath,
      firstFramePath,
      lastFramePath,
      audioPath: fs.existsSync(audioPath) ? audioPath : null,
      durationSeconds: Math.round(duration * 1000) / 1000,
    });
  }

  return shots.length > 0 ? shots : null;
}

/**
 * Build a minimal AssetLibrary from the StoryAnalysis so that Director Mode
 * features (frame redo, prompt edits) don't crash when assetLibrary is required.
 * For imported runs the asset images don't exist yet, so paths are empty strings.
 */
function buildPlaceholderAssetLibrary(analysis: StoryAnalysis): AssetLibrary {
  const characterImages: Record<string, { front: string; angle: string }> = {};
  for (const char of analysis.characters) {
    characterImages[char.name] = { front: "", angle: "" };
  }
  const locationImages: Record<string, string> = {};
  for (const loc of analysis.locations) {
    locationImages[loc.name] = "";
  }
  const objectImages: Record<string, string> = {};
  for (const obj of (analysis.objects ?? [])) {
    objectImages[obj.name] = "";
  }
  return { characterImages, locationImages, objectImages };
}

/**
 * Orchestrates the full video import pipeline with resume support:
 * 1. Split video into shots (clips, frames, audio) — skipped if import/ exists
 * 2. Analyze shots with vision model — skips already-analyzed shots
 * 3. Reverse-engineer full story metadata — skipped if storyAnalysis exists
 * 4. Bootstrap a PipelineState compatible with the forward pipeline
 */
export async function runImportPipeline(
  videoPath: string,
  options: {
    outputDir: string;
    sceneThreshold?: number;
    onProgress?: (phase: string, detail: string) => void;
  },
): Promise<PipelineState> {
  const { outputDir, sceneThreshold, onProgress } = options;
  const progress = onProgress ?? (() => {});

  // Try to load existing state for resume
  const existingState = loadState(outputDir);
  const state: PipelineState = existingState ?? {
    storyFile: "(imported)",
    outputDir,
    currentStage: "analysis",
    completedStages: [],
    storyAnalysis: null,
    assetLibrary: null,
    generatedAssets: {},
    generatedFrames: {},
    generatedVideos: {},
    errors: [],
    interrupted: false,
    pendingJobs: {},
    lastSavedAt: new Date().toISOString(),
  };

  // If we already have a complete storyAnalysis, the import is done
  if (state.storyAnalysis) {
    progress("complete", "Import already complete (storyAnalysis present)");
    return state;
  }

  // ── Phase 1: Split video ──────────────────────────────────────────────
  let shots: ShotInfo[];
  const existingShots = await reconstructShotsFromDisk(outputDir);
  if (existingShots && existingShots.length > 0) {
    // Fix any missing frame images by copying from the other frame
    let fixed = 0;
    for (const s of existingShots) {
      const hasFirst = fs.existsSync(s.firstFramePath);
      const hasLast = fs.existsSync(s.lastFramePath);
      if (hasFirst && !hasLast) {
        fs.copyFileSync(s.firstFramePath, s.lastFramePath);
        fixed++;
      } else if (!hasFirst && hasLast) {
        fs.copyFileSync(s.lastFramePath, s.firstFramePath);
        fixed++;
      }
      // If both missing, the clip is broken — will be caught downstream
    }
    if (fixed > 0) {
      progress("split", `Resuming — found ${existingShots.length} existing shots (fixed ${fixed} missing frames)`);
    } else {
      progress("split", `Resuming — found ${existingShots.length} existing shots`);
    }
    shots = existingShots;
  } else {
    progress("split", "Splitting video into shots...");
    shots = await splitVideo({ videoPath, outputDir, sceneThreshold });
    progress("split", `Split into ${shots.length} shots`);
  }

  // Populate generatedFrames and importedAudio from split results
  const generatedFrames: Record<number, { start?: string; end?: string }> = {};
  const importedAudio: Record<number, string> = {};
  for (const shot of shots) {
    generatedFrames[shot.shotNumber] = { start: shot.firstFramePath, end: shot.lastFramePath };
    if (shot.audioPath) {
      importedAudio[shot.shotNumber] = shot.audioPath;
    }
  }
  state.generatedFrames = generatedFrames;
  state.importedAudio = importedAudio;
  await saveState({ state });
  progress("split", "State saved after splitting");

  // ── Phase 2: Analyze shots ────────────────────────────────────────────
  // Load any previously completed analysis results and skip those shots
  const previousResults = loadPartialAnalysis(outputDir);
  const analyzedShotNumbers = new Set(previousResults.map(r => r.shotNumber));
  const remainingInputs: ShotFrameInput[] = shots
    .filter(s => !analyzedShotNumbers.has(s.shotNumber))
    .map(s => ({
      shotNumber: s.shotNumber,
      firstFramePath: s.firstFramePath,
      lastFramePath: s.lastFramePath,
    }));

  if (remainingInputs.length === 0 && previousResults.length > 0) {
    progress("analyze", `Resuming — all ${previousResults.length} shots already analyzed`);
  } else {
    if (previousResults.length > 0) {
      progress("analyze", `Resuming analysis — ${previousResults.length} done, ${remainingInputs.length} remaining`);
    } else {
      progress("analyze", "Analyzing shots with vision model...");
    }

    // Accumulate results progressively so state saves contain real data
    const analysisResults: ShotAnalysisResult[] = [...previousResults];
    await analyzeShots(
      remainingInputs,
      (result, index, total) => {
        analysisResults.push(result);
        const totalShots = shots.length;
        const done = analysisResults.length;
        progress("analyze", `Analyzed shot ${done}/${totalShots}`);
        // Write partial analysis to sidecar file + save state on every 5th shot or last
        if (done % 5 === 0 || index === total - 1) {
          savePartialAnalysis(outputDir, analysisResults);
          saveState({ state }).catch(() => {});
        }
      },
    );
    progress("analyze", `Analyzed ${analysisResults.length} shots`);
    savePartialAnalysis(outputDir, analysisResults);
    await saveState({ state });
  }

  // Reload all analysis results (previous + new)
  const allAnalysisResults = loadPartialAnalysis(outputDir);

  // ── Phase 3: Bridge formats & reverse-engineer metadata ───────────────
  progress("metadata", "Reverse-engineering story metadata...");
  const durationMap = new Map<number, number>();
  for (const shot of shots) {
    durationMap.set(shot.shotNumber, shot.durationSeconds);
  }

  // Map ShotAnalysisResult → ShotDescription
  const shotDescriptions: ShotDescription[] = allAnalysisResults.map((r) => {
    const dur = durationMap.get(r.shotNumber) ?? 0;
    let cumulative = 0;
    for (const s of shots) {
      if (s.shotNumber < r.shotNumber) cumulative += s.durationSeconds;
    }
    const mins = Math.floor(cumulative / 60);
    const secs = Math.floor(cumulative % 60);

    const descParts = [r.actionPrompt];
    if (r.startFramePrompt) descParts.push(`Start frame: ${r.startFramePrompt}`);
    if (r.endFramePrompt) descParts.push(`End frame: ${r.endFramePrompt}`);

    return {
      index: r.shotNumber,
      timestamp: `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`,
      description: descParts.join("\n"),
      composition: r.composition,
      cameraDirection: "",
      dialogue: "",
      soundEffects: "",
      durationSeconds: dur,
    };
  });

  // Collect frame images for visual reference
  const frameImagePaths: string[] = [];
  for (const shot of shots) {
    frameImagePaths.push(shot.firstFramePath);
    if (shots.length <= 20) frameImagePaths.push(shot.lastFramePath);
  }

  const storyAnalysis: StoryAnalysis = await reverseEngineerMetadata({
    shotDescriptions,
    frameImagePaths,
  });
  progress("metadata", "Story metadata generated");

  // ── Phase 4: Patch shot durations with actual measured values ──────────
  for (const scene of storyAnalysis.scenes) {
    for (const shot of scene.shots) {
      const measured = durationMap.get(shot.shotNumber);
      if (measured !== undefined) shot.durationSeconds = measured;
    }
    scene.estimatedDurationSeconds = scene.shots.reduce((sum, s) => sum + s.durationSeconds, 0);
  }

  // ── Phase 5: Bootstrap final PipelineState ────────────────────────────
  state.storyAnalysis = storyAnalysis;
  state.assetLibrary = buildPlaceholderAssetLibrary(storyAnalysis);
  state.completedStages = ["analysis", "shot_planning", "asset_generation", "frame_generation"];
  state.currentStage = "video_generation";
  state.generatedAssets = {};
  await saveState({ state });
  progress("complete", "Import pipeline finished");

  return state;
}

