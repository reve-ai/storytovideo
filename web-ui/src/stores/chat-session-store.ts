import { create } from "zustand";
import type { UIMessage } from "ai";

export type ChatScope = "shot";

export interface PendingImageReplacement {
  which: "start" | "end";
  path: string;
}

export interface ShotDraft {
  shotFields: Record<string, unknown>;
  pendingImageReplacements: PendingImageReplacement[];
}

export interface ChatIntermediate {
  kind: "frame" | "video";
  path: string;
  fromToolCallId: string;
  createdAt: string;
  note?: string;
}

export interface ChatSessionData {
  scope: ChatScope;
  scopeKey: string;
  runId: string;
  messages: UIMessage[];
  draft: ShotDraft | null;
  intermediates: ChatIntermediate[];
  lastSavedAt: string;
  /** Scope-specific snapshot supplied by the server (e.g. liveShot for shot scope). */
  scopeContext?: Record<string, unknown> | null;
}

function sessionKey(runId: string, scope: ChatScope, scopeKey: string): string {
  return `${runId}::${scope}::${scopeKey}`;
}

interface ChatSessionState {
  sessions: Record<string, ChatSessionData>;
  loading: Record<string, boolean>;
}

interface ChatSessionActions {
  fetchSession: (runId: string, scope: ChatScope, scopeKey: string) => Promise<ChatSessionData | null>;
  setSession: (data: ChatSessionData) => void;
  applyDraft: (runId: string, scope: ChatScope, scopeKey: string, sceneNumber: number, shotInScene: number) => Promise<{ ok: boolean; error?: string }>;
  discardDraft: (runId: string, scope: ChatScope, scopeKey: string, sceneNumber: number, shotInScene: number) => Promise<{ ok: boolean; error?: string }>;
  stageDraftFields: (runId: string, scope: ChatScope, scopeKey: string, sceneNumber: number, shotInScene: number, fields: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
}

export type ChatSessionStore = ChatSessionState & ChatSessionActions;

export const useChatSessionStore = create<ChatSessionStore>((set, get) => ({
  sessions: {},
  loading: {},

  fetchSession: async (runId, scope, scopeKey) => {
    const key = sessionKey(runId, scope, scopeKey);
    set((s) => ({ loading: { ...s.loading, [key]: true } }));
    try {
      const [scenePart, shotPart] = scopeKey.split("-");
      const url = `/api/runs/${encodeURIComponent(runId)}/chat/${scope}/${scenePart}/${shotPart}`;
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 404) return null;
        console.error(`[chat-session] fetch failed: ${res.status}`);
        return null;
      }
      const data = (await res.json()) as ChatSessionData;
      set((s) => ({ sessions: { ...s.sessions, [key]: data } }));
      return data;
    } catch (err) {
      console.error("[chat-session] fetch error:", err);
      return null;
    } finally {
      set((s) => ({ loading: { ...s.loading, [key]: false } }));
    }
  },

  setSession: (data) => {
    const key = sessionKey(data.runId, data.scope, data.scopeKey);
    set((s) => ({ sessions: { ...s.sessions, [key]: data } }));
  },

  applyDraft: async (runId, scope, scopeKey, sceneNumber, shotInScene) => {
    const url = `/api/runs/${encodeURIComponent(runId)}/chat/${scope}/${sceneNumber}/${shotInScene}/apply`;
    try {
      const res = await fetch(url, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body?.error ?? `HTTP ${res.status}` };
      // Re-fetch the now-empty session.
      await get().fetchSession(runId, scope, scopeKey);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  discardDraft: async (runId, scope, scopeKey, sceneNumber, shotInScene) => {
    const url = `/api/runs/${encodeURIComponent(runId)}/chat/${scope}/${sceneNumber}/${shotInScene}/discard`;
    try {
      const res = await fetch(url, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body?.error ?? `HTTP ${res.status}` };
      await get().fetchSession(runId, scope, scopeKey);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  stageDraftFields: async (runId, scope, scopeKey, sceneNumber, shotInScene, fields) => {
    const url = `/api/runs/${encodeURIComponent(runId)}/chat/${scope}/${sceneNumber}/${shotInScene}/draft`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body?.error ?? `HTTP ${res.status}` };
      await get().fetchSession(runId, scope, scopeKey);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
}));

export function selectSession(
  state: ChatSessionStore,
  runId: string | null,
  scope: ChatScope,
  scopeKey: string | null,
): ChatSessionData | null {
  if (!runId || !scopeKey) return null;
  return state.sessions[sessionKey(runId, scope, scopeKey)] ?? null;
}
