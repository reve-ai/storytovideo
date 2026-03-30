import { EventEmitter } from 'events';
import { execFileSync } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { join, resolve, isAbsolute } from 'path';
import { generateObject, generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';

import type { QueueName, WorkItem } from './types.js';
import { QueueManager } from './queue-manager.js';
import { rateLimiters } from './rate-limiter-registry.js';
import { PromptLogger } from './prompt-logger.js';
import { analyzeStory, buildAnalyzeStoryPrompt } from '../tools/analyze-story.js';
import { storyToScript, buildStoryToScriptPrompt } from '../tools/story-to-script.js';
import { planShotsForScene } from '../tools/plan-shots.js';
import { generateAsset } from '../tools/generate-asset.js';
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
  actionPrompt: z.string(),
  dialogue: z.string(),
  speaker: z.string(),
  soundEffects: z.string(),
  cameraDirection: z.string(),
  videoPrompt: z.string(),
  charactersPresent: z.array(z.string()),
  objectsPresent: z.array(z.string()).optional(),
  location: z.string(),
  continuousFromPrevious: z.boolean().optional(),
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
    this.promptLogger.log(item.itemKey, 'story_to_script', buildStoryToScriptPrompt(storyText), { model: 'claude-opus-4-6' });
    const script = await storyToScript(storyText);
    this.queueManager.setConvertedScript(script);
    return { script };
  }

  private async handleAnalyzeStory(item: WorkItem, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    const state = this.queueManager.getState();
    // Use converted script if available, otherwise raw story
    const textToAnalyze = state.convertedScript ?? item.inputs.storyText as string;
    this.promptLogger.log(item.itemKey, 'analyze_story', buildAnalyzeStoryPrompt(textToAnalyze), { model: 'claude-opus-4-6' });
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
    this.promptLogger.log(item.itemKey, 'name_run', namePrompt, { model: 'claude-sonnet-4-20250514' });
    const limiter = rateLimiters.get('anthropic');
    await limiter.acquire();
    try {
      const { text } = await generateText({
        model: anthropic('claude-sonnet-4-20250514'),
        prompt: namePrompt,
        maxTokens: 30,
      } as any);
      const name = text.trim();
      this.queueManager.setRunName(name);
      return { name };
    } catch (error: any) {
      if (error?.status === 429 || error?.message?.includes('429')) {
        console.warn('[handleNameRun] 429 rate limited — backing off all anthropic workers for 5s');
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

    const durationGuidance = `Shots can be 1-15 seconds long. Choose the duration that best fits the action:
- Very short (1-2s): flash cuts, inserts, whip pans, rapid montage
- Short (2-4s): quick reactions, insert cutaways, snappy dialogue
- Medium (4-8s): establishing shots, dialogue, tracking shots, emotional beats
- Long (8-15s): slow reveals, extended action, lingering moments`;

    const planShotsPrompt = `You are a cinematic shot planner for Grok video generation. Plan shots for scene ${sceneNumber} of this story.

HOW GROK VIDEO GENERATION WORKS:
Each shot has a START FRAME (an image prompt describing the visual setup) and an ACTION PROMPT (what happens during the shot). Grok generates a video clip starting from the start frame image, guided by the action prompt. There are no end frames — Grok controls where the shot ends based on the action.

SHOT PLANNING PRINCIPLES:
- Each shot = one camera setup on one subject. To change camera angle or subject, make a new shot.
- The startFramePrompt describes the complete visual scene: composition, characters, setting, lighting, camera angle.
- The actionPrompt describes the motion/action that unfolds from that starting point (character gestures, movement, expressions, etc.).
- endFramePrompt must always be an empty string "" (the field is required by the schema but unused).
- Camera movement IS possible — cameraDirection can include pans, zooms, dollies, tracking moves. The camera is not fixed.
- continuousFromPrevious controls whether the start frame is extracted from the end of the previous shot's video (true) or generated fresh from reference images (false). Continuity produces much better visual consistency and reduces hallucinations.
- DEFAULT TO TRUE within a scene. Set continuousFromPrevious=true whenever the location is the same as the previous shot and the characters present are the same or a subset of the previous shot — even if the camera angle or composition changes (the video model handles camera changes well).
- Set continuousFromPrevious=false ONLY when: it is the first shot in the scene, the location changes within the scene, a new character enters who was not in the previous shot (the model can't add someone who isn't in the extracted frame), or there is a significant time jump within the scene.
- When in doubt, use continuousFromPrevious=true. Breaking continuity should be the exception, not the norm.

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
5. Write startFramePrompt describing COMPOSITION and ACTION only: framing, character positions, poses, gestures, expressions, spatial relationships, and camera angle. Do NOT describe character appearance (hair, eyes, skin, clothing details) — reference images handle appearance. Do NOT describe location appearance in detail — the location reference image handles that. Avoid lighting, materials, architecture, and decor details already visible in the location reference. Use character names (e.g., "Elena") or role labels (e.g., "the woman") to identify characters rather than physical descriptions. Keep startFramePrompt concise — under 150 words. endFramePrompt must be an empty string "".
   BAD startFramePrompt: "Wide shot of the restaurant entrance interior, warm ambient golden lighting, exposed brick walls visible. Liam stands alone near the entrance. Soft candlelight glows from tables in the background. Evening cityscape visible through arched windows."
   GOOD startFramePrompt: "Wide shot, Liam stands alone near the restaurant entrance, slightly off-center right, one hand adjusting his shirt cuff. His posture is upright but tense. Tables visible in the background."
   The bad example wastes words on lighting, materials, and architectural details that the location reference image already provides. The good example focuses on character blocking, pose, expression, and composition.
6. Write actionPrompt describing MOVEMENT and ACTION only: what characters do, how they move, gestures, facial expressions changing, interactions with objects, environmental changes. The start frame already establishes the visual scene — actionPrompt only adds motion and change. Do NOT describe object appearance (color, shape, material) — the start frame already shows all of this. In actionPrompt, NEVER use character names — the video model cannot read names. Instead, describe characters by their visual appearance using the shortest descriptor that uniquely identifies them in the frame: "the man", "the woman", "the man in the dark suit". If there is only one person of a given gender in the shot, just use "the man" or "the woman". Use character descriptions from the story analysis to pick distinguishing visual features when two characters share the same gender. Reference objects by name ("the toothpaste tube") not description ("the sleek white-and-blue toothpaste tube"). Think of actionPrompt as a director calling out blocking cues, not describing a painting.
7. EVERY startFramePrompt and actionPrompt MUST specify where each character is looking. Default to looking at another character, an object, or into the middle distance. Characters should NEVER look directly at the camera unless the story explicitly requires breaking the fourth wall. If you don't specify gaze, the model will default to the character staring at the camera.
   Examples of good gaze direction: "Elena looks at Marcus across the table" / "Liam gazes down at the menu" / "the woman glances toward the window"
   BAD: "Close-up on Liam as he smiles"
   GOOD: "Close-up on Liam looking slightly off-camera left toward Sophie, a warm smile spreading across his face"
   BAD: "Medium shot of Elena standing in the kitchen"
   GOOD: "Medium shot of Elena looking down at the cutting board, her focus on the vegetables she is chopping"
   For dialogue shots: characters look at each other, not the camera. For solo shots: character looks at their activity, another character off-screen, or into the middle distance. For wide/establishing shots: characters are engaged in their environment, unaware of the camera.
8. In startFramePrompt, refer to characters by name (e.g., "Elena", "Marcus") — the image model has reference images and can map names to faces. In actionPrompt, NEVER use character names — the video model only sees pixels and cannot map names. Instead use short visual descriptors: "the man", "the woman", "the man in the dark suit". Use character descriptions from the story analysis to pick distinguishing visual features when two characters of the same gender are in the shot. In the dialogue field, USE the actual character names naturally as they appear in the script — dialogue goes to TTS, not the video model.
9. Include ALL spoken/heard content as dialogue: character speech, narration, voiceover, inner monologue. If the scene has narration or a voice giving instructions, those words go in the dialogue field. For each shot with dialogue, set the speaker field to identify WHO is speaking — use the character's name (e.g. "Nate", "Sarah"), "narrator", "voiceover", "inner monologue", etc. Leave speaker empty if the shot has no dialogue.
10. For each shot, populate objectsPresent with the names of any key objects/products/props that appear in that shot.${objectsNote}
11. NEVER describe a cut, transition, or camera change within a single shot's actionPrompt. "Cut to..." means you need a NEW shot. Each shot is one continuous take from one camera position.
12. Default to continuousFromPrevious=true within a scene. The only reasons to set it false are: first shot in the scene, location change, a new character entering who wasn't in the previous shot, or a significant time jump. Camera angle and composition changes do NOT require breaking continuity.
13. BEHIND-THE-SUBJECT SHOTS: When describing a shot from behind a character, use explicit physical descriptions the image model cannot misinterpret. Do NOT write "following from behind" or "tracking from behind" — the image model will still generate the character facing the camera. Instead describe what is physically VISIBLE (back, shoulders, back of head) rather than the camera's position relative to the character.
   BAD: "Tracking shot following Marcus from behind as he walks down the hallway"
   BAD: "Over-the-shoulder from behind Elena as she approaches the door"
   GOOD: "Back of Marcus's head and shoulders visible, he faces away from camera, walking down the hallway ahead"
   GOOD: "Rear view of Elena, her back to the camera, she looks ahead at the door in front of her"
   Use descriptors like: "back of the head visible", "character facing away from camera", "seen from behind showing their back and shoulders", "rear view of the character walking away", "character's back to the camera".
14. CHARACTER PROMINENCE IN START FRAMES: Every character who speaks or performs an action in the shot MUST be prominently visible in the startFramePrompt — at minimum a medium shot size (waist up). Do NOT place important characters in the background or distance of the start frame expecting the camera to move toward them. The video model cannot maintain character identity or detail from tiny distant figures. If the shot involves approaching a character, start the frame close enough that they are clearly visible and identifiable.
   BAD: "Wide shot of the restaurant. In the far background, Ethan is visible seated at a table near the window."
   GOOD: "Medium shot of Ethan seated at the candlelit table, looking up expectantly. The restaurant interior is visible around him."
   The video model animates what it can see in the start frame. If a character is too small or distant, the video model will hallucinate their appearance.
15. Write videoPrompt as a COMPLETE, SELF-CONTAINED description of what happens in the shot from the video model's perspective. This is the primary direction sent to the video model — it must contain EVERYTHING the video model needs in natural prose:
   - Character actions and blocking (using visual descriptors, NOT names — the video model can't read names)
   - Dialogue with natural visual attribution: "the man turns to the woman and says '...'"
   - Where each character is looking (gaze direction) — NEVER at the camera
   - Sound effects and ambient audio woven naturally into the description
   - Camera movement
   Write it as a flowing paragraph of direction, not a list. The existing structured fields (dialogue, speaker, soundEffects, cameraDirection, actionPrompt) are still required — they're used for TTS, subtitles, and metadata. But videoPrompt is what goes to the video model and must be self-contained.
   Example videoPrompt: "The woman looks across the table at the man and says 'I never thought we'd end up here.' She reaches for her glass, her eyes staying on him. The man shifts in his seat, glancing down at his hands before meeting her gaze. Ambient restaurant chatter and soft clinking of glasses. Camera slowly pushes in on a slight dolly."
   CRITICAL — ABSENT CHARACTERS: If the dialogue mentions a character who is NOT in charactersPresent for this shot, the videoPrompt MUST explicitly state that only the visible characters are in the frame. The video model will hallucinate people into the scene if they are referenced without being excluded. For example, if the man says "Sophie called me yesterday" but Sophie is not in charactersPresent, write: "Only the man is visible in the frame. He looks down at his phone and says 'Sophie called me yesterday.'" Do NOT mention absent characters by name or visual description without clarifying they are not present.

Full story analysis for context:
${JSON.stringify(analysis, null, 2)}

Scene to plan:
${JSON.stringify(scene, null, 2)}`;

    this.promptLogger.log(item.itemKey, 'plan_shots', planShotsPrompt, { model: 'claude-opus-4-6', sceneNumber });

    const limiter = rateLimiters.get('anthropic');
    await limiter.acquire();
    let planResult;
    try {
    planResult = await (generateObject as any)({
      model: anthropic('claude-opus-4-6'),
      schema: sceneShotsSchema,
      prompt: planShotsPrompt,
    });
    } catch (error: any) {
      if (error?.status === 429 || error?.message?.includes('429')) {
        console.warn('[handlePlanShots] 429 rate limited — backing off all anthropic workers for 5s');
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
    const imageBackend = state.options?.imageBackend ?? 'grok';
    console.log(`[handleGenerateAsset] Using imageBackend=${imageBackend} (${item.itemKey})`);
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

    this.promptLogger.log(item.itemKey, 'generate_asset', result.finalPrompt, { backend: imageBackend, key: result.key });

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
      actionPrompt: shot.actionPrompt,
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
    const referenceImagePaths = (item.inputs.referenceImagePaths as string[]).map(p => this.absolutePath(p));
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

    // Get actual clip durations via ffprobe
    const actualDurations: number[] = [];
    for (const vp of videoPaths) {
      actualDurations.push(await getVideoDuration(vp));
    }

    // Build a per-shot transition lookup: transitions[i] applies between shot i and shot i+1
    // transitions array has one entry per scene boundary (in order), so map them to shot indices
    const shotTransitions: Array<{ type: 'cut' | 'fade_black'; durationMs: number } | null> = [];
    let transIdx = 0;
    for (let i = 0; i < sortedShots.length - 1; i++) {
      if (sortedShots[i].sceneNumber !== sortedShots[i + 1].sceneNumber) {
        shotTransitions.push(transitions[transIdx] || null);
        transIdx++;
      } else {
        shotTransitions.push(null); // no transition between shots in same scene
      }
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

      // Subtract xfade overlap at scene boundaries (the xfade causes clips to overlap)
      const trans = shotTransitions[i];
      if (trans && trans.type !== 'cut' && trans.durationMs > 0) {
        cumulativeTime -= trans.durationMs / 1000;
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
      analyzeShot = {
        ...shot,
        startFramePrompt: `Continuity shot: The start frame is the last frame extracted from the previous shot (scene ${shot.sceneNumber} shot ${shot.shotInScene - 1}). It should show visual continuity with the end of that shot. The action described should flow naturally from that starting point.`,
      };
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
