import type { UIMessage } from "ai";
import type { Location, Shot, StoryAnalysis } from "../types.js";

export type ChatScope = "shot" | "location" | "story";

export interface PendingImageReplacement {
  which: "start" | "end";
  path: string;
}

/** Metadata about a sandbox preview artifact that the smart-apply path
 *  can promote into the canonical output instead of regenerating.
 *  - `sandboxPath` is the run-relative path to the preview file.
 *  - `inputsHash` is a sha256 over the merged draft state at the moment the
 *    preview was generated; apply.ts recomputes it and only promotes when
 *    they still match.
 *  Aggressive invalidation: any field-mutation tool clears all
 *  `previewArtifacts` for the draft. */
export interface PreviewArtifact {
  sandboxPath: string;
  createdAt: string;
  inputsHash: string;
}

export interface ShotPreviewArtifacts {
  frame?: PreviewArtifact;
  video?: PreviewArtifact;
}

export interface LocationPreviewArtifacts {
  referenceImage?: PreviewArtifact;
}

export interface ShotDraft {
  shotFields: Partial<Shot>;
  pendingImageReplacements: PendingImageReplacement[];
  previewArtifacts?: ShotPreviewArtifacts;
}

export type LocationFields = Partial<Pick<Location, "visualDescription">>;

export interface PendingReferenceImage {
  path: string;
}

export interface LocationDraft {
  locationFields: LocationFields;
  pendingReferenceImage: PendingReferenceImage | null;
  previewArtifacts?: LocationPreviewArtifacts;
}

export type StoryFields = Partial<Pick<StoryAnalysis, "title" | "artStyle">>;

export interface StoryDraft {
  storyFields: StoryFields;
}

export type ChatDraft = ShotDraft | LocationDraft | StoryDraft;

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

export interface ChatSession {
  scope: ChatScope;
  scopeKey: string;
  runId: string;
  messages: UIMessage[];
  draft: ChatDraft | null;
  intermediates: ChatIntermediate[];
  lastSavedAt: string;
  runStatus: ChatRunStatus;
  lastRunStartedAt: string | null;
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
    runStatus: "idle",
    lastRunStartedAt: null,
  };
}

export function emptyShotDraft(): ShotDraft {
  return { shotFields: {}, pendingImageReplacements: [] };
}

export function emptyLocationDraft(): LocationDraft {
  return { locationFields: {}, pendingReferenceImage: null };
}

export function emptyStoryDraft(): StoryDraft {
  return { storyFields: {} };
}

export function isShotDraft(draft: ChatDraft | null | undefined): draft is ShotDraft {
  return !!draft && "shotFields" in draft;
}

export function isLocationDraft(draft: ChatDraft | null | undefined): draft is LocationDraft {
  return !!draft && "locationFields" in draft;
}

export function isStoryDraft(draft: ChatDraft | null | undefined): draft is StoryDraft {
  return !!draft && "storyFields" in draft;
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

export function isStoryDraftEmpty(draft: StoryDraft | null): boolean {
  if (!draft) return true;
  return Object.keys(draft.storyFields).length === 0;
}

export function isDraftEmpty(draft: ChatDraft | null): boolean {
  if (!draft) return true;
  if (isShotDraft(draft)) return isShotDraftEmpty(draft);
  if (isLocationDraft(draft)) return isLocationDraftEmpty(draft);
  if (isStoryDraft(draft)) return isStoryDraftEmpty(draft);
  return true;
}
