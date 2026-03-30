import { z } from "zod";
import type { StoryAnalysis, Shot } from "../types";

// ---------------------------------------------------------------------------
// Cinematic rules — exported so the orchestrator can include them in prompts
// ---------------------------------------------------------------------------

export const CINEMATIC_RULES = `
FIXED CAMERA RULE (MOST IMPORTANT):
A shot is what a single, stationary camera sees. The camera does not move, pan, or change its target during a shot.
- The start frame describes what this camera sees at the beginning of the shot.
- If the start frame is pointed at Person A, the shot stays on Person A. You CANNOT switch to Person B.
- If the start frame shows a wide view of a room, the shot shows the SAME wide view of the SAME room.
- If you need to show a different person or a different angle: that is a DIFFERENT SHOT. Use a cut.
- To switch focus to a different person, END the current shot and START a new shot on that person. This is how real films work — cut to the new subject.
- Example: Shot 3 = close-up of Alice speaking. Shot 4 = close-up of Bob reacting. Two shots, one cut.

NO CUTS WITHIN A SHOT:
A single shot NEVER contains a cut, transition, or camera angle change. Phrases like "Cut to...", "We then see...", "Switch to...", or "The camera moves to show..." within a shot's action prompt are WRONG.
- If you need a different angle, framing, or subject — that is a NEW SHOT.
- Each shot's actionPrompt describes continuous action from ONE camera position.
- Bad: "He picks up the glass. Cut to a medium angle showing him drinking." → This is TWO shots.
- Good: Shot 1: "He picks up the glass and lifts it." Shot 2: "Medium angle — he drinks in measured sips."

START FRAME CONSTRAINTS:
Each shot has a START FRAME (an image) and an ACTION PROMPT (what happens). A video model generates the clip from the start frame guided by the action.
- The start frame describes the visual setup: composition, characters, setting, lighting, camera angle.
- The action prompt describes what happens during the shot.
- If you need a different camera angle or different character focus, that is a NEW SHOT (cut to it).

CONTINUITY FLAG (continuousFromPrevious):
- Default to continuousFromPrevious=true whenever the camera stays on the same subject from the same angle. When true, the start frame is extracted from the end of the previous video clip, giving seamless visual continuity. When false, a fresh start frame is generated.
- Only set continuousFromPrevious=false for an actual CUT: new camera angle, new subject, new location, or a different composition type.
- The first shot of every scene MUST set continuousFromPrevious=false.
- Examples: same medium shot of a person doing two consecutive actions = true. Switching from medium shot to close-up = false. Same close-up on a face, continuing to talk = true. Cutting from one character to another = false.

COMPOSITION TYPES:
- wide_establishing: Wide view of the setting. Characters in context, spatial relationships.
- over_the_shoulder: Camera behind ONE character's shoulder, focused on the person they're facing.
- two_shot: Both characters framed together.
- close_up: Tight on ONE face. NEVER switch to a different person's face within a shot.
- medium_shot: Waist-up of ONE character.
- tracking: Camera follows ONE subject through space.
- pov: First-person view of what a character sees.
- insert_cutaway: Close detail of an object or prop.
- low_angle: Dramatic upward angle on ONE subject.
- high_angle: Dramatic downward angle on ONE subject.

DIALOGUE GAZE:
- Characters speaking to each other should look at the person they are addressing, not at the camera.
- Only have a character look directly at the camera if the story explicitly calls for breaking the fourth wall.
- In over_the_shoulder and two_shot compositions, describe the eye line and eye contact between characters.

COMMON MISTAKES TO AVOID:
- Do NOT write a close_up that switches from Character A to Character B — that is two shots.
- Do NOT write an over_the_shoulder that changes which character's shoulder we're behind — that is two shots.
- If dialogue passes from A to B during a shot, keep the CAMERA on whoever the shot is framed on. The other character's dialogue happens off-screen or in the next shot.
- Want to show B's reaction to what A said? Great — make that the NEXT shot (a new close_up on B). Don't try to cram both into one shot.

Typical dialogue scene pattern (2 characters, ~26s):
1. Wide two-shot establishing (8s) — both characters visible. Start: standing apart. End: facing each other.
2. Close-up on Character A (6s) — A speaks. Only expression/mouth changes between start and end.
3. Close-up on Character B (6s) — B reacts. Only expression changes between start and end.
4. OTS on A from behind B's shoulder (6s) — A continues speaking, small gesture between start and end.

SHOT DURATION:
- Shots can be 0.5-10 seconds long. Default to 8s unless a shorter/longer duration better fits the action.
- When using Veo backend, all shots are rendered as 8s regardless of the specified duration.
- When using ComfyUI backend, the actual duration is used (supports fractional seconds).
- Very short shots (0.5-2s) work well for: flash cuts, inserts, whip pans, rapid montage.
- Short shots (2-4s) work well for: quick reaction shots, insert cutaways, snappy dialogue.
- Medium shots (4-8s) work well for: establishing shots, dialogue, tracking shots, emotional beats.
- Long shots (8-10s) work well for: slow reveals, extended action, lingering moments.

DIALOGUE PACING:
- ~2.5 words/second in film
- 8s clip: ~15-20 words
- 6s clip: ~10-12 words
- 4s clip: ~6-8 words
- 2s clip: ~3-5 words
- Not every shot needs dialogue — silence and reactions are valid

DIALOGUE FORMATTING:
- NEVER use ALL CAPS for normal words in dialogue — TTS engines will spell them out letter by letter (e.g. "STOP" becomes "S-T-O-P")
- Only use ALL CAPS for actual acronyms (FBI, CIA, DNA, NASA, etc.)
- For emphasis, use the word normally — the TTS will handle natural stress from context
- Wrong: "We NEED to go NOW!" / Right: "We need to go now!"
- Wrong: "STOP right there!" / Right: "Stop right there!"

SCENE TRANSITIONS:
- Scene 1 always uses "cut" (no transition before the first scene)
- "cut" for immediate cuts between scenes (default, most common)
- "fade_black" for dramatic mood shifts, time jumps, or emotional beats — quick fade out to black then fade in
- Keep transitions SHORT (0.5-0.75 second) — they shouldn't distract

PROMPT WRITING STYLE:
- startFramePrompt should read like a director's shot description, NOT a character sheet or casting call.
- Focus on blocking (where characters stand/sit), action (what they're doing), camera angle, and composition.
- Reference images provide all character and location appearance — the prompt provides DIRECTION.
- Refer to characters by name (e.g., "Elena") or role (e.g., "the detective"). Do NOT describe hair color, eye color, skin tone, clothing details, or other physical attributes.
- Do NOT describe location visuals in detail — the location reference image handles that. Just name the location.
- BAD startFramePrompt: "Wide shot of the restaurant entrance interior, warm ambient golden lighting, exposed brick walls visible. Liam stands alone near the entrance. Soft candlelight glows from tables in the background. Evening cityscape visible through arched windows."
- GOOD startFramePrompt: "Wide shot, Liam stands alone near the restaurant entrance, slightly off-center right, one hand adjusting his shirt cuff. His posture is upright but tense. Tables visible in the background."
- The bad example wastes words on lighting, materials, and architectural details that the location reference image already provides. The good example focuses on character blocking, pose, expression, and composition.
- Keep startFramePrompt concise: under 150 words. Every word should describe composition or action, not appearance.

ACTION PROMPT WRITING STYLE:
- actionPrompt describes what HAPPENS during the shot — it builds on the start frame, which already shows the visual scene.
- The start frame provides all visual context (character appearance, object appearance, setting). actionPrompt only adds motion and change.
- Think of actionPrompt as a director calling out blocking cues: "Elena reaches for the cup, lifts it, sips, sets it down."
- Describe the sequence of actions, gestures, facial expression changes, and camera movement.
- Use character names ("Elena") or roles ("the woman"), NOT physical descriptions ("the woman with dark brown hair").
- Reference objects by name ("the toothpaste tube"), NOT by appearance ("the sleek white-and-blue toothpaste tube").
- Do NOT re-describe what the start frame already shows. No appearance, no clothing, no setting details.
- Keep actionPrompt concise — every word should describe motion, not appearance.

`;

// ---------------------------------------------------------------------------
// Per-scene shot schema (no shotNumber or sceneNumber — auto-assigned)
// ---------------------------------------------------------------------------

const perSceneShotSchema = z.object({
  shotInScene: z.number(),
  durationSeconds: z.number(),
  shotType: z.literal("first_last_frame"),
  composition: z.string(),
  startFramePrompt: z.string(),
  actionPrompt: z.string(),
  dialogue: z.string(),
  speaker: z.string().describe("Who is speaking the dialogue (character name, 'narrator', 'voiceover', etc). Empty if no dialogue"),
  soundEffects: z.string(),
  cameraDirection: z.string(),
  charactersPresent: z.array(z.string()),
  objectsPresent: z.array(z.string()).optional(),
  location: z.string(),
  continuousFromPrevious: z.boolean().optional(),
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

  // Process shots: assign shotNumber, sceneNumber, ensure shotType
  const processedShots: Shot[] = shots.map((shot) => ({
    ...shot,
    shotNumber: nextShotNumber++,
    sceneNumber,
    shotType: "first_last_frame" as const,
    durationSeconds: Math.max(2, Math.ceil(shot.durationSeconds)),
    objectsPresent: shot.objectsPresent ?? [],
    continuousFromPrevious: shot.shotInScene > 1 ? (shot.continuousFromPrevious ?? false) : false,
  }));

  return processedShots;
}

