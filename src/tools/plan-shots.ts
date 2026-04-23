import { z } from "zod";
import type { StoryAnalysis, Shot } from "../types";

// ---------------------------------------------------------------------------
// Per-scene shot schema (no shotNumber or sceneNumber — auto-assigned)
// ---------------------------------------------------------------------------

const perSceneShotSchema = z.object({
  shotInScene: z.number(),
  durationSeconds: z.number(),
  shotType: z.literal("first_last_frame"),
  composition: z.string(),
  startFramePrompt: z.string(),
  dialogue: z.string(),
  speaker: z.string().describe("Who is speaking the dialogue (character name, 'narrator', 'voiceover', etc). Empty if no dialogue"),
  soundEffects: z.string(),
  cameraDirection: z.string(),
  videoPrompt: z.string().describe("Complete video direction as natural prose: action, dialogue with visual attribution, gaze, sound effects, camera movement. Use visual descriptors (not character names) since the video model only sees pixels."),
  charactersPresent: z.array(z.string()),
  objectsPresent: z.array(z.string()),
  location: z.string(),
  continuousFromPrevious: z.boolean(),
});

// ---------------------------------------------------------------------------
// Tool definition — structured save mechanism for per-scene shot data
// ---------------------------------------------------------------------------

export const planShotsForSceneTool = {
  description: "Save the planned shots for a single scene. Call once per scene, in order.",
  parameters: z.object({
    sceneNumber: z.number(),
    transition: z.enum(["cut", "fade_black"]),
    shots: z.array(perSceneShotSchema),
  }),
};

// ---------------------------------------------------------------------------
// Core function — processes planned shots for one scene (no cloning)
// ---------------------------------------------------------------------------

/**
 * Processes raw planned shots for a single scene: assigns global `shotNumber`
 * and `sceneNumber`, enforces minimum duration, and defaults optional fields.
 *
 * Returns the processed shots array. The caller is responsible for merging
 * these into the analysis (e.g. via `qm.updateSceneShots()`).
 */
export function planShotsForScene(
  sceneNumber: number,
  shots: z.infer<typeof planShotsForSceneTool.parameters>["shots"],
  analysis: StoryAnalysis,
): Shot[] {
  // Verify the scene exists
  const sceneExists = analysis.scenes.some(s => s.sceneNumber === sceneNumber);
  if (!sceneExists) {
    throw new Error(`Scene ${sceneNumber} not found in analysis`);
  }

  // Count existing shots across ALL other scenes to determine the next global shotNumber
  let nextShotNumber = 1;
  for (const scene of analysis.scenes) {
    if (scene.sceneNumber === sceneNumber) continue; // skip the scene we're about to fill
    nextShotNumber += (scene.shots?.length ?? 0);
  }

  // Process shots: assign shotNumber, sceneNumber, ensure shotType.
  // Enforce duration bounds:
  //   - Absolute minimum: 2s
  //   - Dialogue floor: ceil(wordCount / 2.5 + 0.5) — the TTS needs this much time
  //   - Hard ceiling: 15s (Grok's max supported duration)
  const processedShots: Shot[] = shots.map((shot) => {
    const wordCount = shot.dialogue ? shot.dialogue.trim().split(/\s+/).filter(Boolean).length : 0;
    const dialogueFloor = wordCount > 0 ? Math.ceil(wordCount / 2.5 + 0.5) : 0;
    const requested = Math.ceil(shot.durationSeconds);
    const duration = Math.min(15, Math.max(2, dialogueFloor, requested));
    if (dialogueFloor > requested) {
      console.log(`[duration-fix] scene ${sceneNumber} shot ${shot.shotInScene}: bumped ${requested}s → ${duration}s to fit ${wordCount} words of dialogue (floor=${dialogueFloor}s)`);
    }
    if (wordCount > 36) {
      console.log(`[dialogue-overflow] scene ${sceneNumber} shot ${shot.shotInScene}: ${wordCount} words of dialogue exceeds 36-word per-shot limit (floor=${dialogueFloor}s > 15s ceiling). The planner failed to split this speech across shots. Dialogue will likely be truncated or talk over itself at the 15s clamp. Speaker="${shot.speaker}".`);
    }
    return {
      ...shot,
      shotNumber: nextShotNumber++,
      sceneNumber,
      shotType: "first_last_frame" as const,
      durationSeconds: duration,
      objectsPresent: shot.objectsPresent ?? [],
      continuousFromPrevious: shot.shotInScene > 1 ? (shot.continuousFromPrevious ?? false) : false,
    };
  });

  // Post-planning continuity validation: enforce continuousFromPrevious=false
  // when the LLM incorrectly sets it for shots with new characters or location changes.
  for (let i = 0; i < processedShots.length; i++) {
    const shot = processedShots[i];

    // Safety: first shot in scene must never be continuous
    if (shot.shotInScene === 1) {
      if (shot.continuousFromPrevious) {
        console.log(`[continuity-fix] scene ${sceneNumber} shot ${shot.shotInScene}: forced continuousFromPrevious=false because it is the first shot in the scene`);
        shot.continuousFromPrevious = false;
      }
      continue;
    }

    if (!shot.continuousFromPrevious) continue;

    const prevShot = processedShots[i - 1];
    if (!prevShot) continue;

    // Check for location change
    if (shot.location !== prevShot.location) {
      console.log(`[continuity-fix] scene ${sceneNumber} shot ${shot.shotInScene}: forced continuousFromPrevious=false because location changed from "${prevShot.location}" to "${shot.location}"`);
      shot.continuousFromPrevious = false;
      continue;
    }

    // Check for new characters not present in previous shot
    const prevChars = new Set(prevShot.charactersPresent);
    const newChars = shot.charactersPresent.filter(c => !prevChars.has(c));
    if (newChars.length > 0) {
      console.log(`[continuity-fix] scene ${sceneNumber} shot ${shot.shotInScene}: forced continuousFromPrevious=false because character ${newChars.join(", ")} is not in previous shot`);
      shot.continuousFromPrevious = false;
    }
  }

  return processedShots;
}

