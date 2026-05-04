import type { UIMessage } from "ai";
import type { Character, Location, Shot, StoryAnalysis, StoryObject } from "../types.js";

export type ChatScope = "shot" | "location" | "story" | "object" | "character";

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

/** Mode of a video preview artifact. `generate` reuses the existing
 *  shotVideoInputsHash semantics; `extend` requires `extendMeta` so apply.ts
 *  can recompute the hash without re-reading the (possibly large) source
 *  video bytes. Older saved drafts have no `mode` field — those are
 *  treated as `generate` for backward compatibility. */
export type ShotVideoPreviewMode = "generate" | "extend";

export interface ShotVideoPreviewArtifact extends PreviewArtifact {
  mode?: ShotVideoPreviewMode;
  extendMeta?: { sourceVideoSha: string; continuationPrompt: string };
}

export interface ShotPreviewArtifacts {
  frame?: PreviewArtifact;
  video?: ShotVideoPreviewArtifact;
}

export interface LocationPreviewArtifacts {
  referenceImage?: PreviewArtifact;
}

export interface ObjectPreviewArtifacts {
  referenceImage?: PreviewArtifact;
}

export interface CharacterPreviewArtifacts {
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

export type ObjectFields = Partial<Pick<StoryObject, "visualDescription">>;

export interface ObjectDraft {
  objectFields: ObjectFields;
  pendingReferenceImage: PendingReferenceImage | null;
  previewArtifacts?: ObjectPreviewArtifacts;
}

export type CharacterFields = Partial<Pick<Character, "physicalDescription" | "personality" | "ageRange">>;

export interface CharacterDraft {
  characterFields: CharacterFields;
  pendingReferenceImage: PendingReferenceImage | null;
  previewArtifacts?: CharacterPreviewArtifacts;
}

export type StoryFields = Partial<Pick<StoryAnalysis, "title" | "artStyle">>;

export interface StoryDraft {
  storyFields: StoryFields;
}

export type ChatDraft = ShotDraft | LocationDraft | ObjectDraft | CharacterDraft | StoryDraft;

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

export function emptyObjectDraft(): ObjectDraft {
  return { objectFields: {}, pendingReferenceImage: null };
}

export function emptyCharacterDraft(): CharacterDraft {
  return { characterFields: {}, pendingReferenceImage: null };
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

export function isObjectDraft(draft: ChatDraft | null | undefined): draft is ObjectDraft {
  return !!draft && "objectFields" in draft;
}

export function isCharacterDraft(draft: ChatDraft | null | undefined): draft is CharacterDraft {
  return !!draft && "characterFields" in draft;
}

export function isStoryDraft(draft: ChatDraft | null | undefined): draft is StoryDraft {
  return !!draft && "storyFields" in draft;
}

export function isShotDraftEmpty(draft: ShotDraft | null): boolean {
  if (!draft) return true;
  const noFields = Object.keys(draft.shotFields).length === 0;
  const noImages = draft.pendingImageReplacements.length === 0;
  const noPreviews = !draft.previewArtifacts?.frame && !draft.previewArtifacts?.video;
  return noFields && noImages && noPreviews;
}

export function isLocationDraftEmpty(draft: LocationDraft | null): boolean {
  if (!draft) return true;
  const noFields = Object.keys(draft.locationFields).length === 0;
  const noImage = !draft.pendingReferenceImage;
  const noPreviews = !draft.previewArtifacts?.referenceImage;
  return noFields && noImage && noPreviews;
}

export function isObjectDraftEmpty(draft: ObjectDraft | null): boolean {
  if (!draft) return true;
  const noFields = Object.keys(draft.objectFields).length === 0;
  const noImage = !draft.pendingReferenceImage;
  const noPreviews = !draft.previewArtifacts?.referenceImage;
  return noFields && noImage && noPreviews;
}

export function isCharacterDraftEmpty(draft: CharacterDraft | null): boolean {
  if (!draft) return true;
  const noFields = Object.keys(draft.characterFields).length === 0;
  const noImage = !draft.pendingReferenceImage;
  const noPreviews = !draft.previewArtifacts?.referenceImage;
  return noFields && noImage && noPreviews;
}

export function isStoryDraftEmpty(draft: StoryDraft | null): boolean {
  if (!draft) return true;
  return Object.keys(draft.storyFields).length === 0;
}

export function isDraftEmpty(draft: ChatDraft | null): boolean {
  if (!draft) return true;
  if (isShotDraft(draft)) return isShotDraftEmpty(draft);
  if (isLocationDraft(draft)) return isLocationDraftEmpty(draft);
  if (isObjectDraft(draft)) return isObjectDraftEmpty(draft);
  if (isCharacterDraft(draft)) return isCharacterDraftEmpty(draft);
  if (isStoryDraft(draft)) return isStoryDraftEmpty(draft);
  return true;
}
