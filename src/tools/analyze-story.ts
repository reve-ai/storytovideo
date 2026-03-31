import { generateObject } from "ai";
import { z } from "zod";
import type { StoryAnalysis } from "../types";
import { rateLimiters } from "../queue/rate-limiter-registry.js";
import { ANALYZE_STORY_PROMPT_PREFIX } from "../prompts.js";
import { getLlmModel, getLlmProviderName, getLlmProviderOptions } from "../llm-provider.js";

// Zod schema for story analysis (without shots)
const sceneSchema = z.object({
  sceneNumber: z.number(),
  title: z.string(),
  narrativeSummary: z.string(),
  charactersPresent: z.array(z.string()),
  location: z.string(),
  estimatedDurationSeconds: z.number(),
});

const storyAnalysisSchema = z.object({
  title: z.string(),
  artStyle: z.string(),
  characters: z.array(z.object({
    name: z.string(),
    physicalDescription: z.string(),
    personality: z.string(),
    ageRange: z.string(),
  })),
  locations: z.array(z.object({
    name: z.string(),
    visualDescription: z.string(),
  })),
  objects: z.array(z.object({
    name: z.string(),
    visualDescription: z.string(),
  })),
  scenes: z.array(sceneSchema),
});

/**
 * Analyzes a story to extract characters, locations, art style, and scenes.
 * Uses Claude Opus 4.6 with structured output.
 */
export function buildAnalyzeStoryPrompt(storyText: string): string {
  return `${ANALYZE_STORY_PROMPT_PREFIX}${storyText}`;
}

export async function analyzeStory(storyText: string): Promise<StoryAnalysis> {
  const prompt = buildAnalyzeStoryPrompt(storyText);

  const limiter = rateLimiters.get(getLlmProviderName());
  await limiter.acquire();
  try {
    const providerOptions = getLlmProviderOptions();
    const { object } = await generateObject({
      model: getLlmModel('strong'),
      schema: storyAnalysisSchema,
      prompt,
      ...(providerOptions ? { providerOptions } : {}),
    } as any);

    const result = object as any;
    // Default objects to empty array if missing
    if (!result.objects) {
      result.objects = [];
    }
    // Add empty shots arrays (filled by shot planner later)
    if (result.scenes) {
      result.scenes = result.scenes.map((s: any) => ({ ...s, shots: [] }));
    }
    return result as StoryAnalysis;
  } catch (error: any) {
    if (error?.status === 429 || error?.message?.includes('429')) {
      const retryMs = 5000;
      console.warn(`[analyzeStory] 429 rate limited — backing off all ${getLlmProviderName()} workers for ${retryMs}ms`);
      limiter.backoff(retryMs);
    }
    console.error("Error in analyzeStory:", error);
    throw error;
  } finally {
    limiter.release();
  }
}

/**
 * Vercel AI SDK tool definition for analyzeStory.
 * Claude calls this to analyze the story.
 */
export const analyzeStoryTool = {
  description: "Analyze a story to extract characters, locations, art style, and scenes",
  parameters: z.object({
    storyText: z.string(),
  }),
};

