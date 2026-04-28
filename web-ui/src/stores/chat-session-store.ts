import { create } from "zustand";
import type { UIMessage } from "ai";

export type ChatScope = "shot" | "story" | "location";

export interface PendingImageReplacement {
  which: "start" | "end";
  path: string;
}

export interface ShotDraft {
  shotFields: Record<string, unknown>;
  pendingImageReplacements: PendingImageReplacement[];
}

export interface StoryDraft {
  storyFields: Record<string, unknown>;
}

export interface PendingReferenceImage {
  path: string;
}

export interface LocationDraft {
  locationFields: Record<string, unknown>;
  pendingReferenceImage: PendingReferenceImage | null;
}

export type ChatDraft = ShotDraft | StoryDraft | LocationDraft;

export function isShotDraft(draft: ChatDraft | null | undefined): draft is ShotDraft {
  return !!draft && "shotFields" in draft;
}

export function isStoryDraft(draft: ChatDraft | null | undefined): draft is StoryDraft {
  return !!draft && "storyFields" in draft;
}

export function isLocationDraft(draft: ChatDraft | null | undefined): draft is LocationDraft {
  return !!draft && "locationFields" in draft;
}

export function draftFieldCount(draft: ChatDraft | null | undefined): number {
  if (!draft) return 0;
  if (isShotDraft(draft)) {
    return Object.keys(draft.shotFields).length + draft.pendingImageReplacements.length;
  }
  if (isStoryDraft(draft)) {
    return Object.keys(draft.storyFields).length;
  }
  if (isLocationDraft(draft)) {
    return Object.keys(draft.locationFields).length + (draft.pendingReferenceImage ? 1 : 0);
  }
  return 0;
}

export interface ChatIntermediate {
  kind: "frame" | "video" | "asset";
  path: string;
  fromToolCallId: string;
  createdAt: string;
  note?: string;
}

export type ChatRunStatus =
  | "idle"
  | "running"
  | "interrupted"
  | "completed"
  | "cancelled";

export interface ChatSessionData {
  scope: ChatScope;
  scopeKey: string;
  runId: string;
  messages: UIMessage[];
  draft: ChatDraft | null;
  intermediates: ChatIntermediate[];
  lastSavedAt: string;
  runStatus: ChatRunStatus;
  lastRunStartedAt: string | null;
  /** Scope-specific snapshot supplied by the server (e.g. liveShot for shot scope). */
  scopeContext?: Record<string, unknown> | null;
}

function sessionKey(runId: string, scope: ChatScope, scopeKey: string): string {
  return `${runId}::${scope}::${scopeKey}`;
}

/**
 * Build the scope-aware base URL for chat endpoints.
 * - shot: /api/runs/:id/chat/shot/:sceneNumber/:shotInScene (scopeKey is "scene-shot")
 * - story: /api/runs/:id/chat/story/:scopeKey
 */
export function chatBaseUrl(
  runId: string,
  scope: ChatScope,
  scopeKey: string,
): string {
  const prefix = `/api/runs/${encodeURIComponent(runId)}/chat`;
  if (scope === "shot") {
    const [scenePart, shotPart] = scopeKey.split("-");
    return `${prefix}/shot/${scenePart}/${shotPart}`;
  }
  return `${prefix}/${scope}/${encodeURIComponent(scopeKey)}`;
}

interface ChatSessionState {
  sessions: Record<string, ChatSessionData>;
  loading: Record<string, boolean>;
}

interface ChatSessionActions {
  fetchSession: (runId: string, scope: ChatScope, scopeKey: string) => Promise<ChatSessionData | null>;
  setSession: (data: ChatSessionData) => void;
  applyDraft: (runId: string, scope: ChatScope, scopeKey: string) => Promise<{ ok: boolean; error?: string }>;
  discardDraft: (runId: string, scope: ChatScope, scopeKey: string) => Promise<{ ok: boolean; error?: string }>;
  stageDraftFields: (runId: string, scope: ChatScope, scopeKey: string, fields: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
}

export type ChatSessionStore = ChatSessionState & ChatSessionActions;

export const useChatSessionStore = create<ChatSessionStore>((set, get) => ({
  sessions: {},
  loading: {},

  fetchSession: async (runId, scope, scopeKey) => {
    const key = sessionKey(runId, scope, scopeKey);
    set((s) => ({ loading: { ...s.loading, [key]: true } }));
    try {
      const url = chatBaseUrl(runId, scope, scopeKey);
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

  applyDraft: async (runId, scope, scopeKey) => {
    const url = `${chatBaseUrl(runId, scope, scopeKey)}/apply`;
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

  discardDraft: async (runId, scope, scopeKey) => {
    const url = `${chatBaseUrl(runId, scope, scopeKey)}/discard`;
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

  stageDraftFields: async (runId, scope, scopeKey, fields) => {
    const url = `${chatBaseUrl(runId, scope, scopeKey)}/draft`;
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
