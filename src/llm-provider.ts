import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import type { ProviderName } from './queue/rate-limiter-registry.js';

/**
 * Supported LLM providers for text generation tasks.
 */
export type LlmProvider = 'anthropic' | 'openai';

const MODELS: Record<LlmProvider, Record<'strong' | 'fast', string>> = {
  anthropic: {
    strong: 'claude-opus-4-6',
    fast: 'claude-sonnet-4-20250514',
  },
  openai: {
    strong: 'gpt-5.4',
    fast: 'gpt-4.1-mini',
  },
};

let currentProvider: LlmProvider = 'anthropic';

/**
 * Returns the AI SDK model instance for the requested tier using the current provider.
 */
export function getLlmModel(tier: 'strong' | 'fast' = 'strong') {
  const modelId = MODELS[currentProvider][tier];
  if (currentProvider === 'openai') {
    return openai(modelId);
  }
  return anthropic(modelId);
}

/**
 * Returns the model name string for the requested tier (for logging).
 */
export function getLlmModelName(tier: 'strong' | 'fast' = 'strong'): string {
  return MODELS[currentProvider][tier];
}

/**
 * Returns the current provider name for rate limiter lookup.
 */
export function getLlmProviderName(): ProviderName {
  return currentProvider;
}

/**
 * Returns the current LLM provider.
 */
export function getLlmProvider(): LlmProvider {
  return currentProvider;
}

/**
 * Sets the active LLM provider.
 */
export function setLlmProvider(provider: LlmProvider): void {
  currentProvider = provider;
}

/**
 * Returns provider-specific options for generateObject/generateText calls.
 * Anthropic supports cacheControl; OpenAI does not.
 */
export function getLlmProviderOptions(): Record<string, unknown> | undefined {
  if (currentProvider === 'anthropic') {
    return {
      anthropic: { cacheControl: { type: 'ephemeral' } },
    };
  }
  return undefined;
}
