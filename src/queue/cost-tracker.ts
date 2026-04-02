/**
 * Cost tracking for model API calls.
 *
 * Tracks LLM token usage, image generation calls, and video generation calls.
 * Prices are per-million tokens for LLMs, per-call for images, per-second for video.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CostEntry {
  /** Work item ID that incurred this cost */
  itemId: string;
  /** Work item key (e.g. "frame:scene:1:shot:2") */
  itemKey: string;
  /** Model identifier */
  model: string;
  /** Category of the call */
  category: 'llm' | 'image' | 'video' | 'audio';
  /** For LLMs: token counts */
  promptTokens?: number;
  completionTokens?: number;
  /** For video: duration in seconds */
  durationSeconds?: number;
  /** Computed cost in USD */
  costUsd: number;
  /** ISO timestamp */
  timestamp: string;
}

export interface CostSummary {
  totalUsd: number;
  byCategory: Record<string, number>;
  byModel: Record<string, number>;
  entryCount: number;
}

// ---------------------------------------------------------------------------
// Price list (USD)
// ---------------------------------------------------------------------------

interface LlmPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

interface PerCallPricing {
  perCall: number;
}

interface PerSecondPricing {
  perSecond: number;
}

type ModelPricing = LlmPricing | PerCallPricing | PerSecondPricing;

const PRICE_LIST: Record<string, ModelPricing> = {
  // LLMs — Anthropic
  'claude-opus-4-6':   { inputPerMillion: 15, outputPerMillion: 75 },
  'claude-sonnet-4-6': { inputPerMillion: 3, outputPerMillion: 15 },
  // LLMs — OpenAI
  'gpt-5.4':       { inputPerMillion: 10, outputPerMillion: 30 },
  'gpt-4.1-mini':  { inputPerMillion: 0.4, outputPerMillion: 1.6 },
  // Gemini
  'gemini-3.1-pro-preview':         { inputPerMillion: 1.25, outputPerMillion: 10 },
  'gemini-3.1-flash-image-preview': { perCall: 0.04 },
  // Image generation
  'grok-imagine-image': { perCall: 0.07 },
  'reve':               { perCall: 0.04 },
  // Video generation
  'grok-imagine-video': { perSecond: 0.10 },
  'veo-3.1-generate-preview': { perSecond: 0.15 },
  'ltx':                { perSecond: 0 },  // self-hosted
  // Audio generation
  'elevenlabs-music':   { perSecond: 0.28 / 60 },  // $0.28/min
};

// ---------------------------------------------------------------------------
// Cost calculation helpers
// ---------------------------------------------------------------------------

export function computeLlmCost(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = PRICE_LIST[model];
  if (!pricing || !('inputPerMillion' in pricing)) return 0;
  return (promptTokens * pricing.inputPerMillion + completionTokens * pricing.outputPerMillion) / 1_000_000;
}

export function computeImageCost(model: string): number {
  const pricing = PRICE_LIST[model];
  if (!pricing || !('perCall' in pricing)) return 0;
  return pricing.perCall;
}

export function computeVideoCost(model: string, durationSeconds: number): number {
  const pricing = PRICE_LIST[model];
  if (!pricing || !('perSecond' in pricing)) return 0;
  return pricing.perSecond * durationSeconds;
}

export function computeAudioCost(model: string, durationSeconds: number): number {
  const pricing = PRICE_LIST[model];
  if (!pricing || !('perSecond' in pricing)) return 0;
  return pricing.perSecond * durationSeconds;
}

// ---------------------------------------------------------------------------
// Summarize cost entries
// ---------------------------------------------------------------------------

export function summarizeCosts(entries: CostEntry[]): CostSummary {
  const byCategory: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  let totalUsd = 0;

  for (const e of entries) {
    totalUsd += e.costUsd;
    byCategory[e.category] = (byCategory[e.category] ?? 0) + e.costUsd;
    byModel[e.model] = (byModel[e.model] ?? 0) + e.costUsd;
  }

  return { totalUsd, byCategory, byModel, entryCount: entries.length };
}

/**
 * Returns the known price list — useful for the frontend to show pricing info.
 */
export function getPriceList(): Record<string, ModelPricing> {
  return { ...PRICE_LIST };
}
