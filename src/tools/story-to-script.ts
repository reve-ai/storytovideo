import { generateText } from "ai";
import { z } from "zod";
import { rateLimiters } from "../queue/rate-limiter-registry.js";
import { STORY_TO_SCRIPT_PROMPT_PREFIX } from "../prompts.js";
import { getLlmModel, getLlmProviderName, getLlmProviderOptions, getWebSearchTools } from "../llm-provider.js";

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

export interface StoryToScriptToolCall {
  toolName: string;
  args?: unknown;
  result?: unknown;
}

export interface StoryToScriptResult {
  text: string;
  usage?: { promptTokens: number; completionTokens: number };
  toolCalls?: StoryToScriptToolCall[];
}

export async function storyToScript(storyText: string): Promise<StoryToScriptResult> {
  const prompt = buildStoryToScriptPrompt(storyText);

  const limiter = rateLimiters.get(getLlmProviderName());
  await limiter.acquire();
  try {
    const providerOptions = getLlmProviderOptions();
    const tools = getWebSearchTools();
    const result = await generateText({
      model: getLlmModel('strong'),
      prompt,
      maxTokens: 16384,
      ...(providerOptions ? { providerOptions } : {}),
      ...(tools ? { tools, maxSteps: 3 } : {}),
    } as any);

    const { text, usage, steps } = result as any;

    // Collect tool calls from all steps
    const allToolCalls: StoryToScriptToolCall[] = [];
    if (steps) {
      for (const step of steps) {
        if (step.toolCalls) {
          for (const tc of step.toolCalls) {
            allToolCalls.push({ toolName: tc.toolName, args: tc.args });
          }
        }
        if (step.toolResults) {
          for (const tr of step.toolResults) {
            const existing = allToolCalls.find(tc => tc.toolName === tr.toolName && !tc.result);
            if (existing) existing.result = tr.result;
          }
        }
      }
    }

    return {
      text,
      usage: usage ? { promptTokens: usage.inputTokens ?? 0, completionTokens: usage.outputTokens ?? 0 } : undefined,
      toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
    };
  } catch (error: any) {
    if (error?.status === 429 || error?.message?.includes('429')) {
      const retryMs = 5000;
      console.warn(`[storyToScript] 429 rate limited — backing off all ${getLlmProviderName()} workers for ${retryMs}ms`);
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

