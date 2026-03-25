import { EventEmitter } from 'events';
import { join } from 'path';
import { generateObject, generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';

import type { QueueName, Priority, WorkItem, RunState } from './types.js';
import { QueueManager } from './queue-manager.js';
import { analyzeStory } from '../tools/analyze-story.js';
import { storyToScript } from '../tools/story-to-script.js';
import { planShotsForScene } from '../tools/plan-shots.js';
import { generateAsset } from '../tools/generate-asset.js';
import { generateFrame } from '../tools/generate-frame.js';
import { generateVideo } from '../tools/generate-video.js';
import { assembleVideo } from '../tools/assemble-video.js';
import { analyzeClipPacing } from '../tools/analyze-video-pacing.js';
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
  private normalLanePromise: Promise<void> | null = null;
  private highLanePromise: Promise<void> | null = null;
  private activeAbortControllers = new Map<string, AbortController>();

  constructor(
    private readonly queueName: QueueName,
    private readonly queueManager: QueueManager,
    private readonly runId: string,
  ) {
    super();
  }

  /** Convert an absolute path to a path relative to the run's outputDir. */
  private relativePath(absolutePath: string): string {
    const outputDir = this.queueManager.getState().outputDir;
    if (absolutePath.startsWith(outputDir)) {
      let rel = absolutePath.slice(outputDir.length);
      if (rel.startsWith('/')) rel = rel.slice(1);
      return rel;
    }
    return absolutePath;
  }

  /** Resolve a potentially-relative path to absolute using the run's outputDir. */
  private absolutePath(relativePath: string): string {
    if (relativePath.startsWith('/')) return relativePath; // already absolute
    return join(this.queueManager.getState().outputDir, relativePath);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Rebuild asset library from any already-completed assets in generatedOutputs
    const state = this.queueManager.getState();
    this.rebuildAssetLibrary(state);
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

  cancelItem(itemId: string): boolean {
    const controller = this.activeAbortControllers.get(itemId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private async runLane(priority: Priority): Promise<void> {
    while (this.running) {
      const item = this.queueManager.getNextReady(this.queueName, priority);
      if (!item) {
        // No work available — wait before polling again
        await sleep(500);
        continue;
      }

      const abortController = new AbortController();
      this.activeAbortControllers.set(item.id, abortController);

      try {
        this.queueManager.markInProgress(item.id);
        this.emit('item:started', { runId: this.runId, item });

        const outputs = await this.executeItem(item, abortController.signal);

        this.activeAbortControllers.delete(item.id);
        this.queueManager.markCompleted(item.id, outputs);
        this.emit('item:completed', { runId: this.runId, item: { ...item, status: 'completed', outputs } });

        // Seed downstream work items after completion
        this.seedDownstream(item, outputs);

        this.queueManager.save();
      } catch (err) {
        this.activeAbortControllers.delete(item.id);

        // If aborted, mark as cancelled (not failed) and don't retry
        if (abortController.signal.aborted) {
          this.queueManager.cancelItem(item.id);
          this.emit('item:cancelled', { runId: this.runId, item: { ...item, status: 'cancelled' }, error: 'Cancelled by user' });
          this.queueManager.save();
          continue;
        }

        const errorMsg = err instanceof Error ? err.message : String(err);
        const currentRetryCount = item.retryCount ?? 0;

        if (currentRetryCount < MAX_RETRIES) {
          // Re-queue for retry
          this.queueManager.requeueForRetry(item.id);
          this.emit('item:failed', {
            runId: this.runId,
            item: { ...item, status: 'pending', retryCount: currentRetryCount + 1 },
            error: `Retry ${currentRetryCount + 1}/${MAX_RETRIES}: ${errorMsg}`,
          });
          this.queueManager.save();
        } else {
          // Max retries exceeded — mark as permanently failed and pause pipeline
          this.queueManager.markFailed(item.id, errorMsg);
          this.emit('item:failed', { runId: this.runId, item: { ...item, status: 'failed' }, error: errorMsg });
          this.emit('pipeline:pause', { runId: this.runId, item: { ...item, status: 'failed' }, error: errorMsg });
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
    const script = await storyToScript(storyText);
    const state = this.queueManager.getState();
    state.convertedScript = script;
    return { script };
  }

  private async handleAnalyzeStory(item: WorkItem, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    const state = this.queueManager.getState();
    // Use converted script if available, otherwise raw story
    const textToAnalyze = state.convertedScript ?? item.inputs.storyText as string;
    const analysis = await analyzeStory(textToAnalyze);
    state.storyAnalysis = analysis;
    return { analysis };
  }

  private handleArtifact(item: WorkItem): Record<string, unknown> {
    const state = this.queueManager.getState();
    const artifactType = item.inputs.artifactType as string;

    if (!state.storyAnalysis) {
      // Backward compat: if no analysis yet, just pass through
      return { ...item.inputs };
    }

    const analysis = state.storyAnalysis;

    switch (artifactType) {
      case 'character': {
        const name = item.inputs.name as string;
        const existing = analysis.characters.find(c => c.name === name);
        if (existing) {
          existing.physicalDescription = item.inputs.physicalDescription as string;
          existing.personality = item.inputs.personality as string;
          existing.ageRange = item.inputs.ageRange as string;
        } else {
          analysis.characters.push({
            name,
            physicalDescription: item.inputs.physicalDescription as string,
            personality: item.inputs.personality as string,
            ageRange: item.inputs.ageRange as string,
          });
        }
        break;
      }
      case 'location': {
        const name = item.inputs.name as string;
        const existing = analysis.locations.find(l => l.name === name);
        if (existing) {
          existing.visualDescription = item.inputs.visualDescription as string;
        }
        break;
      }
      case 'object': {
        const name = item.inputs.name as string;
        const objects = analysis.objects ?? [];
        const existing = objects.find(o => o.name === name);
        if (existing) {
          existing.visualDescription = item.inputs.visualDescription as string;
        }
        break;
      }
      case 'scene': {
        const sceneNumber = item.inputs.sceneNumber as number;
        const existing = analysis.scenes.find(s => s.sceneNumber === sceneNumber);
        if (existing) {
          existing.title = item.inputs.title as string;
          existing.narrativeSummary = item.inputs.narrativeSummary as string;
          existing.charactersPresent = item.inputs.charactersPresent as string[];
          existing.location = item.inputs.location as string;
          existing.estimatedDurationSeconds = item.inputs.estimatedDurationSeconds as number;
        }
        break;
      }
      case 'pacing': {
        analysis.artStyle = item.inputs.artStyle as string;
        analysis.title = item.inputs.title as string;
        break;
      }
    }

    this.queueManager.save();
    return { ...item.inputs };
  }

  private async handleNameRun(item: WorkItem, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
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

    const durationGuidance = `Shots can be 1-15 seconds long. Choose the duration that best fits the action:
- Very short (1-2s): flash cuts, inserts, whip pans, rapid montage
- Short (2-4s): quick reactions, insert cutaways, snappy dialogue
- Medium (4-8s): establishing shots, dialogue, tracking shots, emotional beats
- Long (8-15s): slow reveals, extended action, lingering moments`;

    const { object } = await (generateObject as any)({
      model: anthropic('claude-opus-4-6'),
      schema: sceneShotsSchema,
      prompt: `You are a cinematic shot planner for Grok video generation. Plan shots for scene ${sceneNumber} of this story.

HOW GROK VIDEO GENERATION WORKS:
Each shot has a START FRAME (an image prompt describing the visual setup) and an ACTION PROMPT (what happens during the shot). Grok generates a video clip starting from the start frame image, guided by the action prompt. There are no end frames — Grok controls where the shot ends based on the action.

SHOT PLANNING PRINCIPLES:
- Each shot = one camera setup on one subject. To change camera angle or subject, make a new shot.
- The startFramePrompt describes the complete visual scene: composition, characters, setting, lighting, camera angle.
- The actionPrompt describes the motion/action that unfolds from that starting point (character gestures, movement, expressions, etc.).
- endFramePrompt must always be an empty string "" (the field is required by the schema but unused).
- Camera movement IS possible — cameraDirection can include pans, zooms, dollies, tracking moves. The camera is not fixed.

COMPOSITION TYPES (what the camera sees and what happens):
- wide_establishing: Wide view of the setting. Shows the environment, characters in context, spatial relationships. Action: characters move through space, enter/exit, interact with environment.
- over_the_shoulder: Camera behind one character's shoulder, focused on the person they're facing. Action: the facing character speaks, reacts, gestures.
- two_shot: Both characters framed together. Action: characters interact, exchange dialogue, react to each other.
- close_up: Tight on one face or detail. Action: expressions change, character speaks, emotional reactions play out.
- medium_shot: Waist-up framing of one character. Action: character speaks, gestures, shifts posture.
- tracking: Camera follows a subject through space. Action: subject walks, runs, moves through environment.
- pov: First-person view of what a character sees. Action: hands interact with objects, environment changes, reveals unfold.
- insert_cutaway: Close detail of an object or prop. Action: hand picks up object, screen displays change, liquid pours, etc.
- low_angle: Dramatic upward angle on a subject. Action: character looms, speaks powerfully, stands up.
- high_angle: Dramatic downward angle on a subject. Action: character looks small, vulnerable, or surveyed from above.

CONTINUITY (continuousFromPrevious):
- When true: the previous shot's start frame is used as a style/continuity reference for this shot.
- Set true ONLY when: same location, same characters, same visual style, and the shots are meant to feel like continuous coverage of the same moment.
- Set false when: it's the first shot of a scene, the subject changes, the location changes, there's a time skip, or the camera setup is very different.

DIALOGUE PACING:
- ~2.5 words/second in film
- Calculate minimum duration from dialogue: word_count / 2.5 + 0.5s buffer, rounded up to nearest integer.
- Not every shot needs dialogue — silence and reactions are valid.

DIALOGUE FORMATTING:
- NEVER use ALL CAPS for normal words — TTS engines spell them out letter by letter.
- Only use ALL CAPS for actual acronyms (FBI, CIA, DNA, NASA, etc.).
- For emphasis, use the word normally — TTS handles natural stress from context.

SCENE TRANSITIONS:
- Scene 1 always uses "cut"
- "cut" for immediate cuts (default, most common)
- "fade_black" for dramatic mood shifts, time jumps, or emotional beats

Plan shots for this scene with:
- transition: the transition type into this scene
- shots: an array of shot objects with all required fields

For this scene:
1. Choose a transition type (Scene 1 is always "cut")
2. ${durationGuidance}
3. Assign cinematic composition types (use underscore format: wide_establishing, over_the_shoulder, etc.)
4. Distribute dialogue across shots. "Dialogue" includes ALL spoken content: character speech, narration, voiceover, inner monologue, and any text that should be heard by the viewer. If the scene description mentions a voice, narrator, or internal thought, include it as dialogue in the appropriate shot. Shot durations MUST be whole numbers (integers), minimum 2 seconds. Never use fractional durations like 1.5 or 2.5. CRITICAL: calculate the minimum duration for each shot from its dialogue word count at ~2.5 words/second, then add 0.5s buffer. The shot's durationSeconds must NEVER be less than this minimum. Example: 12 words of dialogue = 12/2.5 + 0.5 = 5.3s → round up to 6s minimum.
5. Write detailed startFramePrompt that fully describes the visual scene: composition type, characters' appearance, setting, lighting, camera angle. endFramePrompt must be an empty string "".
6. Write actionPrompt describing what happens during the shot — character motion, gestures, expressions, environmental changes.
7. In actionPrompt and startFramePrompt fields ONLY, describe characters by their visual appearance (e.g., "the man in the blue suit", "the woman with red hair") rather than by name — character names in video prompts trigger content safety filters. However, in the dialogue field, USE the actual character names naturally as they appear in the script.
8. Include ALL spoken/heard content as dialogue: character speech, narration, voiceover, inner monologue. If the scene has narration or a voice giving instructions, those words go in the dialogue field. For each shot with dialogue, set the speaker field to identify WHO is speaking — use the character's name (e.g. "Nate", "Sarah"), "narrator", "voiceover", "inner monologue", etc. Leave speaker empty if the shot has no dialogue.
9. For each shot, populate objectsPresent with the names of any key objects/products/props that appear in that shot.${objectsNote}

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

  private async handleGenerateAsset(item: WorkItem, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    const state = this.queueManager.getState();
    const aspectRatio = state.options?.aspectRatio;
    const result = await generateAsset({
      characterName: item.inputs.characterName as string | undefined,
      locationName: item.inputs.locationName as string | undefined,
      objectName: item.inputs.objectName as string | undefined,
      description: item.inputs.description as string,
      artStyle: item.inputs.artStyle as string,
      outputDir: join(state.outputDir, 'assets'),
      referenceImagePath: item.inputs.referenceImagePath as string | undefined,
      videoBackend: 'grok',
      aspectRatio,
    });

    state.generatedOutputs[result.key] = this.relativePath(result.path);

    // Build asset library from generated outputs
    this.rebuildAssetLibrary(state);

    return { key: result.key, path: this.relativePath(result.path) };
  }

  private async handleGenerateFrame(item: WorkItem, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    const state = this.queueManager.getState();
    if (!state.storyAnalysis || !state.assetLibrary) {
      throw new Error('generate_frame requires storyAnalysis and assetLibrary');
    }

    const shot = item.inputs.shot as Shot;
    const previousEndFramePath = item.inputs.previousEndFramePath
      ? this.absolutePath(item.inputs.previousEndFramePath as string)
      : undefined;

    const aspectRatio = state.options?.aspectRatio;
    const result = await generateFrame({
      shot,
      artStyle: state.storyAnalysis.artStyle,
      assetLibrary: state.assetLibrary,
      outputDir: state.outputDir,
      previousEndFramePath,
      videoBackend: 'grok',
      aspectRatio,
    });

    if (result.startPath) {
      state.generatedOutputs[`frame:shot:${shot.shotNumber}:start`] = this.relativePath(result.startPath);
    }
    if (result.endPath) {
      state.generatedOutputs[`frame:shot:${shot.shotNumber}:end`] = this.relativePath(result.endPath);
    }

    return {
      shotNumber: result.shotNumber,
      startPath: result.startPath ? this.relativePath(result.startPath) : result.startPath,
      endPath: result.endPath ? this.relativePath(result.endPath) : result.endPath,
    };
  }

  private async handleGenerateVideo(item: WorkItem, signal: AbortSignal): Promise<Record<string, unknown>> {
    const state = this.queueManager.getState();
    const shot = item.inputs.shot as Shot;
    const startFramePath = this.absolutePath(item.inputs.startFramePath as string);
    const endFramePath = item.inputs.endFramePath
      ? this.absolutePath(item.inputs.endFramePath as string)
      : undefined;
    const aspectRatio = state.options?.aspectRatio;

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
      aspectRatio,
      abortSignal: signal,
    });

    state.generatedOutputs[`video:shot:${shot.shotNumber}`] = this.relativePath(result.path);

    // Post-generation pacing analysis
    const isManualDuration = state.manualDurations?.[shot.shotNumber];
    if (isManualDuration) {
      console.log(`[pacing] Skipping pacing analysis for shot ${result.shotNumber} (duration manually set by user)`);
    }

    if (result.path && !isManualDuration) {
      try {
        const shotObj = state.storyAnalysis?.scenes.flatMap(s => s.shots).find(s => s.shotNumber === result.shotNumber);
        const shotDialogue = shotObj?.dialogue;
        const absolutePath = this.absolutePath(this.relativePath(result.path));
        const analysis = await analyzeClipPacing(absolutePath, result.shotNumber, result.duration, shotDialogue);
        console.log(`[pacing] Shot ${result.shotNumber}: ${result.duration}s → ${analysis.recommendedDuration}s (${analysis.reason})`);

        const savings = result.duration - analysis.recommendedDuration;
        if (savings >= 1 && analysis.confidence !== 'low') {
          console.log(`[pacing] Regenerating shot ${result.shotNumber} at ${analysis.recommendedDuration}s (saving ${savings.toFixed(1)}s)`);

          const regenResult = await generateVideo({
            shotNumber: shot.shotNumber,
            shotType: 'first_last_frame',
            actionPrompt: shot.actionPrompt,
            dialogue: shot.dialogue,
            soundEffects: shot.soundEffects,
            cameraDirection: shot.cameraDirection,
            durationSeconds: analysis.recommendedDuration,
            startFramePath,
            endFramePath: endFramePath ?? startFramePath,
            outputDir: join(state.outputDir, 'videos'),
            videoBackend: 'grok',
            characterNames: state.storyAnalysis?.characters.map(c => c.name) ?? [],
            abortSignal: signal,
          });

          state.generatedOutputs[`video:shot:${shot.shotNumber}`] = this.relativePath(regenResult.path);
          if (shotObj) shotObj.durationSeconds = analysis.recommendedDuration;

          return {
            shotNumber: regenResult.shotNumber,
            path: this.relativePath(regenResult.path),
            duration: regenResult.duration,
            promptSent: regenResult.promptSent,
            pacingAdjusted: true,
            originalDuration: result.duration,
            newDuration: analysis.recommendedDuration,
          };
        }
      } catch (err) {
        console.warn(`[pacing] Failed to analyze shot ${result.shotNumber}, keeping original:`, err);
      }
    }

    return {
      shotNumber: result.shotNumber,
      path: this.relativePath(result.path),
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
      .filter((p): p is string => !!p)
      .map(p => this.absolutePath(p));

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
        this.seedAfterGenerateVideo();
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

    state.assetLibrary = lib;
    console.log('[rebuildAssetLibrary] Asset library:', JSON.stringify(lib, null, 2));
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
      proc.on('item:cancelled', (data) => this.emit('item:cancelled', data));
      proc.on('pipeline:pause', (data) => this.emit('pipeline:pause', data));
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
