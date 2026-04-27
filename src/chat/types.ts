import type { UIMessage } from "ai";
import type { Shot } from "../types.js";

export type ChatScope = "shot";

export interface PendingImageReplacement {
  which: "start" | "end";
  path: string;
}

export interface ShotDraft {
  shotFields: Partial<Shot>;
  pendingImageReplacements: PendingImageReplacement[];
}

export interface ChatIntermediate {
  kind: "frame" | "video";
  path: string;
  fromToolCallId: string;
  createdAt: string;
  note?: string;
}

export interface ChatSession {
  scope: ChatScope;
  scopeKey: string;
  runId: string;
  messages: UIMessage[];
  draft: ShotDraft | null;
  intermediates: ChatIntermediate[];
  lastSavedAt: string;
}

export function emptyChatSession(runId: string, scope: ChatScope, scopeKey: string): ChatSession {
  return {
    scope,
    scopeKey,
    runId,
    messages: [],
    draft: null,
    intermediates: [],
    lastSavedAt: new Date().toISOString(),
  };
}

export function emptyShotDraft(): ShotDraft {
  return { shotFields: {}, pendingImageReplacements: [] };
}

export function isShotDraftEmpty(draft: ShotDraft | null): boolean {
  if (!draft) return true;
  const noFields = Object.keys(draft.shotFields).length === 0;
  const noImages = draft.pendingImageReplacements.length === 0;
  return noFields && noImages;
}
