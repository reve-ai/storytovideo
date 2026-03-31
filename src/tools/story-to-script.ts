import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { rateLimiters } from "../queue/rate-limiter-registry.js";
import { STORY_TO_SCRIPT_PROMPT_PREFIX } from "../prompts.js";

/**
 * Converts a raw story into a fleshed-out visual script using Claude Opus 4.6.
 *
 * Stories are often narration-heavy. This step converts them into prose scripts
 * that "show, don't tell" — turning exposition into visual scenes, action, and
 * dialogue — so the downstream analyzeStory step has richer material to work with.
 */
export function buildStoryToScriptPrompt(storyText: string): string {
  return `${STORY_TO_SCRIPT_PROMPT_PREFIX}${storyText}`;
}

export async function storyToScript(storyText: string): Promise<string> {
  const prompt = buildStoryToScriptPrompt(storyText);

  const limiter = rateLimiters.get('anthropic');
  await limiter.acquire();
  try {
    const { text } = await generateText({
      model: anthropic("claude-opus-4-6"),
      prompt,
      maxTokens: 16384,
      providerOptions: {
        anthropic: { cacheControl: { type: 'ephemeral' } },
      },
    } as any);

    return text;
  } catch (error: any) {
    if (error?.status === 429 || error?.message?.includes('429')) {
      const retryMs = 5000;
      console.warn(`[storyToScript] 429 rate limited — backing off all anthropic workers for ${retryMs}ms`);
      limiter.backoff(retryMs);
    }
    console.error("Error in storyToScript:", error);
    throw error;
  } finally {
    limiter.release();
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

