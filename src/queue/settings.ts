import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { setLlmProvider as setLlmProviderImpl } from "../llm-provider.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LlmProvider = "anthropic" | "openai";

export interface AppSettings {
  llmProvider: LlmProvider;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS: AppSettings = {
  llmProvider: "anthropic",
};

const VALID_LLM_PROVIDERS: readonly LlmProvider[] = ["anthropic", "openai"];

// ---------------------------------------------------------------------------
// Settings file path (same dir as queue-runs.json)
// ---------------------------------------------------------------------------

const SETTINGS_DIR = resolve(process.env.STORYTOVIDEO_RUN_DB_DIR ?? "./output/api-server");
const SETTINGS_PATH = join(SETTINGS_DIR, "settings.json");

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

let currentSettings: AppSettings = { ...DEFAULT_SETTINGS };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Load settings from disk (or use defaults if file missing). */
export function loadSettings(): AppSettings {
  try {
    if (existsSync(SETTINGS_PATH)) {
      const raw = readFileSync(SETTINGS_PATH, "utf-8");
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      currentSettings = mergeSettings(parsed);
    } else {
      currentSettings = { ...DEFAULT_SETTINGS };
    }
  } catch {
    console.warn("[settings] Failed to load settings, using defaults");
    currentSettings = { ...DEFAULT_SETTINGS };
  }
  return { ...currentSettings };
}

/** Get current in-memory settings. */
export function getSettings(): AppSettings {
  return { ...currentSettings };
}

/** Merge a partial update into settings, persist to disk, and apply side-effects. */
export function updateSettings(partial: Partial<AppSettings>): AppSettings {
  currentSettings = mergeSettings({ ...currentSettings, ...partial });
  saveSettingsToDisk();
  applySettings();
  return { ...currentSettings };
}

/**
 * Set the active LLM provider.
 *
 * This updates the module-level state that processors can query via
 * `getLlmProvider()` to decide which model SDK to use.
 */
export function setLlmProvider(provider: LlmProvider): void {
  if (!VALID_LLM_PROVIDERS.includes(provider)) {
    console.warn(`[settings] Unknown LLM provider "${provider}", ignoring`);
    return;
  }
  currentSettings.llmProvider = provider;
  console.log(`[settings] LLM provider set to "${provider}"`);
}

/** Get the currently configured LLM provider. */
export function getLlmProvider(): LlmProvider {
  return currentSettings.llmProvider;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function mergeSettings(partial: Partial<AppSettings>): AppSettings {
  return {
    llmProvider:
      typeof partial.llmProvider === "string" &&
      VALID_LLM_PROVIDERS.includes(partial.llmProvider as LlmProvider)
        ? (partial.llmProvider as LlmProvider)
        : DEFAULT_SETTINGS.llmProvider,
  };
}

function saveSettingsToDisk(): void {
  try {
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify(currentSettings, null, 2) + "\n");
  } catch (err) {
    console.error("[settings] Failed to save settings:", err);
  }
}

function applySettings(): void {
  setLlmProvider(currentSettings.llmProvider);
  setLlmProviderImpl(currentSettings.llmProvider);
}
