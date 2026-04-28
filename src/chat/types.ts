import type { UIMessage } from "ai";
import type { Location, Shot } from "../types.js";

export type ChatScope = "shot" | "location";

export interface PendingImageReplacement {
  which: "start" | "end";
  path: string;
}

export interface ShotDraft {
  shotFields: Partial<Shot>;
  pendingImageReplacements: PendingImageReplacement[];
}

export type LocationFields = Partial<Pick<Location, "visualDescription">>;

export interface PendingReferenceImage {
  path: string;
}

export interface LocationDraft {
  locationFields: LocationFields;
  pendingReferenceImage: PendingReferenceImage | null;
}

export type ChatDraft = ShotDraft | LocationDraft;

export interface ChatIntermediate {
  kind: "frame" | "video" | "asset";
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
  draft: ChatDraft | null;
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

export function emptyLocationDraft(): LocationDraft {
  return { locationFields: {}, pendingReferenceImage: null };
}

export function isShotDraft(draft: ChatDraft | null | undefined): draft is ShotDraft {
  return !!draft && "shotFields" in draft;
}

export function isLocationDraft(draft: ChatDraft | null | undefined): draft is LocationDraft {
  return !!draft && "locationFields" in draft;
}

export function isShotDraftEmpty(draft: ShotDraft | null): boolean {
  if (!draft) return true;
  const noFields = Object.keys(draft.shotFields).length === 0;
  const noImages = draft.pendingImageReplacements.length === 0;
  return noFields && noImages;
}

export function isLocationDraftEmpty(draft: LocationDraft | null): boolean {
  if (!draft) return true;
  const noFields = Object.keys(draft.locationFields).length === 0;
  const noImage = !draft.pendingReferenceImage;
  return noFields && noImage;
}

export function isDraftEmpty(draft: ChatDraft | null): boolean {
  if (!draft) return true;
  if (isShotDraft(draft)) return isShotDraftEmpty(draft);
  if (isLocationDraft(draft)) return isLocationDraftEmpty(draft);
  return true;
}
