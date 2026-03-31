import { EventEmitter } from 'events';
import { execFileSync } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { join, resolve, isAbsolute } from 'path';
import { generateObject, generateText } from 'ai';
import { z } from 'zod';
import { getLlmModel, getLlmModelName, getLlmProviderName } from '../llm-provider.js';

import type { QueueName, WorkItem } from './types.js';
import { QueueManager } from './queue-manager.js';
import { rateLimiters } from './rate-limiter-registry.js';
import { PromptLogger } from './prompt-logger.js';
import { analyzeStory, buildAnalyzeStoryPrompt } from '../tools/analyze-story.js';
import { storyToScript, buildStoryToScriptPrompt } from '../tools/story-to-script.js';
import { planShotsForScene } from '../tools/plan-shots.js';
import {
  VIDEO_MODEL_LIMITATIONS,
  SHOT_PLANNING_PRINCIPLES,
  SHOT_PLANNING_RULES,
} from '../prompts.js';
import { generateAsset, buildAssetPrompt } from '../tools/generate-asset.js';
import { generateFrame } from '../tools/generate-frame.js';
import { generateVideo } from '../tools/generate-video.js';
import { assembleVideo, getVideoDuration } from '../tools/assemble-video.js';
import { analyzeVideoClip, buildAnalyzeVideoPrompt } from '../tools/analyze-video-pacing.js';
import type { StoryAnalysis, AssetLibrary, Shot } from '../types.js';

// ---------------------------------------------------------------------------
// Per-scene shot schema (matches plan-shots.ts perSceneShotSchema)
// ---------------------------------------------------------------------------

const perSceneShotSchema = z.object({
  shotInScene: z.number(),
  durationSeconds: z.number(),
  shotType: z.literal('first_last_frame'),
  composition: z.string(),
  startFramePrompt: z.string(),
  dialogue: z.string(),
  speaker: z.string(),
  soundEffects: z.string(),
  cameraDirection: z.string(),
  videoPrompt: z.string(),
  charactersPresent: z.array(z.string()),
  objectsPresent: z.array(z.string()),
  location: z.string(),
  continuousFromPrevious: z.boolean(),
});

const sceneShotsSchema = z.object({
  transition: z.enum(['cut', 'fade_black']),
  shots: z.array(perSceneShotSchema),
});

// ---------------------------------------------------------------------------
// Event types emitted by processors
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;

export interface ProcessorEvents {
  'item:started': { runId: string; item: WorkItem };
  'item:completed': { runId: string; item: WorkItem };
  'item:failed': { runId: string; item: WorkItem; error: string };
  'pipeline:pause': { runId: string; item: WorkItem; error: string };
}

// ---------------------------------------------------------------------------
// QueueProcessor — generic processor for any queue
// ---------------------------------------------------------------------------

export class QueueProcessor extends EventEmitter {
  private running = false;
  private workerPromises: Promise<void>[] = [];
  private activeAbortControllers = new Map<string, AbortController>();
  private promptLogger: PromptLogger;

  constructor(
    private readonly queueName: QueueName,
    private readonly queueManager: QueueManager,
    private readonly runId: string,
    private readonly concurrency: number = 2,
  ) {
    super();
    this.promptLogger = new PromptLogger(this.resolvedOutputDir());
  }

  /** Resolve the run's outputDir to an absolute path. */
  private resolvedOutputDir(): string {
    const outputDir = this.queueManager.getState().outputDir;
    if (isAbsolute(outputDir)) return outputDir;
    return resolve(process.cwd(), outputDir);
  }

  /** Convert an absolute path to a path relative to the run's outputDir. */
  private relativePath(absPath: string): string {
    const outputDir = this.resolvedOutputDir();
    if (absPath.startsWith(outputDir)) {
      let rel = absPath.slice(outputDir.length);
      if (rel.startsWith('/')) rel = rel.slice(1);
      return rel;
    }
    return absPath;
  }

  /** Resolve a potentially-relative path to absolute using the run's outputDir. */
  private absolutePath(relPath: string): string {
    if (isAbsolute(relPath)) return relPath;
    return join(this.resolvedOutputDir(), relPath);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Rebuild asset library from any already-completed assets in generatedOutputs
    this.rebuildAssetLibrary();
    this.workerPromises = [];
    for (let i = 0; i < this.concurrency; i++) {
      this.workerPromises.push(this.runWorker(i));
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.allSettled(this.workerPromises);
    this.workerPromises = [];
  }

  isRunning(): boolean {
    return this.running;
  }

  cancelItem(itemId: string): boolean {
    const controller = this.activeAbortControllers.get(itemId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private async runWorker(_workerId: number): Promise<void> {
    while (this.running) {
      const item = this.queueManager.claimNextReady(this.queueName);
      if (!item) {
        // No work available — wait before polling again
        await sleep(500);
        continue;
      }

      const abortController = new AbortController();
      this.activeAbortControllers.set(item.id, abortController);

      try {
        this.emit('item:started', { runId: this.runId, item });

        const outputs = await this.executeItem(item, abortController.signal);

        this.activeAbortControllers.delete(item.id);
        if (this.queueManager.markCompleted(item.id, outputs)) {
          // Seed downstream work items after completion
          this.seedDownstream(item, outputs);

          this.emit('item:completed', { runId: this.runId, item: { ...item, status: 'completed', outputs } });
        }

        this.queueManager.save();
      } catch (err) {
        this.activeAbortControllers.delete(item.id);

        // If aborted, mark as cancelled (not failed) and don't retry
        if (abortController.signal.aborted) {
          if (this.queueManager.cancelItem(item.id)) {
            this.emit('item:cancelled', { runId: this.runId, item: { ...item, status: 'cancelled' }, error: 'Cancelled by user' });
          }
          this.queueManager.save();
          continue;
        }

        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[QueueProcessor] Error processing ${item.type} (${item.itemKey}): ${errorMsg}`);
        const currentRetryCount = item.retryCount ?? 0;

        if (currentRetryCount < MAX_RETRIES) {
          // Re-queue for retry
          if (this.queueManager.requeueForRetry(item.id)) {
            this.emit('item:failed', {
              runId: this.runId,
              item: { ...item, status: 'pending', retryCount: currentRetryCount + 1 },
              error: `Retry ${currentRetryCount + 1}/${MAX_RETRIES}: ${errorMsg}`,
            });
          }
          this.queueManager.save();
        } else {
          // Max retries exceeded — mark as permanently failed and pause pipeline
          if (this.queueManager.markFailed(item.id, errorMsg)) {
            this.emit('item:failed', { runId: this.runId, item: { ...item, status: 'failed' }, error: errorMsg });
            this.emit('pipeline:pause', { runId: this.runId, item: { ...item, status: 'failed' }, error: errorMsg });
          }
          this.queueManager.save();
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Work item dispatch
  // ---------------------------------------------------------------------------

  private async executeItem(item: WorkItem, signal: AbortSignal): Promise<Record<string, unknown>> {
    switch (item.type) {
      case 'story_to_script': return this.handleStoryToScript(item, signal);
      case 'analyze_story': return this.handleAnalyzeStory(item, signal);
      case 'artifact': return this.handleArtifact(item);
      case 'name_run': return this.handleNameRun(item, signal);
      case 'plan_shots': return this.handlePlanShots(item, signal);
      case 'generate_asset': return this.handleGenerateAsset(item, signal);
      case 'generate_frame': return this.handleGenerateFrame(item, signal);
      case 'generate_video': return this.handleGenerateVideo(item, signal);
      case 'analyze_video': return this.handleAnalyzeVideo(item);
      case 'assemble': return this.handleAssemble(item);
      default:
        throw new Error(`Unknown work item type: ${item.type}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  private async handleStoryToScript(item: WorkItem, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    const storyText = item.inputs.storyText as string;
    this.promptLogger.log(item.itemKey, 'story_to_script', buildStoryToScriptPrompt(storyText), { model: getLlmModelName('strong') });
    const script = await storyToScript(storyText);
    this.queueManager.setConvertedScript(script);
    return { script };
  }

  private async handleAnalyzeStory(item: WorkItem, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    const state = this.queueManager.getState();
    // Use converted script if available, otherwise raw story
    const textToAnalyze = state.convertedScript ?? item.inputs.storyText as string;
    this.promptLogger.log(item.itemKey, 'analyze_story', buildAnalyzeStoryPrompt(textToAnalyze), { model: getLlmModelName('strong') });
    const analysis = await analyzeStory(textToAnalyze);
    this.queueManager.setStoryAnalysis(analysis);
    return { analysis };
  }

  private handleArtifact(item: WorkItem): Record<string, unknown> {
    const state = this.queueManager.getState();
    const artifactType = item.inputs.artifactType as string;

    if (!state.storyAnalysis) {
      // Backward compat: if no analysis yet, just pass through
      return { ...item.inputs };
    }

    switch (artifactType) {
      case 'character': {
        this.queueManager.updateCharacter(item.inputs.name as string, {
          physicalDescription: item.inputs.physicalDescription as string,
          personality: item.inputs.personality as string,
          ageRange: item.inputs.ageRange as string,
        });
        break;
      }
      case 'location': {
        this.queueManager.updateLocation(item.inputs.name as string, {
          visualDescription: item.inputs.visualDescription as string,
        });
        break;
      }
      case 'object': {
        this.queueManager.updateObject(item.inputs.name as string, {
          visualDescription: item.inputs.visualDescription as string,
        });
        break;
      }
      case 'scene': {
        this.queueManager.updateScene(item.inputs.sceneNumber as number, {
          title: item.inputs.title as string,
          narrativeSummary: item.inputs.narrativeSummary as string,
          charactersPresent: item.inputs.charactersPresent as string[],
          location: item.inputs.location as string,
          estimatedDurationSeconds: item.inputs.estimatedDurationSeconds as number,
        });
        break;
      }
      case 'pacing': {
        this.queueManager.updateAnalysisMeta({
          artStyle: item.inputs.artStyle as string,
          title: item.inputs.title as string,
        });
        break;
      }
    }

    this.queueManager.save();
    return { ...item.inputs };
  }

  private async handleNameRun(item: WorkItem, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    const storyText = item.inputs.storyText as string;
    const namePrompt = `Give this story a short, catchy name (2-5 words). Reply with ONLY the name, nothing else.\n\nStory:\n${storyText.slice(0, 2000)}`;
    this.promptLogger.log(item.itemKey, 'name_run', namePrompt, { model: getLlmModelName('fast') });
    const limiter = rateLimiters.get(getLlmProviderName());
    await limiter.acquire();
    try {
      const { text } = await generateText({
        model: getLlmModel('fast'),
        prompt: namePrompt,
        maxTokens: 30,
      } as any);
      const name = text.trim();
      this.queueManager.setRunName(name);
      return { name };
    } catch (error: any) {
      if (error?.status === 429 || error?.message?.includes('429')) {
        console.warn(`[handleNameRun] 429 rate limited — backing off all ${getLlmProviderName()} workers for 5s`);
        limiter.backoff(5000);
      }
      throw error;
    } finally {
      limiter.release();
    }
  }

  private async handlePlanShots(item: WorkItem, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    const state = this.queueManager.getState();
    const analysis = state.storyAnalysis;
    if (!analysis) throw new Error('plan_shots requires storyAnalysis');

    const sceneNumber = item.inputs.sceneNumber as number;
    const scene = analysis.scenes.find(s => s.sceneNumber === sceneNumber);
    if (!scene) throw new Error(`Scene ${sceneNumber} not found`);

    const objectsNote = (analysis.objects ?? []).length > 0
      ? ` Known objects: ${(analysis.objects ?? []).map(o => o.name).join(', ')}.`
      : '';

    const planShotsPrompt = `You are a cinematic shot planner for Grok video generation. Plan shots for scene ${sceneNumber} of this story.

${VIDEO_MODEL_LIMITATIONS}

${SHOT_PLANNING_PRINCIPLES}

${SHOT_PLANNING_RULES.replace('{OBJECTS_NOTE}', objectsNote)}

Full story analysis for context:
${JSON.stringify(analysis, null, 2)}

Scene to plan:
${JSON.stringify(scene, null, 2)}`;

    this.promptLogger.log(item.itemKey, 'plan_shots', planShotsPrompt, { model: getLlmModelName('strong'), sceneNumber });

    const limiter = rateLimiters.get(getLlmProviderName());
    await limiter.acquire();
    let planResult;
    try {
    planResult = await (generateObject as any)({
      model: getLlmModel('strong'),
      schema: sceneShotsSchema,
      prompt: planShotsPrompt,
    });
    } catch (error: any) {
      if (error?.status === 429 || error?.message?.includes('429')) {
        console.warn(`[handlePlanShots] 429 rate limited — backing off all ${getLlmProviderName()} workers for 5s`);
        limiter.backoff(5000);
      }
      throw error;
    } finally {
      limiter.release();
    }

    const { object } = planResult;
    const processedShots = planShotsForScene(
      sceneNumber,
      object.shots,
      analysis,
    );

    // Use scoped mutation helper instead of direct state mutation
    this.queueManager.updateSceneShots(sceneNumber, processedShots, object.transition);

    return {
      sceneNumber,
      shotCount: processedShots.length,
      shots: processedShots,
    };
  }

  private async handleGenerateAsset(item: WorkItem, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    const state = this.queueManager.getState();
    const aspectRatio = state.options?.aspectRatio;
    const imageBackend = state.options?.assetImageBackend ?? state.options?.imageBackend ?? 'grok';
    console.log(`[handleGenerateAsset] Using imageBackend=${imageBackend} (${item.itemKey})`);

    // Log the prompt BEFORE the call so it's captured even if generation fails
    const assetType = item.inputs.characterName ? "character" : item.inputs.locationName ? "location" : "object";
    const isEditing = Boolean(item.inputs.referenceImagePath);
    const prompt = buildAssetPrompt({ assetType, description: item.inputs.description as string, artStyle: item.inputs.artStyle as string, isEditing });
    this.promptLogger.log(item.itemKey, 'generate_asset', prompt, { backend: imageBackend });

    const result = await generateAsset({
      characterName: item.inputs.characterName as string | undefined,
      locationName: item.inputs.locationName as string | undefined,
      objectName: item.inputs.objectName as string | undefined,
      description: item.inputs.description as string,
      artStyle: item.inputs.artStyle as string,
      outputDir: join(this.resolvedOutputDir(), 'assets'),
      referenceImagePath: item.inputs.referenceImagePath as string | undefined,
      imageBackend,
      aspectRatio,
      version: item.version,
    });

    this.queueManager.setGeneratedOutput(result.key, this.relativePath(result.path));

    // Build asset library from generated outputs
    this.rebuildAssetLibrary();

    return { key: result.key, path: this.relativePath(result.path) };
  }

  private async handleGenerateFrame(item: WorkItem, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    const state = this.queueManager.getState();
    if (!state.storyAnalysis || !state.assetLibrary) {
      throw new Error('generate_frame requires storyAnalysis and assetLibrary');
    }

    const shot = item.inputs.shot as Shot;
    const shotContext = `scene ${shot.sceneNumber} shot ${shot.shotInScene}`;
    console.log(`[handleGenerateFrame] ${shotContext}: dependencies=${JSON.stringify(item.dependencies)}, continuousFromPrevious=${shot.continuousFromPrevious}`);

    if (shot.continuousFromPrevious && shot.shotInScene > 1) {
      const prevVideoKey = `video:scene:${shot.sceneNumber}:shot:${shot.shotInScene - 1}`;
      const prevVideoPath = state.generatedOutputs[prevVideoKey];
      console.log(`[handleGenerateFrame] Looking up previous video: key=${prevVideoKey}, found=${!!prevVideoPath}`);

      if (!prevVideoPath) {
        throw new Error(`Continuity extraction failed: previous video not found in generatedOutputs (key=${prevVideoKey})`);
      }

      const framesDir = join(this.resolvedOutputDir(), 'frames');
      const outputFramePath = join(framesDir, `scene_${shot.sceneNumber}_shot_${shot.shotInScene}_v${item.version}_start.png`);

      mkdirSync(framesDir, { recursive: true });
      console.log(`[handleGenerateFrame] ${shotContext}: extracting last frame from ${prevVideoKey}`);
      try {
        execFileSync('ffmpeg', [
          '-y',
          '-sseof',
          '-0.1',
          '-i',
          this.absolutePath(prevVideoPath),
          '-frames:v',
          '1',
          '-update',
          '1',
          outputFramePath,
        ], { stdio: 'pipe' });
      } catch (error) {
        const details = error instanceof Error
          ? error.message
          : String(error);
        throw new Error(`Continuity extraction failed: ffmpeg error extracting last frame from ${prevVideoKey}. ${details}`);
      }

      const relativeStartPath = this.relativePath(outputFramePath);
      this.queueManager.setGeneratedOutput(`frame:scene:${shot.sceneNumber}:shot:${shot.shotInScene}:start`, relativeStartPath);

      return {
        shotNumber: shot.shotNumber,
        startPath: relativeStartPath,
      };
    }

    const aspectRatio = state.options?.aspectRatio;
    const imageBackend = state.options?.imageBackend ?? 'grok';
    console.log(`[handleGenerateFrame] Using imageBackend=${imageBackend} (scene ${shot.sceneNumber} shot ${shot.shotInScene})`);
    const result = await generateFrame({
      shot,
      artStyle: state.storyAnalysis.artStyle,
      assetLibrary: state.assetLibrary,
      outputDir: this.resolvedOutputDir(),
      imageBackend,
      aspectRatio,
      version: item.version,
    });

    if (result.finalPrompt) {
      this.promptLogger.log(item.itemKey, 'generate_frame', result.finalPrompt, { backend: imageBackend, composition: shot.composition, cameraDirection: shot.cameraDirection, sceneNumber: shot.sceneNumber, shotInScene: shot.shotInScene, references: result.startReferences?.map(r => ({ type: r.type, name: r.name })) });
    }

    if (result.startPath) {
      this.queueManager.setGeneratedOutput(`frame:scene:${shot.sceneNumber}:shot:${shot.shotInScene}:start`, this.relativePath(result.startPath));
    }

    return {
      shotNumber: result.shotNumber,
      startPath: result.startPath ? this.relativePath(result.startPath) : result.startPath,
    };
  }

  private async handleGenerateVideo(item: WorkItem, signal: AbortSignal): Promise<Record<string, unknown>> {
    const state = this.queueManager.getState();
    const shot = item.inputs.shot as Shot;
    const startFramePath = this.absolutePath(item.inputs.startFramePath as string);
    const aspectRatio = state.options?.aspectRatio;
    const videoBackend = state.options?.videoBackend ?? 'grok';
    console.log(`[handleGenerateVideo] Using videoBackend=${videoBackend} (scene ${shot.sceneNumber} shot ${shot.shotInScene})`);

    const result = await generateVideo({
      shotNumber: shot.shotNumber,
      sceneNumber: shot.sceneNumber,
      shotInScene: shot.shotInScene,
      shotType: 'first_last_frame',
      dialogue: shot.dialogue,
      speaker: shot.speaker,
      charactersPresent: shot.charactersPresent,
      soundEffects: shot.soundEffects,
      cameraDirection: shot.cameraDirection,
      videoPrompt: shot.videoPrompt,
      durationSeconds: shot.durationSeconds,
      startFramePath,
      outputDir: join(this.resolvedOutputDir(), 'videos'),
      videoBackend,
      aspectRatio,
      abortSignal: signal,
      version: item.version,
      priority: item.priority,
      onLtxProgress: (info) => {
        this.emit('item:progress', {
          runId: this.runId,
          itemId: item.id,
          itemKey: item.itemKey,
          progress: info,
        });
      },
    });

    this.promptLogger.log(item.itemKey, 'generate_video', result.finalPrompt, { backend: videoBackend, duration: shot.durationSeconds, sceneNumber: shot.sceneNumber, shotInScene: shot.shotInScene });

    this.queueManager.setGeneratedOutput(`video:scene:${shot.sceneNumber}:shot:${shot.shotInScene}`, this.relativePath(result.path));

    return {
      shotNumber: result.shotNumber,
      path: this.relativePath(result.path),
      duration: result.duration,
    };
  }

  private async handleAnalyzeVideo(item: WorkItem): Promise<Record<string, unknown>> {
    const shotNumber = item.inputs.shotNumber as number;
    const videoPath = this.absolutePath(item.inputs.videoPath as string);
    const startFramePath = this.absolutePath(item.inputs.startFramePath as string);
    const referenceImagePaths = ((item.inputs.referenceImagePaths as string[] | undefined) ?? []).map(p => this.absolutePath(p));
    const shot = item.inputs.shot as Shot;

    const startFrameExists = existsSync(startFramePath);
    if (!startFrameExists) {
      console.warn(`[analyze_video] WARNING: Start frame not found for shot ${shotNumber}: ${startFramePath}`);
    }

    this.promptLogger.log(item.itemKey, 'analyze_video', buildAnalyzeVideoPrompt({
      shotNumber,
      dialogue: shot.dialogue,
      videoPrompt: shot.videoPrompt,
      durationSeconds: shot.durationSeconds,
      cameraDirection: shot.cameraDirection,
      startFramePrompt: shot.startFramePrompt,
      referenceImagePaths,
      hasStartFrame: startFrameExists,
    }), { model: 'gemini-2.5-flash', shotNumber, durationSeconds: shot.durationSeconds });

    const analysis = await analyzeVideoClip({
      videoPath,
      shotNumber,
      startFramePath,
      referenceImagePaths,
      dialogue: shot.dialogue,
      videoPrompt: shot.videoPrompt,
      durationSeconds: shot.durationSeconds,
      cameraDirection: shot.cameraDirection,
      startFramePrompt: shot.startFramePrompt,
    });

    console.log(`[analyze_video] Shot ${shotNumber}: matchScore=${analysis.matchScore}, issues=${analysis.issues.length}`);

    return {
      shotNumber,
      matchScore: analysis.matchScore,
      issues: analysis.issues,
      recommendations: analysis.recommendations,
    };
  }

  private async handleAssemble(_item: WorkItem): Promise<Record<string, unknown>> {
    const state = this.queueManager.getState();
    if (!state.storyAnalysis) throw new Error('assemble requires storyAnalysis');

    const allShots = state.storyAnalysis.scenes.flatMap(s => s.shots || []);
    const sortedShots = [...allShots]
      .sort((a, b) => a.sceneNumber - b.sceneNumber || a.shotInScene - b.shotInScene)
      .filter(s => !s.skipped);

    const videoPaths = sortedShots
      .map(s => state.generatedOutputs[`video:scene:${s.sceneNumber}:shot:${s.shotInScene}`])
      .filter((p): p is string => !!p)
      .map(p => this.absolutePath(p));

    if (videoPaths.length === 0) {
      return { path: null, message: 'No videos to assemble' };
    }

    // Build transitions — one entry per clip-to-clip join (N-1 for N clips).
    // Within-scene joins are always hard cuts; scene boundaries use the scene's declared transition.
    const transitions: Array<{ type: 'cut' | 'fade_black'; durationMs: number }> = [];
    for (let i = 1; i < sortedShots.length; i++) {
      if (sortedShots[i].sceneNumber !== sortedShots[i - 1].sceneNumber) {
        // Scene boundary — use the scene's declared transition
        const scene = state.storyAnalysis!.scenes.find(s => s.sceneNumber === sortedShots[i].sceneNumber);
        const transType = scene?.transition ?? 'cut';
        transitions.push({
          type: transType,
          durationMs: transType === 'fade_black' ? 750 : 0,
        });
      } else {
        // Same scene — always a hard cut
        transitions.push({ type: 'cut', durationMs: 0 });
      }
    }

    // Get actual clip durations via ffprobe
    const actualDurations: number[] = [];
    for (const vp of videoPaths) {
      actualDurations.push(await getVideoDuration(vp));
    }

    // Build subtitles using actual durations and accounting for xfade overlap
    const subtitles: Array<{ startSec: number; endSec: number; text: string }> = [];
    let cumulativeTime = 0;
    for (let i = 0; i < sortedShots.length; i++) {
      const shot = sortedShots[i];
      const clipDuration = actualDurations[i] ?? shot.durationSeconds;

      if (shot.dialogue && shot.dialogue.trim().length > 0) {
        subtitles.push({
          startSec: cumulativeTime,
          endSec: cumulativeTime + clipDuration,
          text: shot.dialogue.trim(),
        });
      }

      cumulativeTime += clipDuration;

      // Subtract xfade overlap (the xfade causes clips to overlap)
      if (i < transitions.length) {
        const trans = transitions[i];
        if (trans.type !== 'cut' && trans.durationMs > 0) {
          cumulativeTime -= trans.durationMs / 1000;
        }
      }
    }

    const result = await assembleVideo({
      videoPaths,
      transitions,
      subtitles,
      outputDir: this.resolvedOutputDir(),
    });

    return { path: this.relativePath(result.path) };
  }

  // ---------------------------------------------------------------------------
  // Downstream seeding
  // ---------------------------------------------------------------------------

  private seedDownstream(item: WorkItem, outputs: Record<string, unknown>): void {
    switch (item.type) {
      case 'analyze_story':
        this.seedAfterAnalysis(item);
        break;
      case 'artifact':
        this.seedAfterArtifact(item);
        break;
      case 'plan_shots':
        this.seedAfterPlanShots(item, outputs);
        break;
      case 'generate_frame':
        this.seedAfterGenerateFrame(item, outputs);
        break;
      case 'generate_video':
        this.seedAfterGenerateVideo(item, outputs);
        break;
    }
  }

  private seedAfterAnalysis(analyzeItem: WorkItem): void {
    const state = this.queueManager.getState();
    const analysis = state.storyAnalysis;
    if (!analysis) return;

    // Seed character artifacts
    for (const char of analysis.characters) {
      this.queueManager.addItem({
        type: 'artifact',
        queue: 'llm',
        itemKey: `artifact:character:${char.name}`,
        dependencies: [analyzeItem.id],
        inputs: {
          artifactType: 'character',
          name: char.name,
          physicalDescription: char.physicalDescription,
          personality: char.personality,
          ageRange: char.ageRange,
        },
        priority: analyzeItem.priority,
      });
    }

    // Seed location artifacts
    for (const loc of analysis.locations) {
      this.queueManager.addItem({
        type: 'artifact',
        queue: 'llm',
        itemKey: `artifact:location:${loc.name}`,
        dependencies: [analyzeItem.id],
        inputs: {
          artifactType: 'location',
          name: loc.name,
          visualDescription: loc.visualDescription,
        },
        priority: analyzeItem.priority,
      });
    }

    // Seed object artifacts
    for (const obj of (analysis.objects ?? [])) {
      this.queueManager.addItem({
        type: 'artifact',
        queue: 'llm',
        itemKey: `artifact:object:${obj.name}`,
        dependencies: [analyzeItem.id],
        inputs: {
          artifactType: 'object',
          name: obj.name,
          visualDescription: obj.visualDescription,
        },
        priority: analyzeItem.priority,
      });
    }

    // Seed scene artifacts
    for (const scene of analysis.scenes) {
      this.queueManager.addItem({
        type: 'artifact',
        queue: 'llm',
        itemKey: `artifact:scene:${scene.sceneNumber}`,
        dependencies: [analyzeItem.id],
        inputs: {
          artifactType: 'scene',
          sceneNumber: scene.sceneNumber,
          title: scene.title,
          narrativeSummary: scene.narrativeSummary,
          charactersPresent: scene.charactersPresent,
          location: scene.location,
          estimatedDurationSeconds: scene.estimatedDurationSeconds,
        },
        priority: analyzeItem.priority,
      });
    }

    // Seed pacing artifact
    this.queueManager.addItem({
      type: 'artifact',
      queue: 'llm',
      itemKey: 'artifact:pacing',
      dependencies: [analyzeItem.id],
      inputs: {
        artifactType: 'pacing',
        title: analysis.title,
        artStyle: analysis.artStyle,
      },
      priority: analyzeItem.priority,
    });
  }


  private seedAfterArtifact(item: WorkItem): void {
    const state = this.queueManager.getState();
    const artifactType = item.inputs.artifactType as string;

    switch (artifactType) {
      case 'character': {
        this.queueManager.addItem({
          type: 'generate_asset',
          queue: 'image',
          itemKey: `asset:character:${item.inputs.name}:front`,
          dependencies: [item.id],
          inputs: {
            characterName: item.inputs.name,
            description: item.inputs.physicalDescription,
            artStyle: state.storyAnalysis?.artStyle ?? '',
          },
          priority: item.priority,
        });
        break;
      }
      case 'location': {
        this.queueManager.addItem({
          type: 'generate_asset',
          queue: 'image',
          itemKey: `asset:location:${item.inputs.name}`,
          dependencies: [item.id],
          inputs: {
            locationName: item.inputs.name,
            description: item.inputs.visualDescription,
            artStyle: state.storyAnalysis?.artStyle ?? '',
          },
          priority: item.priority,
        });
        break;
      }
      case 'object': {
        this.queueManager.addItem({
          type: 'generate_asset',
          queue: 'image',
          itemKey: `asset:object:${item.inputs.name}`,
          dependencies: [item.id],
          inputs: {
            objectName: item.inputs.name,
            description: item.inputs.visualDescription,
            artStyle: state.storyAnalysis?.artStyle ?? '',
          },
          priority: item.priority,
        });
        break;
      }
      case 'scene': {
        this.queueManager.addItem({
          type: 'plan_shots',
          queue: 'llm',
          itemKey: `plan_shots:scene:${item.inputs.sceneNumber}`,
          dependencies: [item.id],
          inputs: { sceneNumber: item.inputs.sceneNumber },
          priority: item.priority,
        });
        break;
      }
      case 'pacing':
        // No downstream items — artStyle feeds into assets/frames via state
        break;
    }
  }

  private seedAfterPlanShots(planItem: WorkItem, outputs: Record<string, unknown>): void {
    const state = this.queueManager.getState();
    const analysis = state.storyAnalysis;
    if (!analysis) return;

    const shots = outputs.shots as Shot[] | undefined;
    if (!shots || shots.length === 0) return;

    // Collect asset item IDs that frames depend on
    const assetItemIds = this.getAssetItemIds(analysis);

    for (const shot of shots) {
      const frameDeps = [planItem.id, ...assetItemIds];

      if (shot.continuousFromPrevious && shot.shotInScene > 1) {
        frameDeps.push(`video:scene:${shot.sceneNumber}:shot:${shot.shotInScene - 1}`);
      }

      this.queueManager.addItem({
        type: 'generate_frame',
        queue: 'image',
        itemKey: `frame:scene:${shot.sceneNumber}:shot:${shot.shotInScene}`,
        dependencies: frameDeps,
        inputs: { shot },
        priority: planItem.priority,
      });
    }
  }

  private seedAfterGenerateFrame(frameItem: WorkItem, outputs: Record<string, unknown>): void {
    const startPath = outputs.startPath as string | undefined;
    const shot = frameItem.inputs.shot as Shot;

    if (!startPath) return; // No frame generated (shouldn't happen)

    // Check if a generate_video item already exists for this shot (e.g. from cascade redo)
    const existingVideo = this.queueManager.getItemsByKey(`video:scene:${shot.sceneNumber}:shot:${shot.shotInScene}`);
    if (existingVideo.some(i => i.status !== 'superseded' && i.status !== 'cancelled' && i.dependencies.includes(frameItem.id))) {
      return; // Already seeded by cascade, skip duplicate
    }

    this.queueManager.addItem({
      type: 'generate_video',
      queue: 'video',
      itemKey: `video:scene:${shot.sceneNumber}:shot:${shot.shotInScene}`,
      dependencies: [frameItem.id],
      inputs: {
        shot,
        startFramePath: startPath,
        endFramePath: outputs.endPath as string | undefined,
      },
      priority: frameItem.priority,
    });
  }

  private seedContinuityFrameAfterGenerateVideo(videoItem: WorkItem, analysis: StoryAnalysis, shot: Shot): void {
    const scene = analysis.scenes.find(candidate => candidate.sceneNumber === shot.sceneNumber);
    const nextShot = scene?.shots.find(candidate => candidate.shotInScene === shot.shotInScene + 1);

    if (!nextShot || nextShot.skipped || !nextShot.continuousFromPrevious) {
      return;
    }

    const frameKey = `frame:scene:${nextShot.sceneNumber}:shot:${nextShot.shotInScene}`;
    const existingFrame = this.queueManager.getItemsByKey(frameKey);
    const hasActiveFrame = existingFrame.some(
      item => item.status !== 'superseded' && item.status !== 'cancelled'
    );

    if (hasActiveFrame) {
      return;
    }

    this.queueManager.addItem({
      type: 'generate_frame',
      queue: 'image',
      itemKey: frameKey,
      dependencies: [videoItem.id],
      inputs: { shot: nextShot },
      priority: videoItem.priority,
    });
  }

  private seedAfterGenerateVideo(item: WorkItem, outputs: Record<string, unknown>): void {
    const state = this.queueManager.getState();
    const analysis = state.storyAnalysis;
    if (!analysis) return;

    // Seed an analyze_video item for this completed video
    const shotNumber = outputs.shotNumber as number;
    const videoPath = outputs.path as string;
    const startFramePath = item.inputs.startFramePath as string;
    const shot = item.inputs.shot as Shot;

    let analyzeShot = shot;
    if (shot.continuousFromPrevious && shot.shotInScene > 1) {
      analyzeShot = { ...shot, startFramePrompt: 'Start frame is the previous clip end frame.' };
    }

    this.seedContinuityFrameAfterGenerateVideo(item, analysis, shot);

    // Collect reference image paths from the asset library for characters/objects/location in this shot
    const referenceImagePaths: string[] = [];
    for (const [key, value] of Object.entries(state.generatedOutputs)) {
      if (key.startsWith('character:') || key.startsWith('location:') || key.startsWith('object:')) {
        const name = key.split(':')[1];
        if (
          shot.charactersPresent.includes(name) ||
          shot.objectsPresent?.includes(name) ||
          shot.location === name
        ) {
          referenceImagePaths.push(value);
        }
      }
    }

    // Check if analyze_video already exists for this shot AND depends on this video item.
    // If the existing analyze depends on an older/superseded video, allow a new one.
    const existingAnalyze = this.queueManager.getItemsByKey(`analyze_video:scene:${shot.sceneNumber}:shot:${shot.shotInScene}`);
    const hasCurrentAnalysis = existingAnalyze.some(
      i => i.status !== 'superseded' && i.status !== 'cancelled' && i.dependencies.includes(item.id)
    );
    if (!hasCurrentAnalysis) {
      this.queueManager.addItem({
        type: 'analyze_video',
        queue: 'llm',
        itemKey: `analyze_video:scene:${shot.sceneNumber}:shot:${shot.shotInScene}`,
        dependencies: [item.id],
        inputs: {
          shotNumber,
          videoPath,
          startFramePath,
          referenceImagePaths,
          shot: analyzeShot,
        },
        priority: item.priority,
      });
    }

    // Check if ALL video items are completed to seed assemble
    const allShots = analysis.scenes.flatMap(s => s.shots || []).filter(s => !s.skipped);
    const allVideosDone = allShots.every(shot => {
      const items = this.queueManager.getItemsByKey(`video:scene:${shot.sceneNumber}:shot:${shot.shotInScene}`);
      return items.some(i => i.status === 'completed' && !i.supersededBy);
    });

    if (!allVideosDone) return;

    // Check if assemble item already exists
    const existingAssemble = this.queueManager.getItemsByKey('assemble');
    if (existingAssemble.some(i => i.status !== 'superseded' && i.status !== 'cancelled')) return;

    const videoKeys = allShots.map(
      shot => `video:scene:${shot.sceneNumber}:shot:${shot.shotInScene}`
    );

    this.queueManager.addItem({
      type: 'assemble',
      queue: 'llm', // Assembly uses ffmpeg, not an API — put in LLM queue as it's CPU-bound
      itemKey: 'assemble',
      dependencies: videoKeys,
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private getAssetItemIds(analysis: StoryAnalysis): string[] {
    const ids: string[] = [];

    for (const char of analysis.characters) {
      const items = this.queueManager.getItemsByKey(`asset:character:${char.name}:front`);
      const active = items.find(i => i.status !== 'superseded' && i.status !== 'cancelled');
      if (active) ids.push(active.id);
    }

    for (const loc of analysis.locations) {
      const items = this.queueManager.getItemsByKey(`asset:location:${loc.name}`);
      const active = items.find(i => i.status !== 'superseded' && i.status !== 'cancelled');
      if (active) ids.push(active.id);
    }

    for (const obj of (analysis.objects ?? [])) {
      const items = this.queueManager.getItemsByKey(`asset:object:${obj.name}`);
      const active = items.find(i => i.status !== 'superseded' && i.status !== 'cancelled');
      if (active) ids.push(active.id);
    }

    return ids;
  }

  private rebuildAssetLibrary(): void {
    const state = this.queueManager.getState();
    console.log('[rebuildAssetLibrary] generatedOutputs keys:', Object.keys(state.generatedOutputs));
    const analysis = state.storyAnalysis;
    if (!analysis) return;

    const lib: AssetLibrary = {
      characterImages: {},
      locationImages: {},
      objectImages: {},
    };

    // generateAsset() returns keys formatted as `${assetType}:${assetName}:${angleType}`
    // (no 'asset:' prefix). Characters use :front/:angle, locations and objects also get :front.
    for (const char of analysis.characters) {
      const frontPath = state.generatedOutputs[`character:${char.name}:front`];
      const anglePath = state.generatedOutputs[`character:${char.name}:angle`];
      if (frontPath) {
        lib.characterImages[char.name] = {
          front: this.absolutePath(frontPath),
          angle: this.absolutePath(anglePath ?? frontPath),
        };
      }
    }

    for (const loc of analysis.locations) {
      const path = state.generatedOutputs[`location:${loc.name}:front`];
      if (path) lib.locationImages[loc.name] = this.absolutePath(path);
    }

    for (const obj of (analysis.objects ?? [])) {
      const path = state.generatedOutputs[`object:${obj.name}:front`];
      if (path) lib.objectImages[obj.name] = this.absolutePath(path);
    }

    this.queueManager.setAssetLibrary(lib);
    console.log('[rebuildAssetLibrary] Asset library:', JSON.stringify(lib, null, 2));
  }
}

// ---------------------------------------------------------------------------
// ProcessorGroup — manages all three queue processors for a run
// ---------------------------------------------------------------------------

/** Env var names for per-queue concurrency configuration. */
const CONCURRENCY_ENV_VARS: Record<QueueName, string> = {
  llm: 'QUEUE_CONCURRENCY_LLM',
  image: 'QUEUE_CONCURRENCY_IMAGE',
  video: 'QUEUE_CONCURRENCY_VIDEO',
};

/** Default concurrency values per queue. */
const CONCURRENCY_DEFAULTS: Record<QueueName, number> = {
  llm: 4,
  image: 4,
  video: 3,
};

export function getQueueConcurrency(queue: QueueName): number {
  const envVal = process.env[CONCURRENCY_ENV_VARS[queue]];
  if (envVal !== undefined) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return CONCURRENCY_DEFAULTS[queue];
}

export class ProcessorGroup extends EventEmitter {
  private processors: QueueProcessor[];

  constructor(queueManager: QueueManager, runId: string) {
    super();
    const queues: QueueName[] = ['llm', 'image', 'video'];
    this.processors = queues.map(q => {
      const concurrency = getQueueConcurrency(q);
      const proc = new QueueProcessor(q, queueManager, runId, concurrency);
      // Forward events
      proc.on('item:started', (data) => this.emit('item:started', data));
      proc.on('item:completed', (data) => this.emit('item:completed', data));
      proc.on('item:failed', (data) => this.emit('item:failed', data));
      proc.on('item:cancelled', (data) => this.emit('item:cancelled', data));
      proc.on('item:progress', (data) => this.emit('item:progress', data));
      proc.on('pipeline:pause', (data) => this.emit('pipeline:pause', data));
      return proc;
    });

    // Wire up supersession callback so in-flight work is aborted when items are superseded
    queueManager.onItemSuperseded = (itemId: string) => {
      for (const proc of this.processors) {
        if (proc.cancelItem(itemId)) break;
      }
    };
  }

  start(): void {
    for (const proc of this.processors) {
      proc.start();
    }
  }

  async stop(): Promise<void> {
    await Promise.all(this.processors.map(p => p.stop()));
  }

  isRunning(): boolean {
    return this.processors.some(p => p.isRunning());
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
