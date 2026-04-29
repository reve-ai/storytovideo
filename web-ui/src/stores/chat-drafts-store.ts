import { create } from "zustand";
import type { ChatScope } from "./chat-session-store";

export interface ChatDraftSummary {
  hasFieldEdits: boolean;
  hasPreview: boolean;
  lastSavedAt: string;
}

interface ChatDraftsResponse {
  drafts: Array<{
    scope: ChatScope;
    scopeKey: string;
    hasFieldEdits: boolean;
    hasPreview: boolean;
    lastSavedAt: string;
  }>;
}

function draftKey(scope: ChatScope, scopeKey: string): string {
  return `${scope}::${scopeKey}`;
}

interface ChatDraftsState {
  /** Map keyed by `${scope}::${scopeKey}` of the latest draft summary. */
  drafts: Record<string, ChatDraftSummary>;
  /** Most recent runId we fetched for; used so callers can refresh without re-passing it. */
  lastRunId: string | null;
}

interface ChatDraftsActions {
  fetchDrafts: (runId: string) => Promise<void>;
  /** Selector — true iff the (scope, scopeKey) has a non-null draft (any kind). */
  hasDraft: (scope: ChatScope, scopeKey: string) => boolean;
  /** Drop everything (e.g. when the active run changes). */
  clear: () => void;
}

export type ChatDraftsStore = ChatDraftsState & ChatDraftsActions;

export const useChatDraftsStore = create<ChatDraftsStore>((set, get) => ({
  drafts: {},
  lastRunId: null,

  fetchDrafts: async (runId: string) => {
    if (!runId) return;
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/chat-drafts`);
      if (!res.ok) {
        // 404 means the run is gone — clear so stale badges don't linger.
        if (res.status === 404) set({ drafts: {}, lastRunId: runId });
        return;
      }
      const data = (await res.json()) as ChatDraftsResponse;
      const next: Record<string, ChatDraftSummary> = {};
      for (const row of data.drafts ?? []) {
        next[draftKey(row.scope, row.scopeKey)] = {
          hasFieldEdits: row.hasFieldEdits,
          hasPreview: row.hasPreview,
          lastSavedAt: row.lastSavedAt,
        };
      }
      set({ drafts: next, lastRunId: runId });
    } catch (err) {
      console.error("[chat-drafts] fetch error:", err);
    }
  },

  hasDraft: (scope: ChatScope, scopeKey: string) => {
    const entry = get().drafts[draftKey(scope, scopeKey)];
    if (!entry) return false;
    return entry.hasFieldEdits || entry.hasPreview;
  },

  clear: () => set({ drafts: {}, lastRunId: null }),
}));

/**
 * Hook-friendly selector — call as `useHasDraft("shot", "1-10")`. Re-renders
 * only when the boolean flips.
 */
export function useHasDraft(scope: ChatScope, scopeKey: string | null | undefined): boolean {
  return useChatDraftsStore((s) => {
    if (!scopeKey) return false;
    const entry = s.drafts[draftKey(scope, scopeKey)];
    return Boolean(entry && (entry.hasFieldEdits || entry.hasPreview));
  });
}
