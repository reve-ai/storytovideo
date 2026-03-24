import { EventEmitter } from 'events';
import { join } from 'path';
import { generateObject, generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';

import type { QueueName, Priority, WorkItem, RunState } from './types.js';
import { QueueManager } from './queue-manager.js';
import { analyzeStory } from '../tools/analyze-story.js';
import { storyToScript } from '../tools/story-to-script.js';
import { planShotsForScene, CINEMATIC_RULES } from '../tools/plan-shots.js';
import { generateAsset } from '../tools/generate-asset.js';
import { generateFrame } from '../tools/generate-frame.js';
import { generateVideo } from '../tools/generate-video.js';
import { assembleVideo } from '../tools/assemble-video.js';
import type { StoryAnalysis, AssetLibrary, Shot } from '../types.js';

// ---------------------------------------------------------------------------
// Per-scene shot schema (matches plan-shots.ts perSceneShotSchema)
// ---------------------------------------------------------------------------

const perSceneShotSchema = z.object({
  shotInScene: z.number(),
  durationSeconds: z.number().min(2).max(15),
  shotType: z.literal('first_last_frame'),
  composition: z.string(),
  startFramePrompt: z.string(),
  endFramePrompt: z.string(),
  actionPrompt: z.string(),
  dialogue: z.string(),
  speaker: z.string(),
  soundEffects: z.string(),
  cameraDirection: z.string(),
  charactersPresent: z.array(z.string()),
  objectsPresent: z.array(z.string()).optional(),
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

export interface ProcessorEvents {
  'item:started': { runId: string; item: WorkItem };
  'item:completed': { runId: string; item: WorkItem };
  'item:failed': { runId: string; item: WorkItem; error: string };
}

// ---------------------------------------------------------------------------
// QueueProcessor — generic processor for any queue
// ---------------------------------------------------------------------------

export class QueueProcessor extends EventEmitter {
  private running = false;
  private normalLanePromise: Promise<void> | null = null;
  private highLanePromise: Promise<void> | null = null;

  constructor(
    private readonly queueName: QueueName,
    private readonly queueManager: QueueManager,
    private readonly runId: string,
  ) {
    super();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.normalLanePromise = this.runLane('normal');
    this.highLanePromise = this.runLane('high');
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.allSettled([this.normalLanePromise, this.highLanePromise]);
    this.normalLanePromise = null;
    this.highLanePromise = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  private async runLane(priority: Priority): Promise<void> {
    while (this.running) {
      const item = this.queueManager.getNextReady(this.queueName, priority);
      if (!item) {
        // No work available — wait before polling again
        await sleep(500);
        continue;
      }

      try {
        this.queueManager.markInProgress(item.id);
        this.emit('item:started', { runId: this.runId, item });

        const outputs = await this.executeItem(item);

        this.queueManager.markCompleted(item.id, outputs);
        this.emit('item:completed', { runId: this.runId, item: { ...item, status: 'completed', outputs } });

        // Seed downstream work items after completion
        this.seedDownstream(item, outputs);

        this.queueManager.save();
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.queueManager.markFailed(item.id, errorMsg);
        this.emit('item:failed', { runId: this.runId, item: { ...item, status: 'failed' }, error: errorMsg });
        this.queueManager.save();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Work item dispatch
  // ---------------------------------------------------------------------------

  private async executeItem(item: WorkItem): Promise<Record<string, unknown>> {
    switch (item.type) {
      case 'story_to_script': return this.handleStoryToScript(item);
      case 'analyze_story': return this.handleAnalyzeStory(item);
      case 'name_run': return this.handleNameRun(item);
      case 'plan_shots': return this.handlePlanShots(item);
      case 'generate_asset': return this.handleGenerateAsset(item);
      case 'generate_frame': return this.handleGenerateFrame(item);
      case 'generate_video': return this.handleGenerateVideo(item);
      case 'assemble': return this.handleAssemble(item);
      default:
        throw new Error(`Unknown work item type: ${item.type}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  private async handleStoryToScript(item: WorkItem): Promise<Record<string, unknown>> {
    const storyText = item.inputs.storyText as string;
    const script = await storyToScript(storyText);
    const state = this.queueManager.getState();
    state.convertedScript = script;
    return { script };
  }

  private async handleAnalyzeStory(item: WorkItem): Promise<Record<string, unknown>> {
    const state = this.queueManager.getState();
    // Use converted script if available, otherwise raw story
    const textToAnalyze = state.convertedScript ?? item.inputs.storyText as string;
    const analysis = await analyzeStory(textToAnalyze);
    state.storyAnalysis = analysis;
    return { analysis };
  }

  private async handleNameRun(item: WorkItem): Promise<Record<string, unknown>> {
    const storyText = item.inputs.storyText as string;
    const { text } = await generateText({
      model: anthropic('claude-sonnet-4-20250514'),
      prompt: `Give this story a short, catchy name (2-5 words). Reply with ONLY the name, nothing else.\n\nStory:\n${storyText.slice(0, 2000)}`,
      maxTokens: 30,
    } as any);
    const name = text.trim();
    const state = this.queueManager.getState();
    state.runName = name;
    return { name };
  }

  private async handlePlanShots(item: WorkItem): Promise<Record<string, unknown>> {
    const state = this.queueManager.getState();
    const analysis = state.storyAnalysis;
    if (!analysis) throw new Error('plan_shots requires storyAnalysis');

    const sceneNumber = item.inputs.sceneNumber as number;
    const scene = analysis.scenes.find(s => s.sceneNumber === sceneNumber);
    if (!scene) throw new Error(`Scene ${sceneNumber} not found`);

    const objectNames = (analysis.objects ?? []).map(o => o.name);
    const objectsNote = objectNames.length > 0
      ? `Known objects: ${objectNames.join(', ')}.`
      : '';

    const { object } = await (generateObject as any)({
      model: anthropic('claude-sonnet-4-20250514'),
      schema: sceneShotsSchema,
      prompt: `You are a cinematic shot planner. Plan shots for scene ${sceneNumber} of this story.

${CINEMATIC_RULES}

IMPORTANT FOR GROK: Since the Grok backend does not use end frames, set endFramePrompt to an empty string for all shots.

Rules:
- Shots can be 1-15 seconds long. Choose duration that fits the action.
- Each shot is exactly what a single, stationary camera sees.
- In actionPrompt and startFramePrompt, describe characters by appearance, not name.
- In dialogue, use actual character names.
- Set speaker to identify who is speaking.
- Populate objectsPresent with key objects in each shot. ${objectsNote}
- Scene 1 always uses "cut" transition.
- Shot durations must be whole numbers (integers), minimum 2 seconds.
- Calculate minimum duration from dialogue word count at ~2.5 words/second + 0.5s buffer.

Scene to plan:
${JSON.stringify(scene, null, 2)}

Full story analysis for context:
${JSON.stringify(analysis, null, 2)}`,
    });

    const updatedAnalysis = planShotsForScene(
      sceneNumber,
      object.transition,
      object.shots,
      analysis,
    );
    state.storyAnalysis = updatedAnalysis;

    const plannedScene = updatedAnalysis.scenes.find(s => s.sceneNumber === sceneNumber);
    return {
      sceneNumber,
      shotCount: plannedScene?.shots?.length ?? 0,
      shots: plannedScene?.shots ?? [],
    };
  }

  private async handleGenerateAsset(item: WorkItem): Promise<Record<string, unknown>> {
    const state = this.queueManager.getState();
    const result = await generateAsset({
      characterName: item.inputs.characterName as string | undefined,
      locationName: item.inputs.locationName as string | undefined,
      objectName: item.inputs.objectName as string | undefined,
      description: item.inputs.description as string,
      artStyle: item.inputs.artStyle as string,
      outputDir: join(state.outputDir, 'assets'),
      referenceImagePath: item.inputs.referenceImagePath as string | undefined,
      videoBackend: 'grok',
    });

    state.generatedOutputs[result.key] = result.path;

    // Build asset library from generated outputs
    this.rebuildAssetLibrary(state);

    return { key: result.key, path: result.path };
  }

  private async handleGenerateFrame(item: WorkItem): Promise<Record<string, unknown>> {
    const state = this.queueManager.getState();
    if (!state.storyAnalysis || !state.assetLibrary) {
      throw new Error('generate_frame requires storyAnalysis and assetLibrary');
    }

    const shot = item.inputs.shot as Shot;
    const previousEndFramePath = item.inputs.previousEndFramePath as string | undefined;

    const result = await generateFrame({
      shot,
      artStyle: state.storyAnalysis.artStyle,
      assetLibrary: state.assetLibrary,
      outputDir: state.outputDir,
      previousEndFramePath,
      videoBackend: 'grok',
    });

    if (result.startPath) {
      state.generatedOutputs[`frame:shot:${shot.shotNumber}:start`] = result.startPath;
    }
    if (result.endPath) {
      state.generatedOutputs[`frame:shot:${shot.shotNumber}:end`] = result.endPath;
    }

    return {
      shotNumber: result.shotNumber,
      startPath: result.startPath,
      endPath: result.endPath,
    };
  }

  private async handleGenerateVideo(item: WorkItem): Promise<Record<string, unknown>> {
    const state = this.queueManager.getState();
    const shot = item.inputs.shot as Shot;
    const startFramePath = item.inputs.startFramePath as string;
    const endFramePath = item.inputs.endFramePath as string | undefined;

    const result = await generateVideo({
      shotNumber: shot.shotNumber,
      shotType: 'first_last_frame',
      actionPrompt: shot.actionPrompt,
      dialogue: shot.dialogue,
      soundEffects: shot.soundEffects,
      cameraDirection: shot.cameraDirection,
      durationSeconds: shot.durationSeconds,
      startFramePath,
      endFramePath: endFramePath ?? startFramePath,
      outputDir: join(state.outputDir, 'videos'),
      videoBackend: 'grok',
      characterNames: state.storyAnalysis?.characters.map(c => c.name) ?? [],
    });

    state.generatedOutputs[`video:shot:${shot.shotNumber}`] = result.path;

    return {
      shotNumber: result.shotNumber,
      path: result.path,
      duration: result.duration,
      promptSent: result.promptSent,
    };
  }

  private async handleAssemble(_item: WorkItem): Promise<Record<string, unknown>> {
    const state = this.queueManager.getState();
    if (!state.storyAnalysis) throw new Error('assemble requires storyAnalysis');

    const allShots = state.storyAnalysis.scenes.flatMap(s => s.shots || []);
    const sortedShots = [...allShots]
      .sort((a, b) => a.shotNumber - b.shotNumber)
      .filter(s => !s.skipped);

    const videoPaths = sortedShots
      .map(s => state.generatedOutputs[`video:shot:${s.shotNumber}`])
      .filter((p): p is string => !!p);

    if (videoPaths.length === 0) {
      return { path: null, message: 'No videos to assemble' };
    }

    // Build transitions
    const transitions: Array<{ type: 'cut' | 'fade_black'; durationMs: number }> = [];
    let prevSceneNumber = -1;
    for (const shot of sortedShots) {
      if (shot.sceneNumber !== prevSceneNumber && prevSceneNumber !== -1) {
        const scene = state.storyAnalysis.scenes.find(s => s.sceneNumber === shot.sceneNumber);
        const transType = scene?.transition ?? 'cut';
        transitions.push({
          type: transType,
          durationMs: transType === 'fade_black' ? 750 : 0,
        });
      }
      prevSceneNumber = shot.sceneNumber;
    }

    // Build subtitles
    const subtitles: Array<{ startSec: number; endSec: number; text: string }> = [];
    let cumulativeTime = 0;
    for (const shot of sortedShots) {
      if (shot.dialogue && shot.dialogue.trim().length > 0) {
        subtitles.push({
          startSec: cumulativeTime,
          endSec: cumulativeTime + shot.durationSeconds,
          text: shot.dialogue.trim(),
        });
      }
      cumulativeTime += shot.durationSeconds;
    }

    const result = await assembleVideo({
      videoPaths,
      transitions,
      subtitles,
      outputDir: state.outputDir,
    });

    return { path: result.path };
  }

  // ---------------------------------------------------------------------------
  // Downstream seeding
  // ---------------------------------------------------------------------------

  private seedDownstream(item: WorkItem, outputs: Record<string, unknown>): void {
    switch (item.type) {
      case 'analyze_story':
        this.seedAfterAnalysis(item);
        break;
      case 'plan_shots':
        this.seedAfterPlanShots(item, outputs);
        break;
      case 'generate_frame':
        this.seedAfterGenerateFrame(item, outputs);
        break;
      case 'generate_video':
        this.seedAfterGenerateVideo();
        break;
    }
  }

  private seedAfterAnalysis(analyzeItem: WorkItem): void {
    const state = this.queueManager.getState();
    const analysis = state.storyAnalysis;
    if (!analysis) return;

    // Seed plan_shots for each scene
    for (const scene of analysis.scenes) {
      this.queueManager.addItem({
        type: 'plan_shots',
        queue: 'llm',
        itemKey: `plan_shots:scene:${scene.sceneNumber}`,
        dependencies: [analyzeItem.id],
        inputs: { sceneNumber: scene.sceneNumber },
        priority: analyzeItem.priority,
      });
    }

    // Seed generate_asset for characters (front view)
    for (const char of analysis.characters) {
      this.queueManager.addItem({
        type: 'generate_asset',
        queue: 'image',
        itemKey: `asset:character:${char.name}:front`,
        dependencies: [analyzeItem.id],
        inputs: {
          characterName: char.name,
          description: char.physicalDescription,
          artStyle: analysis.artStyle,
        },
        priority: analyzeItem.priority,
      });
    }

    // Seed generate_asset for locations
    for (const loc of analysis.locations) {
      this.queueManager.addItem({
        type: 'generate_asset',
        queue: 'image',
        itemKey: `asset:location:${loc.name}`,
        dependencies: [analyzeItem.id],
        inputs: {
          locationName: loc.name,
          description: loc.visualDescription,
          artStyle: analysis.artStyle,
        },
        priority: analyzeItem.priority,
      });
    }

    // Seed generate_asset for objects
    for (const obj of (analysis.objects ?? [])) {
      this.queueManager.addItem({
        type: 'generate_asset',
        queue: 'image',
        itemKey: `asset:object:${obj.name}`,
        dependencies: [analyzeItem.id],
        inputs: {
          objectName: obj.name,
          description: obj.visualDescription,
          artStyle: analysis.artStyle,
        },
        priority: analyzeItem.priority,
      });
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

    let previousFrameItemId: string | null = null;

    for (const shot of shots) {
      // Frame depends on: plan_shots completion + all relevant assets + previous frame (continuity)
      const frameDeps = [planItem.id, ...assetItemIds];
      if (previousFrameItemId && shot.continuousFromPrevious) {
        frameDeps.push(previousFrameItemId);
      }

      const frameItem = this.queueManager.addItem({
        type: 'generate_frame',
        queue: 'image',
        itemKey: `frame:shot:${shot.shotNumber}`,
        dependencies: frameDeps,
        inputs: { shot },
        priority: planItem.priority,
      });

      previousFrameItemId = frameItem.id;
    }
  }

  private seedAfterGenerateFrame(frameItem: WorkItem, outputs: Record<string, unknown>): void {
    const shotNumber = outputs.shotNumber as number;
    const startPath = outputs.startPath as string | undefined;
    const shot = frameItem.inputs.shot as Shot;

    if (!startPath) return; // No frame generated (shouldn't happen)

    this.queueManager.addItem({
      type: 'generate_video',
      queue: 'video',
      itemKey: `video:shot:${shotNumber}`,
      dependencies: [frameItem.id],
      inputs: {
        shot,
        startFramePath: startPath,
        endFramePath: outputs.endPath as string | undefined,
      },
      priority: frameItem.priority,
    });
  }

  private seedAfterGenerateVideo(_item?: WorkItem): void {
    const state = this.queueManager.getState();
    const analysis = state.storyAnalysis;
    if (!analysis) return;

    // Check if ALL video items are completed
    const allShots = analysis.scenes.flatMap(s => s.shots || []).filter(s => !s.skipped);
    const allVideosDone = allShots.every(shot => {
      const items = this.queueManager.getItemsByKey(`video:shot:${shot.shotNumber}`);
      return items.some(i => i.status === 'completed' && !i.supersededBy);
    });

    if (!allVideosDone) return;

    // Check if assemble item already exists
    const existingAssemble = this.queueManager.getItemsByKey('assemble');
    if (existingAssemble.some(i => i.status !== 'superseded' && i.status !== 'cancelled')) return;

    // Collect all video item IDs as dependencies
    const videoItemIds = allShots
      .map(shot => {
        const items = this.queueManager.getItemsByKey(`video:shot:${shot.shotNumber}`);
        return items.find(i => i.status === 'completed' && !i.supersededBy);
      })
      .filter((i): i is WorkItem => !!i)
      .map(i => i.id);

    this.queueManager.addItem({
      type: 'assemble',
      queue: 'llm', // Assembly uses ffmpeg, not an API — put in LLM queue as it's CPU-bound
      itemKey: 'assemble',
      dependencies: videoItemIds,
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

  private rebuildAssetLibrary(state: RunState): void {
    const analysis = state.storyAnalysis;
    if (!analysis) return;

    const lib: AssetLibrary = {
      characterImages: {},
      locationImages: {},
      objectImages: {},
    };

    for (const char of analysis.characters) {
      const frontPath = state.generatedOutputs[`asset:character:${char.name}:front`];
      const anglePath = state.generatedOutputs[`asset:character:${char.name}:angle`];
      if (frontPath) {
        lib.characterImages[char.name] = {
          front: frontPath,
          angle: anglePath ?? frontPath,
        };
      }
    }

    for (const loc of analysis.locations) {
      const path = state.generatedOutputs[`asset:location:${loc.name}`];
      if (path) lib.locationImages[loc.name] = path;
    }

    for (const obj of (analysis.objects ?? [])) {
      const path = state.generatedOutputs[`asset:object:${obj.name}`];
      if (path) lib.objectImages[obj.name] = path;
    }

    state.assetLibrary = lib;
  }
}

// ---------------------------------------------------------------------------
// ProcessorGroup — manages all three queue processors for a run
// ---------------------------------------------------------------------------

export class ProcessorGroup extends EventEmitter {
  private processors: QueueProcessor[];

  constructor(queueManager: QueueManager, runId: string) {
    super();
    const queues: QueueName[] = ['llm', 'image', 'video'];
    this.processors = queues.map(q => {
      const proc = new QueueProcessor(q, queueManager, runId);
      // Forward events
      proc.on('item:started', (data) => this.emit('item:started', data));
      proc.on('item:completed', (data) => this.emit('item:completed', data));
      proc.on('item:failed', (data) => this.emit('item:failed', data));
      return proc;
    });
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
