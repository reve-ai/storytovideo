import { generateText, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { writeFileSync, readdirSync, unlinkSync, mkdirSync, existsSync, renameSync } from "fs";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { join, extname } from "path";

import type { ArtifactVersion, PipelineOptions, PipelineState, Shot } from "./types";
import { interrupted } from "./signals";
import { analyzeStory, analyzeStoryTool } from "./tools/analyze-story";
import { planShotsForScene, planShotsForSceneTool, CINEMATIC_RULES } from "./tools/plan-shots";
import { generateAsset, generateAssetTool } from "./tools/generate-asset";
import { generateFrame, generateFrameTool } from "./tools/generate-frame";
import { generateVideo, generateVideoTool } from "./tools/generate-video";
import { verifyOutput, verifyOutputTool } from "./tools/verify-output";
import { assembleVideo, assembleVideoTool } from "./tools/assemble-video";
import { saveState, loadState, saveStateTool } from "./tools/state";
import { analyzeClipPacing } from "./tools/analyze-video-pacing";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StageName =
  | "analysis"
  | "shot_planning"
  | "asset_generation"
  | "frame_generation"
  | "video_generation"
  | "shot_generation"
  | "assembly";

const STAGE_ORDER: StageName[] = [
  "analysis",
  "shot_planning",
  "asset_generation",
  "frame_generation",
  "video_generation",
  "shot_generation",
  "assembly",
];

// ---------------------------------------------------------------------------
// Stage rollback error — thrown to restart the pipeline loop from an earlier stage
// ---------------------------------------------------------------------------

class StageRollbackError extends Error {
  constructor(public targetStage: string, message: string) {
    super(message);
    this.name = 'StageRollbackError';
  }
}

// ---------------------------------------------------------------------------
// Tool execute wrapper — logs success/failure for debugging
// ---------------------------------------------------------------------------

function wrapToolExecute<T>(stageName: string, toolName: string, fn: (params: any) => Promise<T>, onError?: (stageName: string, toolName: string, error: string) => void, signal?: AbortSignal): (params: any) => Promise<T> {
  return async (params: any) => {
    if (signal?.aborted) {
      throw new Error(`Tool ${toolName} aborted: pipeline interrupted`);
    }
    try {
      const result = await fn(params);
      console.log(`[${stageName}] Tool success (${toolName}): ${JSON.stringify(result)?.substring(0, 200)}`);
      return result;
    } catch (error) {
      console.error(`[${stageName}] Tool FAILED (${toolName}):`, error instanceof Error ? error.message : error);
      console.error(`[${stageName}] Tool params were:`, JSON.stringify(params)?.substring(0, 500));
      if (onError) {
        onError(stageName, toolName, error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  };
}

// ---------------------------------------------------------------------------
// Version tracking helpers
// ---------------------------------------------------------------------------

/** Preserve old file by renaming it with a version suffix before overwriting. */
function preserveOldFile(filePath: string | undefined, versions: ArtifactVersion[] | undefined): void {
  if (!filePath || !existsSync(filePath) || !versions || versions.length === 0) return;
  const versionCount = versions.length;
  const ext = extname(filePath);
  const base = filePath.replace(ext, '');
  const versionedPath = `${base}_v${versionCount}${ext}`;
  if (!existsSync(versionedPath)) {
    renameSync(filePath, versionedPath);
    // Update the last version entry's path
    versions[versions.length - 1].path = versionedPath;
  }
}

/** Record a new video version and update selectedVersions. */
export function trackVideoVersion(state: PipelineState, shotNumber: number, path: string, extra?: Partial<ArtifactVersion>): void {
  if (!state.videoVersions) state.videoVersions = {};
  if (!state.videoVersions[shotNumber]) state.videoVersions[shotNumber] = [];
  preserveOldFile(state.generatedVideos[shotNumber], state.videoVersions[shotNumber]);
  state.videoVersions[shotNumber].push({
    version: state.videoVersions[shotNumber].length + 1,
    path,
    timestamp: new Date().toISOString(),
    ...extra,
  });
  if (!state.selectedVersions) state.selectedVersions = { videos: {}, frames: {} };
  if (!state.selectedVersions.videos) state.selectedVersions.videos = {};
  state.selectedVersions.videos[shotNumber] = state.videoVersions[shotNumber].length;
}

/** Record a new frame version and update selectedVersions. */
function trackFrameVersion(state: PipelineState, shotNumber: number, frameType: string, path: string, extra?: Partial<ArtifactVersion>): void {
  if (!state.frameVersions) state.frameVersions = {};
  if (!state.frameVersions[shotNumber]) state.frameVersions[shotNumber] = {};
  if (!state.frameVersions[shotNumber][frameType]) state.frameVersions[shotNumber][frameType] = [];
  // Preserve old frame file
  const currentFrames = state.generatedFrames[shotNumber];
  const oldPath = currentFrames ? (currentFrames as any)[frameType] : undefined;
  preserveOldFile(oldPath, state.frameVersions[shotNumber][frameType]);
  state.frameVersions[shotNumber][frameType].push({
    version: state.frameVersions[shotNumber][frameType].length + 1,
    path,
    timestamp: new Date().toISOString(),
    ...extra,
  });
  if (!state.selectedVersions) state.selectedVersions = { videos: {}, frames: {} };
  if (!state.selectedVersions.frames) state.selectedVersions.frames = {};
  if (!state.selectedVersions.frames[shotNumber]) state.selectedVersions.frames[shotNumber] = {};
  state.selectedVersions.frames[shotNumber][frameType] = state.frameVersions[shotNumber][frameType].length;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createInitialState(storyFile: string, outputDir: string): PipelineState {
  return {
    storyFile,
    outputDir,
    currentStage: "analysis",
    completedStages: [],
    storyAnalysis: null,
    assetLibrary: null,
    generatedAssets: {},
    generatedFrames: {},
    generatedVideos: {},
	    videoPromptsSent: {},
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
}



function compactState(state: PipelineState, stageName?: string): string {
  if (stageName === 'video_generation') {
    // Only include what the video generation agent needs — skip characters, locations,
    // frame prompts, narrative summaries, and other large fields to stay within context limits.
    const allShots = state.storyAnalysis?.scenes.flatMap(s => s.shots || []) ?? [];
    const remainingShots = allShots.filter(s => !state.generatedVideos[s.shotNumber]);

    const compact = {
      outputDir: state.outputDir,
      generatedVideos: state.generatedVideos,
      generatedFrames: Object.fromEntries(
        remainingShots.map(s => [s.shotNumber, state.generatedFrames[s.shotNumber]])
      ),
      remainingShots: remainingShots.map(s => ({
        shotNumber: s.shotNumber,
        sceneNumber: s.sceneNumber,
        durationSeconds: s.durationSeconds,
        shotType: s.shotType,
        actionPrompt: s.actionPrompt,
        dialogue: s.dialogue,
        soundEffects: s.soundEffects,
        cameraDirection: s.cameraDirection,
      })),
    };
    return JSON.stringify(compact, null, 2);
  }

  if (stageName === 'shot_generation') {
    // Shot generation (grok) needs shot data + asset library for frame generation + video generation
    const allShots = state.storyAnalysis?.scenes.flatMap(s => s.shots || []) ?? [];
    const remainingShots = allShots.filter(s => !state.generatedVideos[s.shotNumber]);

    const compact = {
      outputDir: state.outputDir,
      generatedFrames: state.generatedFrames,
      generatedVideos: state.generatedVideos,
      assetLibrary: state.assetLibrary,
      artStyle: state.storyAnalysis?.artStyle,
      remainingShots: remainingShots.map(s => ({
        shotNumber: s.shotNumber,
        sceneNumber: s.sceneNumber,
        shotInScene: s.shotInScene,
        durationSeconds: s.durationSeconds,
        shotType: s.shotType,
        composition: s.composition,
        startFramePrompt: s.startFramePrompt,
        actionPrompt: s.actionPrompt,
        dialogue: s.dialogue,
        soundEffects: s.soundEffects,
        cameraDirection: s.cameraDirection,
        charactersPresent: s.charactersPresent,
        location: s.location,
        continuousFromPrevious: s.continuousFromPrevious,
      })),
    };
    return JSON.stringify(compact, null, 2);
  }

  if (stageName === 'assembly') {
    // Assembly only needs video paths, scene transitions, and dialogue for subtitles.
    const compact = {
      outputDir: state.outputDir,
      generatedVideos: state.generatedVideos,
      scenes: state.storyAnalysis?.scenes.map(s => ({
        sceneNumber: s.sceneNumber,
        transition: s.transition,
        shots: (s.shots || []).map(shot => ({
          shotNumber: shot.shotNumber,
          sceneNumber: shot.sceneNumber,
          durationSeconds: shot.durationSeconds,
          dialogue: shot.dialogue,
        })),
      })),
    };
    return JSON.stringify(compact, null, 2);
  }

  // Default: full state (for analysis, shot_planning, asset_generation, frame_generation)
  return JSON.stringify(state, null, 2);
}

function getStageInstructions(state: PipelineState, stageName: string): string[] {
  return state.pendingStageInstructions[stageName] ?? [];
}

function buildInstructionInjectionBlock(instructions: string[]): string {
  if (instructions.length === 0) {
    return "";
  }

  const numbered = instructions
    .map((instruction, index) => `${index + 1}. ${instruction}`)
    .join("\n");

  return `\n\nAdditional user instructions for this stage:\n${numbered}\nApply these instructions when executing this stage unless they conflict with tool schemas or safety constraints.`;
}

/** Map directive target patterns to the stages they apply to. */
const DIRECTIVE_STAGE_MAP: Record<string, string[]> = {
  // shot:N:start_frame, shot:N:end_frame → frame_generation (or shot_generation for grok)
  "start_frame": ["frame_generation", "shot_generation"],
  "end_frame": ["frame_generation"],
  // shot:N:video → video_generation (or shot_generation for grok)
  "video": ["video_generation", "shot_generation"],
  // Prompt-level fields are injected into the stage that *uses* the prompt
  "start_frame_prompt": ["frame_generation", "shot_generation", "shot_planning"],
  "end_frame_prompt": ["frame_generation", "shot_planning"],
  "action_prompt": ["video_generation", "shot_generation", "shot_planning"],
  // Shot metadata fields
  "camera_direction": ["video_generation", "shot_generation", "shot_planning"],
  "sound_effects": ["video_generation", "shot_generation", "assembly", "shot_planning"],
};

function directiveMatchesStage(target: string, stageName: string): boolean {
  // asset:* → asset_generation
  if (target.startsWith("asset:")) return stageName === "asset_generation";
  // analysis:* → analysis
  if (target.startsWith("analysis:")) return stageName === "analysis";
  // shot:N:field — extract the field suffix
  const shotMatch = target.match(/^shot:\d+:(.+)$/);
  if (shotMatch) {
    const field = shotMatch[1];
    const stages = DIRECTIVE_STAGE_MAP[field];
    return stages ? stages.includes(stageName) : false;
  }
  return false;
}

function buildItemDirectiveBlock(state: PipelineState, stageName: string): string {
  const relevant = Object.values(state.itemDirectives).filter(d =>
    directiveMatchesStage(d.target, stageName)
  );
  if (relevant.length === 0) return "";
  return "\n\n## DIRECTOR OVERRIDES\nThe director has provided specific instructions for certain items. You MUST follow these exactly:\n" +
    relevant.map(d => `- **${d.target}**: ${d.directive}`).join("\n");
}

/**
 * Apply prompt-level directives by modifying shot data in storyAnalysis.
 * Targets like shot:N:action_prompt, shot:N:start_frame_prompt, shot:N:end_frame_prompt
 * directly replace the corresponding field on the shot object so Claude sees the
 * edited prompt in the data rather than needing a separate instruction.
 */
function applyPromptLevelDirectives(state: PipelineState): void {
  if (!state.storyAnalysis) return;
  const allShots = state.storyAnalysis.scenes.flatMap(s => s.shots || []);
  for (const directive of Object.values(state.itemDirectives)) {
    const match = directive.target.match(/^shot:(\d+):(action_prompt|start_frame_prompt|end_frame_prompt|camera_direction|sound_effects)$/);
    if (!match) continue;
    const shotNumber = parseInt(match[1], 10);
    const field = match[2];
    const shot = allShots.find(s => s.shotNumber === shotNumber);
    if (!shot) continue;
    const fieldMap: Record<string, keyof Shot> = {
      action_prompt: "actionPrompt",
      start_frame_prompt: "startFramePrompt",
      end_frame_prompt: "endFramePrompt",
      camera_direction: "cameraDirection",
      sound_effects: "soundEffects",
    };
    const key = fieldMap[field];
    if (key) {
      console.log(`[directive] Applying prompt-level directive to shot ${shotNumber}.${key}: "${directive.directive.substring(0, 80)}..."`);
      (shot as any)[key] = directive.directive;
    }
  }

}

function hasItemDirectivesForStage(state: PipelineState, stageName: string): boolean {
  return Object.values(state.itemDirectives).some(d => directiveMatchesStage(d.target, stageName));
}

/**
 * Delete generated files from disk for a given stage and all downstream stages.
 * Each stage clears its own files plus all later stages' files (cumulative).
 * Directory structures are preserved — only contents are deleted.
 */
function clearStageFiles(outputDir: string, fromStage: StageName): void {
  const stageIdx = STAGE_ORDER.indexOf(fromStage);
  if (stageIdx < 0) return;

  /** Delete a single file, ignoring missing-file errors. */
  function tryUnlink(filePath: string): void {
    try { unlinkSync(filePath); } catch (_) { /* file may not exist */ }
  }

  /** Delete all files inside a directory (non-recursive), ignoring errors. */
  function clearDir(dirPath: string): void {
    try {
      for (const entry of readdirSync(dirPath)) {
        tryUnlink(join(dirPath, entry));
      }
    } catch (_) { /* directory may not exist */ }
  }

  // assembly (6): final.mp4, final.ass
  if (stageIdx <= STAGE_ORDER.indexOf("assembly")) {
    tryUnlink(join(outputDir, "final.mp4"));
    tryUnlink(join(outputDir, "final.ass"));
  }

  // shot_generation (5): frames/ + videos/ (combined stage for grok)
  if (stageIdx <= STAGE_ORDER.indexOf("shot_generation")) {
    clearDir(join(outputDir, "frames"));
    clearDir(join(outputDir, "videos"));
  }

  // video_generation (4): videos/
  if (stageIdx <= STAGE_ORDER.indexOf("video_generation")) {
    clearDir(join(outputDir, "videos"));
  }

  // frame_generation (3): frames/
  if (stageIdx <= STAGE_ORDER.indexOf("frame_generation")) {
    clearDir(join(outputDir, "frames"));
  }

  // asset_generation (2): assets/characters/, assets/locations/, assets/objects/
  if (stageIdx <= STAGE_ORDER.indexOf("asset_generation")) {
    clearDir(join(outputDir, "assets", "characters"));
    clearDir(join(outputDir, "assets", "locations"));
    clearDir(join(outputDir, "assets", "objects"));
  }

  // shot_planning (1): no files to delete (shots live in state JSON)

  // analysis (0): story_analysis.json
  if (stageIdx <= STAGE_ORDER.indexOf("analysis")) {
    tryUnlink(join(outputDir, "story_analysis.json"));
  }
}

/**
 * Clear item-level data for a given stage and all subsequent stages.
 * This is used by the --redo option to reset state before re-running a stage.
 *
 * Data clearing rules by stage:
 * - analysis (0): clear storyAnalysis, assetLibrary, generatedAssets, generatedFrames, generatedVideos
 * - shot_planning (1): clear assetLibrary, generatedAssets, generatedFrames, generatedVideos
 * - asset_generation (2): clear generatedAssets, generatedFrames, generatedVideos
 * - frame_generation (3): clear generatedFrames, generatedVideos
 * - video_generation (4): clear generatedVideos
 * - shot_generation (5): clear generatedFrames, generatedVideos (combined grok stage)
 * - assembly (6): nothing to clear
 */
export function clearStageData(state: PipelineState, fromStage: StageName, outputDir?: string): void {
  const stageIdx = STAGE_ORDER.indexOf(fromStage);
  if (stageIdx < 0) {
    throw new Error(`Unknown stage: ${fromStage}`);
  }

  // Delete generated files from disk before clearing state
  if (outputDir) {
    clearStageFiles(outputDir, fromStage);
  }

  // Clear data based on stage name for clarity
  if (fromStage === "analysis") {
    // analysis: clear everything
    state.storyAnalysis = null;
    state.assetLibrary = null;
    state.generatedAssets = {};
    state.generatedFrames = {};
    state.generatedVideos = {};
	  state.videoPromptsSent = {};
  } else if (fromStage === "shot_planning") {
    // shot_planning: clear asset-related and downstream
    state.assetLibrary = null;
    if (state.storyAnalysis) {
      for (const scene of state.storyAnalysis.scenes) {
        scene.shots = [];
      }
    }
    state.generatedAssets = {};
    state.generatedFrames = {};
    state.generatedVideos = {};
	  state.videoPromptsSent = {};
  } else if (fromStage === "asset_generation") {
    // asset_generation: clear generated assets and downstream
    state.generatedAssets = {};
    state.generatedFrames = {};
    state.generatedVideos = {};
	  state.videoPromptsSent = {};
  } else if (fromStage === "frame_generation") {
    // frame_generation: clear generated frames and videos
    state.generatedFrames = {};
    state.generatedVideos = {};
	  state.videoPromptsSent = {};
  } else if (fromStage === "video_generation") {
    // video_generation: clear generated videos
    state.generatedVideos = {};
	  state.videoPromptsSent = {};
  } else if (fromStage === "shot_generation") {
    // shot_generation (grok combined): clear both frames and videos
    state.generatedFrames = {};
    state.generatedVideos = {};
	  state.videoPromptsSent = {};
  }
  // assembly: nothing to clear

  // Remove the target stage and all subsequent stages from completedStages
  for (let i = stageIdx; i < STAGE_ORDER.length; i++) {
    const idx = state.completedStages.indexOf(STAGE_ORDER[i]);
    if (idx !== -1) {
      state.completedStages.splice(idx, 1);
    }
  }

  // Set currentStage to the target stage
  state.currentStage = fromStage;
}

// ---------------------------------------------------------------------------
// Stage runner — each stage is a separate generateText() call
// ---------------------------------------------------------------------------

async function runStage(
  stageName: string,
  state: PipelineState,
  _options: PipelineOptions,
  systemPrompt: string,
  userPrompt: string,
  tools: Record<string, any>,
  maxSteps: number,
  _verbose: boolean,
): Promise<PipelineState> {
  console.log(`\n=== Stage: ${stageName} ===`);
  const stageInstructions = getStageInstructions(state, stageName);
  if (stageInstructions.length > 0) {
    console.log(
      `[${stageName}] Applying ${stageInstructions.length} user instruction(s)`,
    );
  }
  // Apply prompt-level directives (modifies shot data in-place before the stage sees it)
  applyPromptLevelDirectives(state);

  // Build the system prompt with stage instructions + item directive overrides
  const directiveBlock = buildItemDirectiveBlock(state, stageName);
  if (directiveBlock) {
    console.log(`[${stageName}] Injecting item directive overrides`);
  }
  const injectedSystemPrompt =
    systemPrompt + buildInstructionInjectionBlock(stageInstructions) + directiveBlock;

  const localAbort = new AbortController();
  if (_options.abortSignal) {
    _options.abortSignal.addEventListener('abort', () => localAbort.abort(), { once: true });
    if (_options.abortSignal.aborted) localAbort.abort(); // Already aborted
  }

  try {
    const result = await generateText({
      model: anthropic("claude-opus-4-6") as any,
      system: injectedSystemPrompt,
      prompt: userPrompt,
      tools,
      abortSignal: localAbort.signal,
      stopWhen: stepCountIs(maxSteps),
      onStepFinish: (step: any) => {
        if (interrupted || _options.abortSignal?.aborted) {
          localAbort.abort();
        }
        console.log(`[${stageName}] Step keys:`, Object.keys(step).join(', '));
        if (step.text) {
          console.log(`[${stageName}] Claude: ${step.text.substring(0, 200)}`);
        }
        if (step.toolCalls && step.toolCalls.length > 0) {
          for (const tc of step.toolCalls) {
            console.log(`[${stageName}] Tool call: ${tc.toolName}`);
          }
        }
        if (step.toolResults && step.toolResults.length > 0) {
          for (const tr of step.toolResults) {
            const resultStr = JSON.stringify(tr.result);
            if (tr.type === 'error' || (resultStr && resultStr.includes('"error"'))) {
              console.error(`[${stageName}] Tool error (${tr.toolName}):`, resultStr);
            } else {
              console.log(`[${stageName}] Tool result (${tr.toolName}): ${resultStr?.substring(0, 200) ?? '(no result)'}`);
            }
          }
        }
      },
    } as any);

    // Always log why the agent stopped
    const stepCount = result.steps?.length ?? 0;
    const finishReason = result.finishReason ?? "unknown";
    console.log(`[${stageName}] Agent finished: reason=${finishReason}, steps=${stepCount}/${maxSteps}`);
    if (result.usage) {
      const input = result.usage.inputTokens ?? 0;
      const output = result.usage.outputTokens ?? 0;
      console.log(`[${stageName}] Token usage: input=${input}, output=${output}, total=${input + output}`);
    }

    console.log(`[${stageName}] Final text:`, result.text?.substring(0, 300) || "(no text)");
  } catch (error: any) {
    // Handle prompt too long by returning gracefully — outer loop will restart with fresh context
    if (error?.message?.includes('prompt is too long') || error?.message?.includes('maximum context length')) {
      console.warn(`[${stageName}] Context window exceeded. Will restart stage with fresh context.`);
      return state;
    }
    if (error?.name === 'AbortError' && (interrupted || _options.abortSignal?.aborted)) {
      console.log(`[${stageName}] Aborted due to pipeline interruption`);
      return state;
    }
    throw error;
  }

  return state;
}

// ---------------------------------------------------------------------------
// Stage 1: Analysis
// ---------------------------------------------------------------------------

async function runAnalysisStage(
  state: PipelineState,
  storyText: string,
  options: PipelineOptions,
): Promise<PipelineState> {
  const systemPrompt = `You are a story analysis agent. Your job is to analyze the provided story text and extract structured information.

Call the analyzeStory tool with the full story text. The tool will return a StoryAnalysis object with characters, locations, art style, and scenes.

Also call the nameRun tool to give this run a short, creative name (2-5 words) that captures the story's essence.

After receiving the analysis, respond with a brief summary of what was found.`;

  const userPrompt = `Analyze this story:\n\n${storyText}`;

  const analysisTools = {
    analyzeStory: {
      description: analyzeStoryTool.description,
      inputSchema: analyzeStoryTool.parameters,
      execute: wrapToolExecute("analysis", "analyzeStory", async (params: z.infer<typeof analyzeStoryTool.parameters>) => {
        const result = await analyzeStory(params.storyText);
        state.storyAnalysis = result;
        return result;
      }, options.onToolError, options.abortSignal),
    },
    nameRun: {
      description: "Give this run a short, creative name (2-5 words) that captures the essence of the story.",
      inputSchema: z.object({
        name: z.string().min(1).max(60).describe("A short creative name for this run (2-5 words, no quotes)"),
      }),
      execute: wrapToolExecute("analysis", "nameRun", async (params: { name: string }) => {
        const trimmed = params.name.trim().replace(/^["']|["']$/g, "").slice(0, 60);
        if (options.onNameRun) {
          options.onNameRun(trimmed);
        }
        console.log(`[analysis] Run named: "${trimmed}"`);
        return { name: trimmed };
      }, options.onToolError, options.abortSignal),
    },
  };

  await runStage("analysis", state, options, systemPrompt, userPrompt, analysisTools, 5, options.verbose);

  if (!state.storyAnalysis) {
    throw new Error("Analysis stage did not produce a StoryAnalysis");
  }

  state.completedStages.push("analysis");
  state.currentStage = "shot_planning";
  return state;
}

// ---------------------------------------------------------------------------
// Stage 2: Shot Planning
// ---------------------------------------------------------------------------

async function runShotPlanningStage(
  state: PipelineState,
  options: PipelineOptions,
): Promise<PipelineState> {
  if (!state.storyAnalysis) {
    throw new Error("Shot planning requires storyAnalysis in state");
  }

  const backend = options.videoBackend;
  let durationGuidance: string;
  if (backend === "comfy") {
    durationGuidance = `Shots can be 0.5-10 seconds long (fractional values like 1.5 or 3.5 are fine). Choose the duration that best fits the action:
- Very short (0.5-2s): flash cuts, inserts, whip pans, rapid montage
- Short (2-4s): quick reactions, insert cutaways, snappy dialogue
- Medium (4-8s): establishing shots, dialogue, tracking shots, emotional beats
- Long (8-10s): slow reveals, extended action, lingering moments`;
  } else if (backend === "grok") {
    durationGuidance = `Shots can be 1-15 seconds long. Choose the duration that best fits the action:
- Very short (1-2s): flash cuts, inserts, whip pans, rapid montage
- Short (2-4s): quick reactions, insert cutaways, snappy dialogue
- Medium (4-8s): establishing shots, dialogue, tracking shots, emotional beats
- Long (8-15s): slow reveals, extended action, lingering moments`;
  } else {
    durationGuidance = `Each shot is exactly 8 seconds (durationSeconds: 8). This is a fixed constraint of the Veo video backend.`;
  }

  const grokShotPlanningGuidance = backend === "grok"
    ? `IMPORTANT FOR GROK: Since the Grok backend does not use end frames, set endFramePrompt to an empty string for all shots. Apply the cinematic rules normally, but any mention of end frames should be treated as composition guidance only.`
    : "";
  const fixedCameraGuidance = backend === "grok"
    ? `9. The camera is FIXED for the duration of each shot. The start frame prompt must describe what the SAME stationary camera sees at the start of the shot. Since Grok does not use end frames, set endFramePrompt to an empty string for every shot.`
    : `9. The camera is FIXED for the duration of each shot. Start and end frame prompts must describe what the SAME stationary camera sees at two moments in time. Same subject, same angle, same composition. NEVER have the start frame describe one person and the end frame describe a different person. To switch to a different person or angle, end this shot and start a new one — that's what cuts are for.`;

  const systemPrompt = `You are a cinematic shot planner. Your job is to break down each scene into shots with cinematic composition.

${CINEMATIC_RULES}

${grokShotPlanningGuidance}

For each scene in the story analysis (in order), call the planShotsForScene tool with:
- sceneNumber: the scene number
- transition: the transition type into this scene
- shots: an array of shot objects with all required fields

Plan shots for ONE scene at a time. Call planShotsForScene once per scene, in scene order.

For each scene:
1. Choose a transition type (Scene 1 is always "cut")
2. ${durationGuidance}
3. Assign cinematic composition types (use underscore format: wide_establishing, over_the_shoulder, etc.)
4. Distribute dialogue across shots respecting pacing rules
5. All shots use first_last_frame generation strategy
6. Write detailed frame prompts that include the composition type
7. Write action prompts for video generation. In actionPrompt fields, describe characters by their visual appearance (e.g., "the man in the blue suit", "the woman with red hair") rather than by name. Character names in video prompts trigger content safety filters.
8. Include dialogue as quoted speech if present
${fixedCameraGuidance}
10. For each shot, populate objectsPresent with the names of any key objects/products/props that appear in that shot.${(state.storyAnalysis?.objects ?? []).length > 0 ? ` Known objects: ${(state.storyAnalysis?.objects ?? []).map(o => o.name).join(", ")}.` : ""}

After planning all scenes, respond with a brief summary of the shots planned.`;

  const analysisJson = JSON.stringify(state.storyAnalysis, null, 2);
  const userPrompt = `Plan cinematic shots for this story analysis:\n\n${analysisJson}`;

  const shotTools = {
    planShotsForScene: {
      description: planShotsForSceneTool.description,
      inputSchema: planShotsForSceneTool.parameters,
      execute: wrapToolExecute("shot_planning", "planShotsForScene", async (params: z.infer<typeof planShotsForSceneTool.parameters>) => {
        const result = planShotsForScene(
          params.sceneNumber,
          params.transition,
          params.shots,
          state.storyAnalysis!,
        );
        state.storyAnalysis = result;
        await saveState({ state });
        const sceneShotCount = result.scenes.find(s => s.sceneNumber === params.sceneNumber)?.shots?.length ?? 0;
        const totalShots = result.scenes.reduce((sum, s) => sum + (s.shots?.length ?? 0), 0);
        return { sceneNumber: params.sceneNumber, shotsPlanned: sceneShotCount, totalShotsSoFar: totalShots };
      }, options.onToolError, options.abortSignal),
    },
  };

  await runStage("shot_planning", state, options, systemPrompt, userPrompt, shotTools, 30, options.verbose);

  // Verify ALL scenes have shots
  const scenesWithoutShots = state.storyAnalysis?.scenes?.filter(s => !s.shots || s.shots.length === 0) ?? [];
  if (scenesWithoutShots.length > 0) {
    throw new Error(`Shot planning stage did not produce shots for scenes: ${scenesWithoutShots.map(s => s.sceneNumber).join(", ")}`);
  }

  state.completedStages.push("shot_planning");
  state.currentStage = "asset_generation";
  return state;
}

// ---------------------------------------------------------------------------
// Stage 3: Asset Generation
// ---------------------------------------------------------------------------

async function runAssetGenerationStage(
  state: PipelineState,
  options: PipelineOptions,
): Promise<PipelineState> {
  if (!state.storyAnalysis) {
    throw new Error("Asset generation requires storyAnalysis in state");
  }

  const analysis = state.storyAnalysis;

  // Build list of needed assets
  const neededAssets: string[] = [];
  for (const char of analysis.characters) {
    const frontKey = `character:${char.name}:front`;
    const angleKey = `character:${char.name}:angle`;
    if (!state.generatedAssets[frontKey]) neededAssets.push(frontKey);
    if (!state.generatedAssets[angleKey]) neededAssets.push(angleKey);
  }
  for (const loc of analysis.locations) {
    const locKey = `location:${loc.name}:front`;
    if (!state.generatedAssets[locKey]) neededAssets.push(locKey);
  }
  for (const obj of (analysis.objects ?? [])) {
    const objKey = `object:${obj.name}:front`;
    if (!state.generatedAssets[objKey]) neededAssets.push(objKey);
  }

  const hasPendingInstructions = (state.pendingStageInstructions["asset_generation"]?.length ?? 0) > 0;
  const hasDirectives = hasItemDirectivesForStage(state, "asset_generation");
  if (neededAssets.length === 0 && !hasPendingInstructions && !hasDirectives) {
    console.log("[asset_generation] All assets already generated, skipping.");
    state.completedStages.push("asset_generation");
    state.currentStage = "frame_generation";
    return state;
  }

  const stateJson = compactState(state, 'asset_generation');
  const systemPrompt = `You are an asset generation agent. Generate reference images for characters, locations, and objects.

Current pipeline state:
${stateJson}

For each character, generate TWO images:
1. Front-facing reference (call generateAsset with characterName, no referenceImagePath)
2. Angle reference (call generateAsset with characterName AND referenceImagePath pointing to the front image)

For each location, generate ONE image (call generateAsset with locationName).

For each object, generate ONE image (call generateAsset with objectName).

IMPORTANT:
- Check state.generatedAssets before generating — skip items that already have paths.
- After EACH successful generation, call saveState to checkpoint progress.
- Pass dryRun=${options.dryRun} to generateAsset.
- Use outputDir="${options.outputDir}" for all assets.
- Use the art style: "${analysis.artStyle}"

Assets still needed: ${JSON.stringify(neededAssets)}`;

  const objectNames = (analysis.objects ?? []).map((o) => o.name);
  const userPrompt = `Generate all needed reference assets. Characters: ${analysis.characters.map((c) => c.name).join(", ")}. Locations: ${analysis.locations.map((l) => l.name).join(", ")}.${objectNames.length > 0 ? ` Objects: ${objectNames.join(", ")}.` : ""}`;

  const assetTools: Record<string, any> = {
    generateAsset: {
      description: generateAssetTool.description,
      inputSchema: generateAssetTool.parameters,
      execute: wrapToolExecute("asset_generation", "generateAsset", async (params: z.infer<typeof generateAssetTool.parameters>) => {
        const result = await generateAsset({
          ...params,
          dryRun: options.dryRun,
          outputDir: options.outputDir,
          videoBackend: options.videoBackend,
          aspectRatio: options.aspectRatio,
        });
        state.generatedAssets[result.key] = result.path;
        // Track asset version
        if (!state.assetVersions) state.assetVersions = {};
        if (!state.assetVersions[result.key]) state.assetVersions[result.key] = [];
        state.assetVersions[result.key].push({
          version: state.assetVersions[result.key].length + 1,
          path: result.path,
          timestamp: new Date().toISOString(),
        });
        // Update asset library
        if (!state.assetLibrary) {
          state.assetLibrary = { characterImages: {}, locationImages: {}, objectImages: {} };
        }
        if (!state.assetLibrary.objectImages) {
          state.assetLibrary.objectImages = {};
        }
        if (params.characterName) {
          if (!state.assetLibrary.characterImages[params.characterName]) {
            state.assetLibrary.characterImages[params.characterName] = { front: "", angle: "" };
          }
          if (params.referenceImagePath) {
            state.assetLibrary.characterImages[params.characterName].angle = result.path;
          } else {
            state.assetLibrary.characterImages[params.characterName].front = result.path;
          }
        }
        if (params.locationName) {
          state.assetLibrary.locationImages[params.locationName] = result.path;
        }
        if (params.objectName) {
          state.assetLibrary.objectImages[params.objectName] = result.path;
        }
        await saveState({ state });
        return result;
      }, options.onToolError, options.abortSignal),
    },
    saveState: {
      description: saveStateTool.description,
      inputSchema: saveStateTool.parameters,
      execute: wrapToolExecute("asset_generation", "saveState", async () => {
        return saveState({ state });
      }, options.onToolError, options.abortSignal),
    },
  };

  if (options.verify) {
    assetTools.verifyOutput = {
      description: verifyOutputTool.description,
      inputSchema: verifyOutputTool.parameters,
      execute: wrapToolExecute("asset_generation", "verifyOutput", async (params: z.infer<typeof verifyOutputTool.parameters>) => {
        return verifyOutput({ ...params, dryRun: options.dryRun });
      }, options.onToolError, options.abortSignal),
    };
  }

  await runStage("asset_generation", state, options, systemPrompt, userPrompt, assetTools, 60, options.verbose);

  // Recompute remaining assets after stage execution (same logic as neededAssets above)
  const remainingAssets: string[] = [];
  for (const char of analysis.characters) {
    const frontKey = `character:${char.name}:front`;
    const angleKey = `character:${char.name}:angle`;
    if (!state.generatedAssets[frontKey]) remainingAssets.push(frontKey);
    if (!state.generatedAssets[angleKey]) remainingAssets.push(angleKey);
  }
  for (const loc of analysis.locations) {
    const locKey = `location:${loc.name}:front`;
    if (!state.generatedAssets[locKey]) remainingAssets.push(locKey);
  }
  for (const obj of (analysis.objects ?? [])) {
    const objKey = `object:${obj.name}:front`;
    if (!state.generatedAssets[objKey]) remainingAssets.push(objKey);
  }
  if (remainingAssets.length > 0) {
    console.warn(`[asset_generation] WARNING: ${remainingAssets.length} assets still missing. NOT marking as complete — will resume on next run.`);
    return state;
  }
  state.completedStages.push("asset_generation");
  state.currentStage = "frame_generation";
  return state;
}

// ---------------------------------------------------------------------------
// Stage 4: Frame Generation
// ---------------------------------------------------------------------------

async function runFrameGenerationStage(
  state: PipelineState,
  options: PipelineOptions,
): Promise<PipelineState> {
  if (!state.storyAnalysis) {
    throw new Error("Frame generation requires storyAnalysis in state");
  }
  // assetLibrary may have placeholder entries for imported runs — that's fine.
  // If completely missing, create an empty one so downstream code doesn't crash.
  if (!state.assetLibrary) {
    state.assetLibrary = { characterImages: {}, locationImages: {}, objectImages: {} };
  }
  if (!state.assetLibrary.objectImages) {
    state.assetLibrary.objectImages = {};
  }

  const analysis = state.storyAnalysis;
  const allShots = analysis.scenes.flatMap((s) => s.shots || []);

  // Safety guard: first shot of each scene must never be continuousFromPrevious
  for (const shot of allShots) {
    if (shot.shotInScene === 1 && shot.continuousFromPrevious) {
      console.log(`[frame_generation] Safety guard: forcing continuousFromPrevious=false for shot ${shot.shotNumber} (first shot of scene ${shot.sceneNumber})`);
      shot.continuousFromPrevious = false;
    }
  }

  // Determine which frames still need generation (all shots use first_last_frame)
  const neededFrames = allShots.filter((s) => {
    const existing = state.generatedFrames[s.shotNumber];
    return !existing || !existing.start || !existing.end;
  });

  const hasPendingInstructions = (state.pendingStageInstructions["frame_generation"]?.length ?? 0) > 0;
  const hasDirectives = hasItemDirectivesForStage(state, "frame_generation");
  if (neededFrames.length === 0 && !hasPendingInstructions && !hasDirectives) {
    console.log("[frame_generation] All frames already generated, skipping.");
    state.completedStages.push("frame_generation");
    state.currentStage = "video_generation";
    return state;
  }

  const stateJson = compactState(state, 'frame_generation');
  const systemPrompt = `You are a frame generation agent. Generate start and end keyframe images for all shots.

Current pipeline state:
${stateJson}

For each shot that doesn't already have frames in state.generatedFrames, call generateFrame with the shot data, art style, and asset library.

IMPORTANT:
- All shots use first_last_frame generation and need keyframes.
- Check state.generatedFrames[shotNumber] before generating — skip if start and end already exist.
- After EACH successful generation, call saveState to checkpoint progress.
- Pass dryRun=${options.dryRun} to generateFrame.
- Use outputDir="${options.outputDir}".
- Art style: "${analysis.artStyle}"

CROSS-SHOT CONTINUITY:
- Generate frames IN SHOT ORDER within each scene (shot 1 first, then shot 2, etc.)
- For each shot AFTER the first in a scene, pass previousEndFramePath = the end frame path of the immediately preceding shot
- When continuousFromPrevious=true: the previous end frame is COPIED as this shot's start frame (hard copy via fs.copyFileSync). Only the end frame is generated. This is intentional — "continuous" means the same camera a few seconds later.
- When continuousFromPrevious=false: the previous end frame is used as a low-priority STYLE REFERENCE for art style, lighting, and color palette consistency. The start frame is generated from this shot's own startFramePrompt.
- The first shot of each scene does NOT need previousEndFramePath
- Look up the previous shot's end frame from state.generatedFrames[previousShotNumber].end

Example: When generating shot 3 (continuousFromPrevious=false), if shot 2's end frame is at state.generatedFrames[2].end = "./output/frames/shot_2_end.png", pass previousEndFramePath="./output/frames/shot_2_end.png" to generateFrame for shot 3. Shot 3's start frame will be generated from shot 3's own startFramePrompt, using shot 2's end frame only as a style reference. If shot 3 has continuousFromPrevious=true, shot 2's end frame will be copied as shot 3's start frame.

Shots needing frames: ${neededFrames.map((s) => `Shot ${s.shotNumber}`).join(", ")}`;

  const userPrompt = `Generate keyframes for ${neededFrames.length} shots that need first_last_frame generation.`;

  const frameTools: Record<string, any> = {
    generateFrame: {
      description: generateFrameTool.description,
      inputSchema: generateFrameTool.parameters,
      execute: wrapToolExecute("frame_generation", "generateFrame", async (params: z.infer<typeof generateFrameTool.parameters>) => {
        const result = await generateFrame({
          shot: { ...params.shot, objectsPresent: params.shot.objectsPresent ?? [] },
          artStyle: params.artStyle,
          assetLibrary: { ...params.assetLibrary, objectImages: params.assetLibrary.objectImages ?? {} },
          outputDir: options.outputDir,
          dryRun: options.dryRun,
          previousEndFramePath: params.previousEndFramePath,
          videoBackend: options.videoBackend,
          aspectRatio: options.aspectRatio,
        });
        if (result.startPath) {
          trackFrameVersion(state, result.shotNumber, "start", result.startPath, {
            references: result.startReferences,
          });
        }
        if (result.endPath) {
          trackFrameVersion(state, result.shotNumber, "end", result.endPath, {
            references: result.endReferences,
          });
        }
        state.generatedFrames[result.shotNumber] = {
          start: result.startPath,
          end: result.endPath,
          startReferences: result.startReferences,
          endReferences: result.endReferences,
        };
        await saveState({ state });
        return result;
      }, options.onToolError, options.abortSignal),
    },
    saveState: {
      description: saveStateTool.description,
      inputSchema: saveStateTool.parameters,
      execute: wrapToolExecute("frame_generation", "saveState", async () => {
        return saveState({ state });
      }, options.onToolError, options.abortSignal),
    },
  };

  if (options.verify) {
    frameTools.verifyOutput = {
      description: verifyOutputTool.description,
      inputSchema: verifyOutputTool.parameters,
      execute: wrapToolExecute("frame_generation", "verifyOutput", async (params: z.infer<typeof verifyOutputTool.parameters>) => {
        return verifyOutput({ ...params, dryRun: options.dryRun });
      }, options.onToolError, options.abortSignal),
    };
  }

  await runStage("frame_generation", state, options, systemPrompt, userPrompt, frameTools, 60, options.verbose);

  // Recompute remaining frames after stage execution
  const remainingFrames = allShots.filter((s) => {
    const existing = state.generatedFrames[s.shotNumber];
    return !existing || !existing.start || !existing.end;
  });
  if (remainingFrames.length > 0) {
    console.warn(`[frame_generation] WARNING: ${remainingFrames.length}/${allShots.length} frames still missing. NOT marking as complete — will resume on next run.`);
    return state;
  }
  state.completedStages.push("frame_generation");
  state.currentStage = "video_generation";
  return state;
}

// ---------------------------------------------------------------------------
// Stage 5: Video Generation
// ---------------------------------------------------------------------------

async function runVideoGenerationStage(
  state: PipelineState,
  options: PipelineOptions,
): Promise<PipelineState> {
  if (!state.storyAnalysis) {
    throw new Error("Video generation requires storyAnalysis in state");
  }

  const analysis = state.storyAnalysis;
  const allShots = analysis.scenes.flatMap((s) => s.shots || []);

  // Determine which videos still need generation
  const neededVideos = allShots.filter((s) => !state.generatedVideos[s.shotNumber]);

  const hasPendingInstructions = (state.pendingStageInstructions["video_generation"]?.length ?? 0) > 0;
  const hasDirectives = hasItemDirectivesForStage(state, "video_generation");
  if (neededVideos.length === 0 && !hasPendingInstructions && !hasDirectives) {
    console.log("[video_generation] All videos already generated, skipping.");
    state.completedStages.push("video_generation");
    state.currentStage = "assembly";
    return state;
  }

  const stateJson = compactState(state, 'video_generation');
  const systemPrompt = `You are a video generation agent. Generate video clips for each shot using first+last frame interpolation.

Current pipeline state:
${stateJson}

Generate video clips ONE AT A TIME. Call generateVideo for ONE shot, wait for the result, then proceed to the next shot.

CRITICAL: You MUST only call generateVideo ONCE per response. After each call completes, call saveState, then call generateVideo for the next shot. NEVER call generateVideo multiple times in the same response.

For each shot:
- Provide startFramePath and endFramePath from state.generatedFrames
- All shots use first_last_frame generation with start and end keyframes

Rules:
- Generate ONE video per step. Do NOT batch multiple generateVideo calls.
- Check state.generatedVideos[shotNumber] before generating — skip if already exists.
- After EACH successful generation, call saveState to checkpoint progress.
- Pass dryRun=${options.dryRun} to generateVideo.
- Use outputDir="${join(options.outputDir, "videos")}" for all videos.
- Process shots in order (by shotNumber).

Shots needing videos: ${neededVideos.map((s) => `Shot ${s.shotNumber}`).join(", ")}`;

  const userPrompt = `Generate video clips for ${neededVideos.length} shots. Process them in order by shot number.`;

  const raiRegenAttempts = new Map<number, number>();

  const videoTools: Record<string, any> = {
    generateVideo: {
      description: generateVideoTool.description,
      inputSchema: generateVideoTool.parameters,
      execute: wrapToolExecute("video_generation", "generateVideo", async (params: z.infer<typeof generateVideoTool.parameters>) => {
        // Inject video directives directly into the action prompt
        let actionPrompt = params.actionPrompt;
        const videoDirective = Object.values(state.itemDirectives).find(
          d => d.target === `shot:${params.shotNumber}:video`
        );
        if (videoDirective && !actionPrompt.includes(videoDirective.directive)) {
          actionPrompt = `${actionPrompt}. IMPORTANT DIRECTOR NOTE: ${videoDirective.directive}`;
          console.log(`[video_generation] Injected video directive for shot ${params.shotNumber}: "${videoDirective.directive.substring(0, 100)}"`);
        }
        try {
          const result = await generateVideo({
            ...params,
            actionPrompt,
            dryRun: options.dryRun,
            outputDir: join(options.outputDir, "videos"),
            abortSignal: options.abortSignal,
            videoBackend: options.videoBackend,
            aspectRatio: options.aspectRatio,
            onProgress: options.onProgress,
            characterNames: state.storyAnalysis?.characters.map(c => c.name) ?? [],
            pendingJobStore: {
              get: (key) => state.pendingJobs[key],
              set: async (key, value) => { state.pendingJobs[key] = value; await saveState({ state }); },
              delete: async (key) => { delete state.pendingJobs[key]; await saveState({ state }); },
            },
          });
          // Post-generation pacing analysis (Grok only, single pass — no re-analysis)
          if (options.videoBackend === "grok" && result.path && !options.dryRun) {
            try {
              const analysis = await analyzeClipPacing(result.path, result.shotNumber, result.duration);
              console.log(`[pacing] Shot ${result.shotNumber}: ${result.duration}s → ${analysis.recommendedDuration}s (${analysis.reason})`);

              const savings = result.duration - analysis.recommendedDuration;
              if (savings >= 1 && analysis.confidence !== "low") {
                console.log(`[pacing] Regenerating shot ${result.shotNumber} at ${analysis.recommendedDuration}s (saving ${savings.toFixed(1)}s)`);

                const regenResult = await generateVideo({
                  ...params,
                  actionPrompt,
                  durationSeconds: Math.round(analysis.recommendedDuration),
                  dryRun: options.dryRun,
                  outputDir: join(options.outputDir, "videos"),
                  abortSignal: options.abortSignal,
                  videoBackend: options.videoBackend,
                  aspectRatio: options.aspectRatio,
                  onProgress: options.onProgress,
                  characterNames: state.storyAnalysis?.characters.map(c => c.name) ?? [],
                  pendingJobStore: {
                    get: (key) => state.pendingJobs[key],
                    set: async (key, value) => { state.pendingJobs[key] = value; await saveState({ state }); },
                    delete: async (key) => { delete state.pendingJobs[key]; await saveState({ state }); },
                  },
                });

                trackVideoVersion(state, regenResult.shotNumber, regenResult.path, {
                  duration: regenResult.duration,
                  promptSent: regenResult.promptSent,
                  pacingAdjusted: true,
                });
                state.generatedVideos[regenResult.shotNumber] = regenResult.path;
                if (regenResult.promptSent) {
                  if (!state.videoPromptsSent) state.videoPromptsSent = {};
                  state.videoPromptsSent[regenResult.shotNumber] = regenResult.promptSent;
                }
                await saveState({ state });
                return { ...regenResult, pacingAdjusted: true, originalDuration: result.duration, newDuration: analysis.recommendedDuration };
              }
            } catch (err) {
              console.warn(`[pacing] Failed to analyze shot ${result.shotNumber}, keeping original:`, err);
            }
          }

          trackVideoVersion(state, result.shotNumber, result.path, {
            duration: result.duration,
            promptSent: result.promptSent,
          });
          state.generatedVideos[result.shotNumber] = result.path;
          if (result.promptSent) {
            if (!state.videoPromptsSent) state.videoPromptsSent = {};
            state.videoPromptsSent[result.shotNumber] = result.promptSent;
          }
          await saveState({ state });
          return result;
        } catch (error: any) {
          if (error?.name === 'RaiCelebrityError') {
            const attempts = (raiRegenAttempts.get(params.shotNumber) ?? 0) + 1;
            raiRegenAttempts.set(params.shotNumber, attempts);

            if (attempts >= 2) {
              console.warn(`[video_generation] Shot ${params.shotNumber}: RAI celebrity filter triggered ${attempts} times. Skipping shot.`);
              return {
                shotNumber: params.shotNumber,
                skipped: true,
                error: `RAI celebrity filter triggered ${attempts} times. Skipping this shot.`,
              };
            }

            console.warn(`[video_generation] Shot ${params.shotNumber}: RAI celebrity filter triggered. Deleting frames for regeneration.`);

            // Delete the offending frames from state so frame_generation will regenerate them
            delete state.generatedFrames[params.shotNumber];

            // Ensure frame_generation re-runs on the next pass.
            state.completedStages = state.completedStages.filter(
              (stage) => stage !== "frame_generation",
            );
            await saveState({ state });

            console.log(`[video_generation] Shot ${params.shotNumber}: State saved. Continuing with remaining shots.`);

            // Tell the stage agent to skip this shot for now and continue with the others.
            return {
              shotNumber: params.shotNumber,
              error: `RAI celebrity filter triggered. Frames for shot ${params.shotNumber} deleted. SKIP this shot and CONTINUE generating videos for all remaining shots. The frames will be regenerated on the next pass.`,
              raiTriggered: true,
            };
          }
          throw error;
        }
      }, options.onToolError, options.abortSignal),
    },
    saveState: {
      description: saveStateTool.description,
      inputSchema: saveStateTool.parameters,
      execute: wrapToolExecute("video_generation", "saveState", async () => {
        return saveState({ state });
      }, options.onToolError, options.abortSignal),
    },
  };

  if (options.verify) {
    videoTools.verifyOutput = {
      description: verifyOutputTool.description,
      inputSchema: verifyOutputTool.parameters,
      execute: wrapToolExecute("video_generation", "verifyOutput", async (params: z.infer<typeof verifyOutputTool.parameters>) => {
        return verifyOutput({ ...params, dryRun: options.dryRun });
      }, options.onToolError, options.abortSignal),
    };
  }

  await runStage("video_generation", state, options, systemPrompt, userPrompt, videoTools, 80, options.verbose);

  // Recompute remaining videos after stage execution
  const remainingVideos = allShots.filter((s) => !state.generatedVideos[s.shotNumber]);
  if (remainingVideos.length > 0) {
    const missingFrames = remainingVideos.filter(
      (shot) => !state.generatedFrames[shot.shotNumber]?.start,
    );
    if (missingFrames.length > 0) {
      console.log(`[video_generation] ${missingFrames.length} shots need frame regeneration. Rolling back to frame_generation.`);
      state.completedStages = state.completedStages.filter((stage) => stage !== "frame_generation");
      state.rollbackTarget = "frame_generation";
      await saveState({ state });
    }
    console.warn(`[video_generation] WARNING: ${remainingVideos.length}/${allShots.length} videos still missing. NOT marking as complete — will resume on next run.`);
    return state;
  }
  state.completedStages.push("video_generation");
  state.currentStage = "assembly";
  return state;
}

// ---------------------------------------------------------------------------
// Stage: Shot Generation (Grok combined frame + video)
// ---------------------------------------------------------------------------

async function runShotGenerationStage(
  state: PipelineState,
  options: PipelineOptions,
): Promise<PipelineState> {
  if (!state.storyAnalysis) {
    throw new Error("Shot generation requires storyAnalysis in state");
  }
  if (!state.assetLibrary) {
    state.assetLibrary = { characterImages: {}, locationImages: {}, objectImages: {} };
  }
  if (!state.assetLibrary.objectImages) {
    state.assetLibrary.objectImages = {};
  }

  const analysis = state.storyAnalysis;
  const allShots = analysis.scenes.flatMap((s) => s.shots || []);

  // Determine which shots still need video generation (the final output)
  const neededShots = allShots.filter((s) => !state.generatedVideos[s.shotNumber]);

  const hasPendingInstructions = (state.pendingStageInstructions["shot_generation"]?.length ?? 0) > 0;
  const hasDirectives = hasItemDirectivesForStage(state, "shot_generation");
  if (neededShots.length === 0 && !hasPendingInstructions && !hasDirectives) {
    console.log("[shot_generation] All shots already generated, skipping.");
    state.completedStages.push("shot_generation");
    state.currentStage = "assembly";
    return state;
  }

  const stateJson = compactState(state, 'shot_generation');
  const systemPrompt = `You are a shot generation agent for the Grok video backend. For each shot, you generate a start frame image and then generate a video from that frame.

Current pipeline state:
${stateJson}

Process shots ONE AT A TIME, in shot number order. For each shot:
1. First, call generateFrame to create the start frame image (the Grok backend only uses start frames, not end frames).
2. Then, call generateVideo with the start frame path to generate the video clip.
3. After each shot completes (both frame and video), call saveState to checkpoint progress.

IMPORTANT RULES:
- Process ONE shot at a time: generateFrame → generateVideo → saveState → next shot.
- Check state.generatedVideos[shotNumber] before processing — skip shots that already have videos.
- If a shot already has a start frame in state.generatedFrames[shotNumber].start, skip generateFrame and go straight to generateVideo.
- Pass dryRun=${options.dryRun} to both generateFrame and generateVideo.
- Use outputDir="${options.outputDir}" for frames.
- Use outputDir="${join(options.outputDir, "videos")}" for videos.
- Art style: "${analysis.artStyle}"
- The Grok backend does NOT use end frames. generateFrame will handle this — just pass the shot data.
- Each shot is independent — no cross-shot continuity via end frames.

Shots needing generation: ${neededShots.map((s) => `Shot ${s.shotNumber}`).join(", ")}`;

  const userPrompt = `Generate frames and videos for ${neededShots.length} shots using the Grok backend. Process them in order by shot number.`;

  const shotGenTools: Record<string, any> = {
    generateFrame: {
      description: generateFrameTool.description,
      inputSchema: generateFrameTool.parameters,
      execute: wrapToolExecute("shot_generation", "generateFrame", async (params: z.infer<typeof generateFrameTool.parameters>) => {
        const result = await generateFrame({
          shot: { ...params.shot, objectsPresent: params.shot.objectsPresent ?? [] },
          artStyle: params.artStyle,
          assetLibrary: { ...params.assetLibrary, objectImages: params.assetLibrary.objectImages ?? {} },
          outputDir: options.outputDir,
          dryRun: options.dryRun,
          previousEndFramePath: params.previousEndFramePath,
          videoBackend: options.videoBackend,
          aspectRatio: options.aspectRatio,
        });
        if (result.startPath) {
          trackFrameVersion(state, result.shotNumber, "start", result.startPath, {
            references: result.startReferences,
          });
        }
        if (result.endPath) {
          trackFrameVersion(state, result.shotNumber, "end", result.endPath, {
            references: result.endReferences,
          });
        }
        state.generatedFrames[result.shotNumber] = {
          start: result.startPath,
          end: result.endPath,
          startReferences: result.startReferences,
          endReferences: result.endReferences,
        };
        await saveState({ state });
        return result;
      }, options.onToolError, options.abortSignal),
    },
    generateVideo: {
      description: generateVideoTool.description,
      inputSchema: generateVideoTool.parameters,
      execute: wrapToolExecute("shot_generation", "generateVideo", async (params: z.infer<typeof generateVideoTool.parameters>) => {
        // Inject video directives directly into the action prompt
        let actionPrompt = params.actionPrompt;
        const videoDirective = Object.values(state.itemDirectives).find(
          d => d.target === `shot:${params.shotNumber}:video`
        );
        if (videoDirective && !actionPrompt.includes(videoDirective.directive)) {
          actionPrompt = `${actionPrompt}. IMPORTANT DIRECTOR NOTE: ${videoDirective.directive}`;
          console.log(`[shot_generation] Injected video directive for shot ${params.shotNumber}: "${videoDirective.directive.substring(0, 100)}"`);
        }
        const result = await generateVideo({
          ...params,
          actionPrompt,
          dryRun: options.dryRun,
          outputDir: join(options.outputDir, "videos"),
          abortSignal: options.abortSignal,
          videoBackend: options.videoBackend,
          aspectRatio: options.aspectRatio,
          onProgress: options.onProgress,
          characterNames: state.storyAnalysis?.characters.map(c => c.name) ?? [],
          pendingJobStore: {
            get: (key) => state.pendingJobs[key],
            set: async (key, value) => { state.pendingJobs[key] = value; await saveState({ state }); },
            delete: async (key) => { delete state.pendingJobs[key]; await saveState({ state }); },
          },
        });
        // Post-generation pacing analysis (Grok only, single pass — no re-analysis)
        let finalResult = result;
        if (options.videoBackend === "grok" && result.path && !options.dryRun) {
          try {
            const analysis = await analyzeClipPacing(result.path, result.shotNumber, result.duration);
            console.log(`[pacing] Shot ${result.shotNumber}: ${result.duration}s → ${analysis.recommendedDuration}s (${analysis.reason})`);

            const savings = result.duration - analysis.recommendedDuration;
            if (savings >= 1 && analysis.confidence !== "low") {
              console.log(`[pacing] Regenerating shot ${result.shotNumber} at ${analysis.recommendedDuration}s (saving ${savings.toFixed(1)}s)`);

              const regenResult = await generateVideo({
                ...params,
                actionPrompt,
                durationSeconds: Math.round(analysis.recommendedDuration),
                dryRun: options.dryRun,
                outputDir: join(options.outputDir, "videos"),
                abortSignal: options.abortSignal,
                videoBackend: options.videoBackend,
                aspectRatio: options.aspectRatio,
                onProgress: options.onProgress,
                characterNames: state.storyAnalysis?.characters.map(c => c.name) ?? [],
                pendingJobStore: {
                  get: (key) => state.pendingJobs[key],
                  set: async (key, value) => { state.pendingJobs[key] = value; await saveState({ state }); },
                  delete: async (key) => { delete state.pendingJobs[key]; await saveState({ state }); },
                },
              });

              finalResult = { ...regenResult, pacingAdjusted: true, originalDuration: result.duration, newDuration: analysis.recommendedDuration } as any;
            }
          } catch (err) {
            console.warn(`[pacing] Failed to analyze shot ${result.shotNumber}, keeping original:`, err);
          }
        }

        trackVideoVersion(state, finalResult.shotNumber, finalResult.path, {
          duration: finalResult.duration,
          promptSent: finalResult.promptSent,
          pacingAdjusted: (finalResult as any).pacingAdjusted,
        });
        state.generatedVideos[finalResult.shotNumber] = finalResult.path;
        if (finalResult.promptSent) {
          if (!state.videoPromptsSent) state.videoPromptsSent = {};
          state.videoPromptsSent[finalResult.shotNumber] = finalResult.promptSent;
        }

        // Extract last frame from generated video as end frame
        if (!options.dryRun && finalResult.path) {
          const framesDir = join(options.outputDir, "frames");
          const endFramePath = join(framesDir, `shot_${finalResult.shotNumber}_end.png`);
          try {
            mkdirSync(framesDir, { recursive: true });
            const execFileAsync = promisify(execFileCb);
            await execFileAsync("ffmpeg", [
              "-y", "-sseof", "-0.1", "-i", finalResult.path,
              "-frames:v", "1", "-update", "1",
              endFramePath,
            ]);
            if (!state.generatedFrames[finalResult.shotNumber]) {
              state.generatedFrames[finalResult.shotNumber] = { start: undefined };
            }
            trackFrameVersion(state, finalResult.shotNumber, "end", endFramePath);
            state.generatedFrames[finalResult.shotNumber].end = endFramePath;
            state.generatedFrames[finalResult.shotNumber].endReferences = undefined;
            console.log(`[shot_generation] Extracted end frame for shot ${finalResult.shotNumber}: ${endFramePath}`);
          } catch (err) {
            console.warn(`[shot_generation] Failed to extract end frame for shot ${finalResult.shotNumber}:`, err);
          }
        }

        await saveState({ state });
        return finalResult;
      }, options.onToolError, options.abortSignal),
    },
    saveState: {
      description: saveStateTool.description,
      inputSchema: saveStateTool.parameters,
      execute: wrapToolExecute("shot_generation", "saveState", async () => {
        return saveState({ state });
      }, options.onToolError, options.abortSignal),
    },
  };

  if (options.verify) {
    shotGenTools.verifyOutput = {
      description: verifyOutputTool.description,
      inputSchema: verifyOutputTool.parameters,
      execute: wrapToolExecute("shot_generation", "verifyOutput", async (params: z.infer<typeof verifyOutputTool.parameters>) => {
        return verifyOutput({ ...params, dryRun: options.dryRun });
      }, options.onToolError, options.abortSignal),
    };
  }

  await runStage("shot_generation", state, options, systemPrompt, userPrompt, shotGenTools, 120, options.verbose);

  // Recompute remaining shots after stage execution
  const remainingShots = allShots.filter((s) => !state.generatedVideos[s.shotNumber]);
  if (remainingShots.length > 0) {
    console.warn(`[shot_generation] WARNING: ${remainingShots.length}/${allShots.length} shots still missing. NOT marking as complete — will resume on next run.`);
    return state;
  }
  state.completedStages.push("shot_generation");
  state.currentStage = "assembly";
  return state;
}

// ---------------------------------------------------------------------------
// Stage 6: Assembly
// ---------------------------------------------------------------------------

async function runAssemblyStage(
  state: PipelineState,
  options: PipelineOptions,
): Promise<PipelineState> {
  if (!state.storyAnalysis) {
    throw new Error("Assembly requires storyAnalysis in state");
  }

  // Collect all video paths in shot order
  const allShots = state.storyAnalysis.scenes.flatMap((s) => s.shots || []);
  const sortedShots = [...allShots].sort((a, b) => a.shotNumber - b.shotNumber);
  const videoPaths = sortedShots
    .map((s) => state.generatedVideos[s.shotNumber])
    .filter((p): p is string => !!p);

  if (videoPaths.length === 0) {
    console.log("[assembly] No videos to assemble.");
    state.completedStages.push("assembly");
    return state;
  }

  // Extract transitions from scenes
  // Build a map of scene number to transition type
  const sceneTransitions: Record<number, string> = {};
  for (const scene of state.storyAnalysis.scenes) {
    sceneTransitions[scene.sceneNumber] = scene.transition || "cut";
  }

  // Build transitions array: one per scene boundary
  // transitions[i] is the transition BEFORE the first video of scene i+2
  const transitions: Array<{ type: "cut" | "fade_black"; durationMs: number }> = [];

  for (let i = 0; i < sortedShots.length - 1; i++) {
    const currentShot = sortedShots[i];
    const nextShot = sortedShots[i + 1];

    // Check if we're crossing a scene boundary
    if (nextShot.sceneNumber !== currentShot.sceneNumber) {
      // Add transition for the next scene
      const nextSceneTransition = sceneTransitions[nextShot.sceneNumber] || "cut";
      const durationMs = nextSceneTransition === "fade_black" ? 750 : 500;
      transitions.push({
        type: nextSceneTransition as "cut" | "fade_black",
        durationMs,
      });
    }
  }

  // Compute subtitle timing from sorted shots' cumulative durations
  // Account for xfade transition overlaps at scene boundaries
  const subtitles: Array<{ startSec: number; endSec: number; text: string }> = [];
  let cumulativeTime = 0;
  let prevSceneNumber: number | undefined;
  for (const shot of sortedShots) {
    // Only include shots that have a generated video
    if (!state.generatedVideos[shot.shotNumber]) {
      continue;
    }
    // Subtract xfade overlap when crossing a scene boundary
    if (prevSceneNumber !== undefined && shot.sceneNumber !== prevSceneNumber) {
      const trans = sceneTransitions[shot.sceneNumber] || "cut";
      if (trans === "fade_black") {
        cumulativeTime -= 0.75; // 750ms overlap
      }
    }
    prevSceneNumber = shot.sceneNumber;
    const duration = shot.durationSeconds;
    if (shot.dialogue && shot.dialogue.trim().length > 0) {
      subtitles.push({
        startSec: cumulativeTime,
        endSec: cumulativeTime + duration,
        text: shot.dialogue.trim(),
      });
    }
    cumulativeTime += duration;
  }

  const subtitleInfo = subtitles.length > 0
    ? `\nSubtitles (${subtitles.length} dialogue entries): ${JSON.stringify(subtitles)}`
    : "\nNo dialogue subtitles to burn.";

  const systemPrompt = `You are a video assembly agent. Assemble all generated video clips into a single final video with scene transitions.

Scene transitions from the shot plan:
${JSON.stringify(state.storyAnalysis.scenes.map(s => ({ scene: s.sceneNumber, transition: s.transition || "cut" })))}

Call assembleVideo with the ordered list of video paths, transitions array, and subtitles. Then call saveState to checkpoint.

Video paths (in order): ${JSON.stringify(videoPaths)}
Transitions (one per scene boundary): ${JSON.stringify(transitions)}${subtitleInfo}
Output directory: "${options.outputDir}"`;

  const userPrompt = `Assemble ${videoPaths.length} video clips into the final video with ${transitions.length} scene transitions and ${subtitles.length} subtitle entries.`;

  const assemblyTools = {
    assembleVideo: {
      description: assembleVideoTool.description,
      inputSchema: assembleVideoTool.parameters,
      execute: wrapToolExecute("assembly", "assembleVideo", async (params: z.infer<typeof assembleVideoTool.parameters>) => {
        return assembleVideo({
          ...params,
          subtitles,
          importedAudio: state.importedAudio,
          dryRun: options.dryRun,
        });
      }, options.onToolError, options.abortSignal),
    },
    saveState: {
      description: saveStateTool.description,
      inputSchema: saveStateTool.parameters,
      execute: wrapToolExecute("assembly", "saveState", async () => {
        return saveState({ state });
      }, options.onToolError, options.abortSignal),
    },
  };

  await runStage("assembly", state, options, systemPrompt, userPrompt, assemblyTools, 10, options.verbose);

  state.completedStages.push("assembly");
  return state;
}

// ---------------------------------------------------------------------------
// Main pipeline entry point
// ---------------------------------------------------------------------------

export async function runPipeline(
  storyText: string,
  options: PipelineOptions,
): Promise<void> {
  // Load or create state
  let state: PipelineState;

  if (options.resume) {
    const loaded = loadState(options.outputDir);
    if (loaded) {
      console.log("Resuming from saved state...");
      console.log(`  Completed stages: ${loaded.completedStages.join(", ") || "(none)"}`);
      console.log(`  Current stage: ${loaded.currentStage}`);
      state = loaded;
      state.interrupted = false;
    } else {
      console.log("No saved state found, starting fresh.");
      state = createInitialState("(resumed)", options.outputDir);
    }
  } else {
    state = createInitialState("(input)", options.outputDir);
  }

  // Handle --skip-to: mark earlier stages as completed
  if (options.skipTo) {
    const skipIdx = STAGE_ORDER.indexOf(options.skipTo as StageName);
    if (skipIdx < 0) {
      throw new Error(`Unknown stage: ${options.skipTo}. Valid stages: ${STAGE_ORDER.join(", ")}`);
    }
    // Load state for skip-to (need prior stage data)
    const loaded = loadState(options.outputDir);
    if (loaded) {
      state = loaded;
      state.interrupted = false;
    }
    // Mark all stages before skipTo as completed
    for (let i = 0; i < skipIdx; i++) {
      if (!state.completedStages.includes(STAGE_ORDER[i])) {
        state.completedStages.push(STAGE_ORDER[i]);
      }
    }
    // Remove the target stage and all subsequent stages from completedStages
    // so they will be re-run
    for (let i = skipIdx; i < STAGE_ORDER.length; i++) {
      const idx = state.completedStages.indexOf(STAGE_ORDER[i]);
      if (idx !== -1) {
        state.completedStages.splice(idx, 1);
      }
    }
    state.currentStage = options.skipTo;
    console.log(`Skipping to stage: ${options.skipTo}`);
  }

  // Handle --redo: clear data from target stage onward and re-run
  if (options.redo) {
    const redoIdx = STAGE_ORDER.indexOf(options.redo as StageName);
    if (redoIdx < 0) {
      throw new Error(`Unknown stage: ${options.redo}. Valid stages: ${STAGE_ORDER.join(", ")}`);
    }
    // Load existing state
    const loaded = loadState(options.outputDir);
    if (loaded) {
      state = loaded;
      state.interrupted = false;
    }
    // Clear data from the target stage onward
    clearStageData(state, options.redo as StageName, options.outputDir);
    // Save the cleared state immediately
    await saveState({ state });
    console.log(`Redoing stage: ${options.redo}`);
    console.log(`Cleared data from ${options.redo} onward`);
  }

  if (options.reviewMode && state.awaitingUserReview) {
    if (!state.continueRequested) {
      console.log("\nAwaiting user review before continuing.");
      return;
    }
    state.awaitingUserReview = false;
    state.continueRequested = false;
  }

  // Stage loop
  const isGrok = options.videoBackend === "grok";
  const stageRunners: Record<StageName, (s: PipelineState, o: PipelineOptions) => Promise<PipelineState>> = {
    analysis: (s, o) => runAnalysisStage(s, storyText, o),
    shot_planning: runShotPlanningStage,
    asset_generation: runAssetGenerationStage,
    frame_generation: runFrameGenerationStage,
    video_generation: runVideoGenerationStage,
    shot_generation: runShotGenerationStage,
    assembly: runAssemblyStage,
  };

  // Before the stage loop, check if any completed stage has pending instructions
  // If so, remove it from completedStages so it gets re-run
  const stagesToRerun: string[] = [];
  for (const stageName of [...state.completedStages]) {
    if (state.pendingStageInstructions[stageName]?.length > 0) {
      console.log(`Re-running completed stage ${stageName} due to pending instructions`);
      stagesToRerun.push(stageName);
    }
  }
  if (stagesToRerun.length > 0) {
    state.completedStages = state.completedStages.filter(s => !stagesToRerun.includes(s));
    // Update currentStage to the earliest stage being re-run so the UI shows the correct stage
    const earliestIdx = Math.min(...stagesToRerun.map(s => STAGE_ORDER.indexOf(s as StageName)));
    state.currentStage = STAGE_ORDER[earliestIdx];
    await saveState({ state });
  }

  // Outer loop to handle stage rollbacks (e.g., RAI celebrity filter triggers re-generation)
  let maxRollbacks = 5;
  while (maxRollbacks-- > 0) {
    let rolledBack = false;

    for (const stageName of STAGE_ORDER) {
      // Skip completed stages
      if (state.completedStages.includes(stageName)) {
        console.log(`Skipping completed stage: ${stageName}`);
        continue;
      }

      // Grok backend: skip frame_generation and video_generation (replaced by shot_generation)
      if (isGrok && (stageName === "frame_generation" || stageName === "video_generation")) {
        console.log(`Skipping ${stageName} (grok backend uses shot_generation instead)`);
        state.completedStages.push(stageName);
        continue;
      }

      // Non-grok backends: skip shot_generation (they use separate frame_generation + video_generation)
      if (!isGrok && stageName === "shot_generation") {
        console.log(`Skipping shot_generation (only used with grok backend)`);
        state.completedStages.push(stageName);
        continue;
      }

      // Check for interruption between stages
      if (interrupted || options.abortSignal?.aborted) {
        console.log("\nInterrupted between stages. Saving state...");
        state.interrupted = true;
        await saveState({ state });
        console.log("Pipeline interrupted. Resume with: storytovideo <story> --resume");
        return;
      }

      // Dry-run: skip generation stages 3-5, skip assembly entirely
      if (options.dryRun && stageName === "assembly") {
        console.log("\n[dry-run] Skipping assembly stage.");
        break;
      }

      state.currentStage = stageName;
      await saveState({ state });

      // Re-run stage until it completes (handles partial completions from AI agent hitting maxSteps)
      while (!state.completedStages.includes(stageName)) {
        // Check for interruption before each attempt
        if (interrupted || options.abortSignal?.aborted) {
          console.log("\nInterrupted during stage retry. Saving state...");
          state.interrupted = true;
          await saveState({ state });
          console.log("Pipeline interrupted. Resume with: storytovideo <story> --resume");
          return;
        }

        try {
          state = await stageRunners[stageName](state, options);
        } catch (error) {
          if (error instanceof StageRollbackError) {
            // Legacy path — kept for safety but main rollback is via state flag
            console.log(`\n[Rollback] ${error.message}`);
            console.log(`[Rollback] Restarting pipeline from ${error.targetStage}`);
            rolledBack = true;
            break; // break inner while loop
          }
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error(`\nError in stage ${stageName}: ${errMsg}`);
          state.errors.push({
            stage: stageName,
            error: errMsg,
            timestamp: new Date().toISOString(),
          });
          await saveState({ state });
          throw error;
        }

        // Check for rollback flag (set by tool handlers that can't throw through AI SDK)
        if (state.rollbackTarget) {
          const target = state.rollbackTarget;
          delete state.rollbackTarget;
          await saveState({ state });
          console.log(`\n[Rollback] Rolling back to ${target} (triggered by state flag)`);
          rolledBack = true;
          break; // break inner while loop
        }

        if (rolledBack) break; // break inner while after StageRollbackError (legacy path)

        if (!state.completedStages.includes(stageName)) {
          console.log(`[${stageName}] Stage incomplete, re-running...`);
          await saveState({ state });
        }
      }

      if (rolledBack) break; // break the for loop to restart from beginning

      delete state.pendingStageInstructions[stageName];

      const shouldPauseForReview =
        Boolean(options.reviewMode) && stageName !== "assembly";
      if (shouldPauseForReview) {
        state.awaitingUserReview = true;
        state.continueRequested = false;
      }

      // Save state between stages
      await saveState({ state });

      if (shouldPauseForReview) {
        console.log(
          `\nPaused after ${stageName}. Awaiting user review before ${state.currentStage}.`,
        );
        return;
      }

      // After shot_planning in dry-run mode, save analysis and stop
      if (options.dryRun && stageName === "shot_planning") {
        if (state.storyAnalysis) {
          const analysisPath = join(options.outputDir, "story_analysis.json");
          writeFileSync(analysisPath, JSON.stringify(state.storyAnalysis, null, 2));
          console.log(`\n[dry-run] Shot plan saved to ${analysisPath}`);

          // Log shot plan summary
          const allShots = state.storyAnalysis.scenes.flatMap((s) => s.shots || []);
          console.log(`\n=== Shot Plan Summary ===`);
          console.log(`Title: ${state.storyAnalysis.title}`);
          console.log(`Art Style: ${state.storyAnalysis.artStyle}`);
          console.log(`Characters: ${state.storyAnalysis.characters.map((c) => c.name).join(", ")}`);
          console.log(`Locations: ${state.storyAnalysis.locations.map((l) => l.name).join(", ")}`);
          console.log(`Scenes: ${state.storyAnalysis.scenes.length}`);
          console.log(`Total shots: ${allShots.length}`);
          for (const scene of state.storyAnalysis.scenes) {
            console.log(`\n  Scene ${scene.sceneNumber}: ${scene.title}`);
            for (const shot of scene.shots || []) {
              console.log(`    Shot ${shot.shotNumber}: ${shot.composition} (${shot.shotType}, ${shot.durationSeconds}s)`);
              if (shot.dialogue) {
                console.log(`      Dialogue: "${shot.dialogue.substring(0, 60)}${shot.dialogue.length > 60 ? "..." : ""}"`);
              }
            }
          }
        }
        console.log("\n[dry-run] Pipeline complete. Generation stages skipped.");
        return;
      }
    }

    if (!rolledBack) break; // all stages completed normally, exit outer loop
  }

  console.log("\n=== Pipeline Complete ===");
  if (state.storyAnalysis) {
    const allShots = state.storyAnalysis.scenes.flatMap((s) => s.shots || []);
    console.log(`Generated ${Object.keys(state.generatedAssets).length} assets`);
    console.log(`Generated ${Object.keys(state.generatedFrames).length} frame sets`);
    console.log(`Generated ${Object.keys(state.generatedVideos).length} videos`);
    console.log(`Total shots: ${allShots.length}`);
  }
}

// Export types and constants for use by other modules (e.g., server, CLI)
export type { StageName };
export { STAGE_ORDER };
