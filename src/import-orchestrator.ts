import * as fs from "fs";
import * as path from "path";
import { splitVideo, ShotInfo } from "./tools/split-video";
import { analyzeShots, ShotAnalysisResult, ShotFrameInput } from "./tools/analyze-shots";
import { reverseEngineerMetadata, ShotDescription } from "./tools/reverse-engineer-metadata";
import { saveState } from "./tools/state";
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
  return { characterImages, locationImages };
}

/**
 * Orchestrates the full video import pipeline:
 * 1. Split video into shots (clips, frames, audio)
 * 2. Analyze shots with vision model
 * 3. Reverse-engineer full story metadata
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

  // Initialize state early so we can save incrementally
  const state: PipelineState = {
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
    verifications: [],
    interrupted: false,
    awaitingUserReview: false,
    continueRequested: false,
    pendingStageInstructions: {},
    instructionHistory: [],
    decisionHistory: [],
    pendingJobs: {},
    itemDirectives: {},
    lastSavedAt: new Date().toISOString(),
  };

  // ── Phase 1: Split video ──────────────────────────────────────────────
  progress("split", "Splitting video into shots...");
  const shots: ShotInfo[] = await splitVideo({ videoPath, outputDir, sceneThreshold });
  progress("split", `Split into ${shots.length} shots`);

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
  progress("analyze", "Analyzing shots with vision model...");
  const shotInputs: ShotFrameInput[] = shots.map((s) => ({
    shotNumber: s.shotNumber,
    firstFramePath: s.firstFramePath,
    lastFramePath: s.lastFramePath,
  }));

  // Accumulate results progressively so state saves contain real data
  const analysisResults: ShotAnalysisResult[] = [];
  await analyzeShots(
    shotInputs,
    (result, index, total) => {
      analysisResults.push(result);
      progress("analyze", `Analyzed shot ${index + 1}/${total}`);
      // Write partial analysis to sidecar file + save state on every 5th shot or last
      if (analysisResults.length % 5 === 0 || index === total - 1) {
        savePartialAnalysis(outputDir, analysisResults);
        saveState({ state }).catch(() => {});
      }
    },
  );
  progress("analyze", `Analyzed ${analysisResults.length} shots`);
  savePartialAnalysis(outputDir, analysisResults);
  await saveState({ state });

  // ── Phase 3: Bridge formats & reverse-engineer metadata ───────────────
  progress("metadata", "Reverse-engineering story metadata...");
  const durationMap = new Map<number, number>();
  for (const shot of shots) {
    durationMap.set(shot.shotNumber, shot.durationSeconds);
  }

  // Map ShotAnalysisResult → ShotDescription
  // Use 1-based index to match the output's shotNumber convention.
  // Pass through startFramePrompt/endFramePrompt in the description field
  // so reverse-engineer can use them for its own prompt generation.
  const shotDescriptions: ShotDescription[] = analysisResults.map((r) => {
    const dur = durationMap.get(r.shotNumber) ?? 0;
    let cumulative = 0;
    for (const s of shots) {
      if (s.shotNumber < r.shotNumber) cumulative += s.durationSeconds;
    }
    const mins = Math.floor(cumulative / 60);
    const secs = Math.floor(cumulative % 60);

    // Build a rich description that includes frame prompts so the LLM
    // has full context for scene grouping and character identification
    const descParts = [r.actionPrompt];
    if (r.startFramePrompt) descParts.push(`Start frame: ${r.startFramePrompt}`);
    if (r.endFramePrompt) descParts.push(`End frame: ${r.endFramePrompt}`);

    return {
      index: r.shotNumber,  // 1-based to match prompt's "Shot ${s.index}" display
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
  // Build placeholder assetLibrary so Director Mode frame redo works
  state.assetLibrary = buildPlaceholderAssetLibrary(storyAnalysis);
  state.completedStages = ["analysis", "shot_planning", "asset_generation", "frame_generation"];
  state.currentStage = "video_generation";
  state.generatedAssets = {};
  await saveState({ state });
  progress("complete", "Import pipeline finished");

  return state;
}

