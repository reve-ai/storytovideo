import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

/**
 * Converts a raw story into a fleshed-out visual script using Claude Opus 4.6.
 *
 * Stories are often narration-heavy. This step converts them into prose scripts
 * that "show, don't tell" — turning exposition into visual scenes, action, and
 * dialogue — so the downstream analyzeStory step has richer material to work with.
 */
export async function storyToScript(storyText: string): Promise<string> {
  const prompt = `You are a screenwriter adapting a story into a visual script. Your job is to convert narration-heavy prose into vivid, filmable scenes.

Rules:
- "Show, don't tell." If the story says "she was nervous," describe her fidgeting, avoiding eye contact, tapping her fingers.
- If the story says "they had been friends for years," show a brief flashback or have dialogue that implies their history.
- Expand thin scenes into proper dramatic beats with setting, action, and emotion.
- Add dialogue where the story only summarizes conversations. Make it sound natural and character-appropriate.
- Maintain the story's tone, themes, and pacing. Don't change the plot.
- Keep it grounded — don't add spectacle or events that weren't implied by the original.
- Write in prose script format (not screenplay format). Describe what we SEE and HEAR.
- Each scene should have a clear visual setting, character actions, and sensory details.
- Preserve all important plot points, characters, and narrative beats from the original.

Convert the following story into a visual prose script:

${storyText}`;

  try {
    const { text } = await generateText({
      model: anthropic("claude-opus-4-6"),
      prompt,
      maxTokens: 16384,
    } as any);

    return text;
  } catch (error) {
    console.error("Error in storyToScript:", error);
    throw error;
  }
}

/**
 * Vercel AI SDK tool definition for storyToScript.
 */
export const storyToScriptTool = {
  description: "Convert a raw story into a visual prose script that shows rather than tells, adding dialogue, action, and sensory details",
  parameters: z.object({
    storyText: z.string(),
  }),
};

