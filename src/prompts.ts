// ---------------------------------------------------------------------------
// Consolidated static prompt text for all tools
// ---------------------------------------------------------------------------

// ---- VIDEO MODEL LIMITATIONS (new preamble for shot planning) ----

export const VIDEO_MODEL_LIMITATIONS = `VIDEO MODEL LIMITATIONS — understand these before writing any prompts:

Face generation: The video model cannot generate a correct face from scratch. If a face is not visible in the start frame, the model will invent a random face that does not match the character reference. Faces can only be maintained if they were clearly visible in the start frame or extracted via continuity from the previous shot.

People hallucination: The video model will hallucinate people into the scene if any human is mentioned in the prompt text — including unnamed figures like waiters, staff, diners, or crowd members. It will also hallucinate a person if an off-screen character is referenced by name or role. Only characters with attached reference images in the start frame will look correct.

Audio generation: The video model generates audio from prompt text. Mentioning music, jazz, soundtrack, or any musical term produces audible music in the clip. Only non-musical ambient sounds should be described.

Camera awareness: The model defaults to characters looking directly at the camera (trained on YouTube/interview data). Every prompt must explicitly direct character gaze away from the camera.

Identity mapping: The video model cannot map character names to visual appearances — it only sees pixels. Names like 'Elena' in the videoPrompt are meaningless. Characters must be described by visual appearance ('the man', 'the woman in the red jacket').

Character scale: The video model cannot maintain character identity for small or distant figures. Characters must be prominently visible (at minimum medium shot size) in the start frame to be animated correctly.

Scene persistence: The video model cannot introduce new visual elements mid-shot that were not established in the start frame. New characters walking in will have invented appearances. Environmental changes must be subtle extensions of what the start frame shows.`;



// ---- Shot planning (from processors.ts) ----

export const DURATION_GUIDANCE = `TEMPO: Default to FAST. Every shot must earn its screen time with visible action, dialogue, or meaningful change. Dead air kills the video.

Shot durations (2-10s). Shorter is almost always better:
- Flash (2-3s): DEFAULT for reactions, cutaways, inserts, establishing context, transitions. Use this unless the shot has dialogue or complex action that demands more time.
- Standard (3-5s): Dialogue shots, single actions, most of your shots should land here.
- Extended (5-8s): Tracking shots with continuous action, longer dialogue exchanges. Must have sustained motion or speech throughout — no static holds.
- Long (8-10s): RARE. Only for scenes with heavy dialogue that cannot be split, or a deliberate dramatic pause for maximum emotional impact. If a shot has no dialogue, it almost never needs to be this long.

If nothing visually changes during a shot — no movement, no speech, no reaction — the shot should not exist. Cut it or merge it into an adjacent shot. A shot where a character "stands and looks out the window" for 6 seconds is wasted screen time unless they are speaking or something is happening outside.`;

export const SHOT_PLANNING_PRINCIPLES = `HOW GROK VIDEO GENERATION WORKS:
Each shot has a START FRAME (an image prompt describing the visual setup) and a VIDEO PROMPT (what happens during the shot). Grok generates a video clip starting from the start frame image, guided by the video prompt. There are no end frames — Grok controls where the shot ends based on the video direction.

SHOT PLANNING PRINCIPLES:
- Each shot = one camera setup on one subject. To change camera angle or subject, make a new shot.
- The startFramePrompt describes the complete visual scene: composition, characters, setting, lighting, camera angle.
- The videoPrompt describes the motion/action that unfolds from that starting point as complete natural prose direction for the video model.
- endFramePrompt must always be an empty string "" (the field is required by the schema but unused).
- Camera movement IS possible — cameraDirection can include pans, zooms, dollies, tracking moves. The camera is not fixed.
- continuousFromPrevious controls whether the start frame is extracted from the end of the previous shot's video (true) or generated fresh from reference images (false). Continuity produces much better visual consistency and reduces hallucinations.
- DEFAULT TO TRUE within a scene. Set continuousFromPrevious=true whenever the location is the same as the previous shot and the characters present are the same or a subset of the previous shot — even if the camera angle or composition changes (the video model handles camera changes well).
- Set continuousFromPrevious=false ONLY when: it is the first shot in the scene, the location changes within the scene, a new character enters who was not in the previous shot (the model can't add someone who isn't in the extracted frame), a character's face needs to be visible but wasn't clearly shown in the previous shot (e.g. after an over-the-shoulder or behind-the-subject shot), or there is a significant time jump within the scene.
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
- "fade_black" for dramatic mood shifts, time jumps, or emotional beats`;

export const SHOT_PLANNING_RULES = `Plan shots for this scene with:
- transition: the transition type into this scene
- shots: an array of shot objects with all required fields

For this scene:
1. Choose a transition type (Scene 1 is always "cut")
2. ${DURATION_GUIDANCE}
3. Assign cinematic composition types (use underscore format: wide_establishing, over_the_shoulder, etc.)
4. Distribute dialogue across shots. "Dialogue" includes ALL spoken content: character speech, narration, voiceover, inner monologue, and any text that should be heard by the viewer. If the scene description mentions a voice, narrator, or internal thought, include it as dialogue in the appropriate shot. Shot durations MUST be whole numbers (integers), minimum 2 seconds. Never use fractional durations like 1.5 or 2.5. CRITICAL: calculate the minimum duration for each shot from its dialogue word count at ~2.5 words/second, then add 0.5s buffer. The shot's durationSeconds must NEVER be less than this minimum. Example: 12 words of dialogue = 12/2.5 + 0.5 = 5.3s → round up to 6s minimum.
5. Write startFramePrompt describing COMPOSITION and ACTION only: framing, character positions, poses, gestures, expressions, spatial relationships, and camera angle. Do NOT describe character appearance (hair, eyes, skin, clothing details) — reference images handle appearance. Do NOT describe location appearance in detail — the location reference image handles that. Avoid lighting, materials, architecture, and decor details already visible in the location reference. Use character names (e.g., "Elena") or role labels (e.g., "the woman") to identify characters rather than physical descriptions. Keep startFramePrompt concise — under 150 words. endFramePrompt must be an empty string "".
   BAD startFramePrompt: "Wide shot of the restaurant entrance interior, warm ambient golden lighting, exposed brick walls visible. Liam stands alone near the entrance. Soft candlelight glows from tables in the background. Evening cityscape visible through arched windows."
   GOOD startFramePrompt: "Wide shot, Liam stands alone near the restaurant entrance, slightly off-center right, one hand adjusting his shirt cuff. His posture is upright but tense. Tables visible in the background."
   The bad example wastes words on lighting, materials, and architectural details that the location reference image already provides. The good example focuses on character blocking, pose, expression, and composition.
6. EVERY startFramePrompt and videoPrompt MUST specify where each character is looking. Default to looking at another character, an object, or into the middle distance. Characters should NEVER look directly at the camera unless the story explicitly requires breaking the fourth wall. If you don't specify gaze, the model will default to the character staring at the camera.
   Examples of good gaze direction: "Elena looks at Marcus across the table" / "Liam gazes down at the menu" / "the woman glances toward the window"
   BAD: "Close-up on Liam as he smiles"
   GOOD: "Close-up on Liam looking slightly off-camera left toward Sophie, a warm smile spreading across his face"
   BAD: "Medium shot of Elena standing in the kitchen"
   GOOD: "Medium shot of Elena looking down at the cutting board, her focus on the vegetables she is chopping"
   For dialogue shots: characters look at each other, not the camera. For solo shots: character looks at their activity, another character off-screen, or into the middle distance. For wide/establishing shots: characters are engaged in their environment, unaware of the camera.
7. In startFramePrompt, refer to characters by name (e.g., "Elena", "Marcus") for clarity — the attached reference images provide their visual identity. In videoPrompt, NEVER use character names — the video model only sees pixels and cannot map names. Instead use short visual descriptors: "the man", "the woman", "the man in the dark suit". Use character descriptions from the story analysis to pick distinguishing visual features when two characters of the same gender are in the shot. In the dialogue field, USE the actual character names naturally as they appear in the script — dialogue goes to TTS, not the video model.
8. Include ALL spoken/heard content as dialogue: character speech, narration, voiceover, inner monologue. If the scene has narration or a voice giving instructions, those words go in the dialogue field. For each shot with dialogue, set the speaker field to identify WHO is speaking — use the character's name (e.g. "Nate", "Sarah"), "narrator", "voiceover", "inner monologue", etc. Leave speaker empty if the shot has no dialogue.
9. For each shot, populate objectsPresent with the names of any key objects/products/props that appear in that shot.{OBJECTS_NOTE}
10. NEVER describe a cut, transition, or camera change within a single shot's videoPrompt. "Cut to..." means you need a NEW shot. Each shot is one continuous take from one camera position.
11. Default to continuousFromPrevious=true within a scene. The only reasons to set it false are: first shot in the scene, location change, a new character entering who wasn't in the previous shot, a character's face needs to be visible but wasn't in the previous shot (e.g. after an over-the-shoulder or behind-the-subject shot), or a significant time jump. Camera angle and composition changes do NOT require breaking continuity.
12. BEHIND-THE-SUBJECT SHOTS: When describing a shot from behind a character, use explicit physical descriptions the image model cannot misinterpret. Do NOT write "following from behind" or "tracking from behind" — the image model will still generate the character facing the camera. Instead describe what is physically VISIBLE (back, shoulders, back of head) rather than the camera's position relative to the character.
   BAD: "Tracking shot following Marcus from behind as he walks down the hallway"
   BAD: "Over-the-shoulder from behind Elena as she approaches the door"
   GOOD: "Back of Marcus's head and shoulders visible, he faces away from camera, walking down the hallway ahead"
   GOOD: "Rear view of Elena, her back to the camera, she looks ahead at the door in front of her"
   Use descriptors like: "back of the head visible", "character facing away from camera", "seen from behind showing their back and shoulders", "rear view of the character walking away", "character's back to the camera".
13. CHARACTER PROMINENCE IN START FRAMES: Every character who speaks or performs an action in the shot MUST be prominently visible in the startFramePrompt — at minimum a medium shot size (waist up). Do NOT place important characters in the background or distance of the start frame expecting the camera to move toward them. The video model cannot maintain character identity or detail from tiny distant figures. If the shot involves approaching a character, start the frame close enough that they are clearly visible and identifiable.
   BAD: "Wide shot of the restaurant. In the far background, Ethan is visible seated at a table near the window."
   GOOD: "Medium shot of Ethan seated at the candlelit table, looking up expectantly. The restaurant interior is visible around him."
   The video model animates what it can see in the start frame. If a character is too small or distant, the video model will hallucinate their appearance.
14. Write videoPrompt as a COMPLETE, SELF-CONTAINED description of what happens in the shot from the video model's perspective. This is the primary direction sent to the video model — it must contain EVERYTHING the video model needs in natural prose:
   - Character actions and blocking: describe MOVEMENT and ACTION only — what characters do, how they move, gestures, facial expressions changing, interactions with objects, environmental changes. The start frame already establishes the visual scene — videoPrompt only adds motion and change. Do NOT describe object appearance (color, shape, material) — the start frame already shows all of this. Reference objects by name ("the toothpaste tube") not description ("the sleek white-and-blue toothpaste tube"). Think of videoPrompt as a director calling out blocking cues, not describing a painting.
   - Use visual descriptors, NOT character names — the video model can't read names. Describe characters by their visual appearance using the shortest descriptor that uniquely identifies them in the frame: "the man", "the woman", "the man in the dark suit". If there is only one person of a given gender in the shot, just use "the man" or "the woman". Use character descriptions from the story analysis to pick distinguishing visual features when two characters share the same gender.
   - Dialogue with natural visual attribution: "the man turns to the woman and says '...'"
   - Where each character is looking (gaze direction) — NEVER at the camera
   - Sound effects and ambient audio woven naturally into the description. NEVER mention music, jazz, soundtrack, score, or any musical element — the video model will generate audible music if you mention it. Only describe non-musical sounds: speech, footsteps, clinking glasses, wind, traffic, etc.
   - Camera movement
   Write it as a flowing paragraph of direction, not a list. The existing structured fields (dialogue, speaker, soundEffects, cameraDirection) are still required — they're used for TTS, subtitles, and metadata. But videoPrompt is what goes to the video model and must be self-contained.
   Example videoPrompt: "The woman looks across the table at the man and says 'I never thought we'd end up here.' She reaches for her glass, her eyes staying on him. The man shifts in his seat, glancing down at his hands before meeting her gaze. Ambient restaurant chatter and soft clinking of glasses. Camera slowly pushes in on a slight dolly."
   CRITICAL — ABSENT CHARACTERS: The videoPrompt must NEVER reference any character who is NOT in charactersPresent for that shot — not in action, not in gaze direction, not in blocking, not in dialogue, not anywhere. The video model will hallucinate people into the scene if they are mentioned in any context. Instead of 'she looks off-screen right toward the older man', write 'she looks off-screen right.' Instead of 'he waves goodbye to Sarah', write 'he waves goodbye off-screen.' Instead of 'the man says Sophie called me yesterday', write 'Only the man is visible in the frame. He says Sophie called me yesterday.' If a character is not in charactersPresent, they do not exist in the videoPrompt — not even as someone being looked at, spoken to, or referenced by name. Use directional cues ('off-screen right', 'toward something off-camera') instead of naming the absent person.
15. NO UNNAMED HUMANS: NEVER mention ANY human figure who is not listed in charactersPresent for that shot. This includes waiters, servers, bartenders, hosts, background diners, couples at nearby tables, passersby, staff, or any unnamed person. The video model will hallucinate random people into the scene. If the story involves a waiter serving food, describe the food appearing on the table or show only disembodied hands — never describe a waiter as a person. If the scene is in a restaurant, describe empty tables, not tables with diners. Do NOT use phrases like 'other diners', 'background patrons', 'couples at nearby tables', 'the crowd', etc. The ONLY humans visible in any shot must be those listed in charactersPresent.
16. NEVER include music, jazz, songs, score, soundtrack, or any musical terms in videoPrompt or soundEffects. The video model generates audio and will produce music if prompted. Only reference non-musical ambient sounds (chatter, footsteps, wind, clinking, engine noise, etc). Music is added in post-production.
17. FACE VISIBILITY RULE: When planning a shot with continuousFromPrevious=true, consider whether every character whose face needs to be visible in this shot also had their face clearly visible in the previous shot. If the previous shot was an over-the-shoulder, behind-the-subject, or insert shot where a character's face was NOT visible (back of head, side profile, or off-screen), and the current shot needs to show that character's face, set continuousFromPrevious=false so a fresh start frame is generated with the correct reference image. The video model cannot generate a correct face from scratch — it will hallucinate a random face that doesn't match the character. Only faces that were clearly visible in the previous shot's frame will be rendered correctly in a continuous shot.
18. MID-SHOT FACE REVEAL BAN: The video model CANNOT generate a correct face that is not already visible in the start frame. If a character is facing away, shown from behind, or otherwise has their face hidden in the startFramePrompt, the videoPrompt MUST NOT describe them turning around, looking over their shoulder toward camera, or otherwise revealing their face during the shot. The resulting face will be randomly generated and will not match the character. If you need to show a character's face after a behind-the-subject shot, create a NEW shot with continuousFromPrevious=false so the start frame is generated fresh from reference images with the character's face visible. Similarly, if a character enters the shot during the video (walks into frame), do NOT describe their face becoming visible — either start the shot with them already in frame (face visible in startFramePrompt) or keep them out of frame entirely and show them in the next shot.
19. DIALOGUE PLACEMENT: In videoPrompt, describe all visual blocking and action BEFORE dialogue. The video model handles sequential actions well, so structure each shot as: physical movement and gestures first, then spoken lines. Example: "The man holds both hands out in a calming gesture, looking off-screen right. He says: 'Now, now. I'll ask the Microvac right now.'" — not "He says 'Now, now' while holding his hands out."
20. ACTION COMPLEXITY: Limit each shot to at most 2 simultaneously active characters performing independent actions. If more characters need to act independently, split into separate shots — e.g., a reaction shot of the children, then cut to parents watching. Wide establishing shots can show multiple characters but only 1-2 should have complex independent motion.
21. MOTION INTENSITY: Use adverbs of degree to specify how actions should be performed — "slowly reaches", "rapidly turns", "gently places", "violently shakes", "powerfully stands". The video model responds strongly to motion intensity words and produces better results with explicit degree modifiers.
22. PACING AND TEMPO: The overall tempo should be FAST. Think trailer editing, not art house cinema. Every shot must have visible action, dialogue, or meaningful visual change happening throughout its duration. Apply these rules aggressively:
   - NO DEAD AIR: If a shot has no dialogue and no meaningful action (just a character standing, sitting, or looking), either cut it entirely or merge it into an adjacent shot. The only exception is a rare, deliberate dramatic beat — and even then, keep it to 2-3 seconds max.
   - CUT FAST: Default to the shortest duration that fits the content. If a shot could work at 3s or 5s, use 3s. Audiences process visuals faster than you think.
   - EARN EVERY SECOND: Before finalizing any shot longer than 4 seconds, verify that something is happening for the ENTIRE duration — not just the first half. A 6-second shot where the character acts for 3 seconds then holds still is really a 3-second shot.
   - ESTABLISHING SHOTS ARE SHORT: Wide establishing shots should be 2-3 seconds — just long enough to orient the viewer — then cut to the action. Don't linger.
   - REACTION SHOTS ARE SHORT: A character reacting (nodding, smiling, looking surprised) is 2-3 seconds, not 5.
   - PREFER MORE CUTS OVER LONGER SHOTS: 3 shots at 3 seconds each is almost always better than 1 shot at 9 seconds. More angles = more visual energy.
23. SCREENS AND DISPLAYS: If a shot includes a computer, phone, tablet, TV, monitor, or any device with a screen, add this instruction to BOTH the startFramePrompt and videoPrompt: "Images appear only on the screen. Not the back." This prevents the video model from hallucinating content on the wrong surface of the device. Apply this whenever any screen-bearing object is visible in the shot — whether held by a character, sitting on a desk, mounted on a wall, etc.`;

// ---- Video prompt constants (from generate-video.ts) ----

export const VIDEO_PROMPT_PREAMBLE_WITH_CHARACTERS = "Cinematic narrative film, candid fly-on-the-wall cinematography. Characters look at each other, at objects, or into the distance. Only the visible characters are in the scene.";

export const VIDEO_PROMPT_PREAMBLE_NO_CHARACTERS = "Cinematic narrative film. Empty scene, no people visible.";

export const VIDEO_PROMPT_SUFFIX = "Ambient sounds only.";

// ---- Frame prompt constants (from generate-frame.ts) ----

export const FRAME_PROMPT_STYLE_PREFIX = "Cinematic narrative film still. Candid, fly-on-the-wall cinematography. Characters are unaware of the camera.";

export const FRAME_PROMPT_STYLE_PREFIX_NO_CHARACTERS = "Cinematic narrative film still.";

export const FRAME_GAZE_WIDE = "Characters are engaged in their environment, not aware of the camera. No one looks at the camera.";

export const FRAME_GAZE_MULTI_DIALOGUE = "Characters look at each other, NOT at the camera. No eye contact with the camera.";

export const FRAME_GAZE_MULTI_NO_DIALOGUE = "Characters look at each other or at their activity, NOT at the camera. No eye contact with the camera.";

export const FRAME_GAZE_SOLO_DIALOGUE = "Character looks slightly off-camera, as if speaking to someone just out of frame. NOT looking at the camera.";

export const FRAME_GAZE_SOLO_NO_DIALOGUE = "Character's gaze is directed at their activity or into the middle distance, NOT at the camera.";

// ---- Analyze story prompt (from analyze-story.ts) ----

export const ANALYZE_STORY_PROMPT_PREFIX = `Analyze the following story and extract:
1. Title
2. Visual art style in 1-2 short phrases only (e.g. 'photorealistic, warm cinematic lighting' or 'dark fantasy illustration, muted earth tones'). Describe rendering style and color palette only — do NOT include mood, atmosphere, narrative tone, or scene-specific details.
3. Characters (name, detailed physical description, personality, age range)
4. Locations (name, visual description with architecture, lighting, colors, atmosphere)
5. Objects (name, visual description — products, props, key items, vehicles, or any notable physical object that appears repeatedly or is important to the story)
6. Scenes (numbered, with title, narrative summary, characters present, location, estimated duration)

For each character, provide vivid physical descriptions that will help generate consistent reference images.
IMPORTANT: If any character in the story is a real person or celebrity, you MUST rename them to an original fictional name that reflects their personality or role in the story. For example, a tech visionary named "Elon Musk" might become "Nova Sparks", a cooking show host named "Gordon Ramsay" might become "Blaze Thornton". NEVER use real people's names — always invent creative fictional names. Also ensure physical descriptions are completely original and do not resemble any real person.
For each location, describe the visual mood, lighting, and key objects.
For each object, describe its shape, color, size, material, and distinguishing visual features. Objects are products, props, vehicles, or key items that appear repeatedly or are important to the story. Only include objects that would benefit from having a consistent reference image.
Estimate scene duration based on action density and dialogue length. Keep durations TIGHT — default to the minimum time needed to cover the dialogue and key actions. A scene with one short exchange and a reaction should be 10-15 seconds, not 30. Scenes with no dialogue and simple action (walking, arriving, looking around) should be 5-10 seconds. Only scenes with substantial dialogue or complex multi-character action should exceed 20 seconds.
Unless the story explicitly specifies an art style, default to "photorealistic" for the visual art style.
In scene narrativeSummary, do NOT include actions by unnamed characters like waiters, servers, or background extras. Only describe actions by the named characters. Instead of 'A waiter pours wine', write 'Wine is poured into their glasses'.

Story:
`;

// ---- Analyze video prompt constants (from analyze-video-pacing.ts) ----

export const ANALYZE_VIDEO_CRITERIA = `Evaluate:
1. How well does the generated video match the intended direction and start frame?
2. Are there visual artifacts, glitches, or quality issues?
3. Do characters/objects match their reference images?
4. Is the pacing appropriate for the content?
5. Are there static/frozen frames or unnecessary repetition?

For each recommendation, provide a structured object with:
- "type": "redo_video" if only the video prompt needs changing, "redo_frame" if the start frame prompt needs changing, "no_change" if the shot is good
- "commentary": explain what you're changing and why
- "suggestedInputs": an object with the COMPLETE REWRITTEN values for any fields you want to change. Only include fields that need changes. Available fields: videoPrompt, dialogue, startFramePrompt, durationSeconds, cameraDirection.`;

export const ANALYZE_VIDEO_ADDITIONAL_CHECKS = `Additional checks:
6. Are there any people visible who are NOT in the reference images? Flag unwanted humans (waiters, background diners, staff, extras).
7. Is there audible music or soundtrack in the video? There should be none — only ambient sounds and dialogue.
8. Do characters look directly at the camera? They should never appear aware of the camera.
9. Do any faces appear mid-shot that were not visible in the start frame? The video model cannot generate correct faces from scratch.

IMPORTANT: When suggesting changes to videoPrompt or startFramePrompt, provide the FULL rewritten prompt, not just a description of what to change.`;

export const ANALYZE_VIDEO_REPLACEMENT_RULES = `CRITICAL RULES FOR REPLACEMENT PROMPTS: When writing suggestedInputs for videoPrompt or startFramePrompt:
- NEVER mention any human figure not in the reference images (no waiters, background diners, staff, extras)
- NEVER mention music, jazz, soundtrack, or any musical element — only non-musical ambient sounds
- NEVER describe a character's face being revealed if it was not visible in the start frame (no turning around, no walking into frame face-first)
- Characters must NEVER look at the camera
- Use visual descriptors ('the man', 'the woman') not character names in videoPrompt`;

export const ANALYZE_VIDEO_RESPONSE_FORMAT = `Return JSON:
{
  "matchScore": <0-100>,
  "issues": ["<specific issue 1>", "<specific issue 2>"],
  "recommendations": [
    {
      "type": "redo_video" | "redo_frame" | "no_change",
      "commentary": "<explanation of the change>",
      "suggestedInputs": {
        "videoPrompt": "<complete rewritten video prompt if changing>",
        "startFramePrompt": "<complete rewritten frame prompt if changing>"
      }
    }
  ]
}`;

// ---- Story to script prompt (from story-to-script.ts) ----

export const STORY_TO_SCRIPT_PROMPT_PREFIX = `You are a screenwriter adapting a story into a visual script. Your job is to convert narration-heavy prose into vivid, filmable scenes.

Rules:
- "Show, don't tell." If the story says "she was nervous," describe her fidgeting, avoiding eye contact, tapping her fingers.
- If the story says "they had been friends for years," show a brief flashback or have dialogue that implies their history.
- Fill out thin scenes with specific visual actions and dialogue, but do NOT pad them. A scene that can be told in 3 beats should not become 6. Add detail to what's there, don't invent filler.
- Add dialogue where the story only summarizes conversations. Make it sound natural and character-appropriate. Keep dialogue TIGHT — real people don't give speeches. Short exchanges, quick back-and-forth.
- PACING IS KING. The script should move fast. Cut transitions, cut throat-clearing, cut "settling in" moments. Start each scene as late as possible (in medias res) and end it as soon as the point is made. If a scene's purpose is "character arrives at location," don't spend 3 paragraphs on them walking up, opening the door, and looking around — start with them already there, already doing the interesting thing.
- Do NOT create scenes where nothing happens. A character "reflecting" or "taking in the view" or "sitting quietly" is not a scene — it's dead air. Either give them dialogue, an action, or a decision to make, or cut it.
- Maintain the story's tone and themes. Don't change the plot.
- Keep it grounded — don't add spectacle or events that weren't implied by the original.
- Write in prose script format (not screenplay format). Describe what we SEE and HEAR.
- Each scene should have a clear visual setting, character actions, and sensory details.
- Preserve all important plot points, characters, and narrative beats from the original.

IMPORTANT: Your only available tool is web search, which you may use to research source material. You have NO ability to save files, export documents, create artifacts, or write to disk. Your entire output IS the script — return the complete prose script as your text response.

Convert the following story into a visual prose script:

`;

// ---- Asset prompt constants (from generate-asset.ts) ----

export const ASSET_EDIT_PROMPT_PREFIX = "Edit this image to show the same location from a different vantage point. Keep the exact same architecture, lighting, color palette, and atmosphere. Location details: ";

export const CHARACTER_ASSET_PROMPT_TEMPLATE = "Studio portrait photography on white background. Four views: front headshot, 3/4 headshot, side profile, full body standing pose. Subject: ";

export const OBJECT_ASSET_PROMPT_TEMPLATE = "an object/product: ";

export const OBJECT_ASSET_PROMPT_SUFFIX = ". Show the object clearly against a neutral background for reference.";

export const LOCATION_ASSET_PROMPT_PREFIX = "a location, no people or figures present: ";