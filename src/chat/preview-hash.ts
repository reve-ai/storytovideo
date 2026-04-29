import { createHash } from "crypto";

import type { Location, Shot } from "../types.js";

/** Deterministic JSON stringify with sorted object keys. Arrays preserve
 *  order; primitives serialize as JSON. Used so the preview-promotion hash
 *  is stable across runs regardless of object-key insertion order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map((k) => {
    const v = (value as Record<string, unknown>)[k];
    return `${JSON.stringify(k)}:${stableStringify(v)}`;
  });
  return `{${parts.join(",")}}`;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Hash of the inputs that drive a frame preview for one shot. */
export function shotFrameInputsHash(opts: {
  artStyle: string;
  shot: Shot;
}): string {
  return sha256Hex(stableStringify({ kind: "frame", artStyle: opts.artStyle, shot: opts.shot }));
}

/** Hash of the inputs that drive a video preview for one shot. */
export function shotVideoInputsHash(opts: {
  artStyle: string;
  shot: Shot;
}): string {
  return sha256Hex(stableStringify({ kind: "video", artStyle: opts.artStyle, shot: opts.shot }));
}

/** Shot fields whose values flow into frame generation. Edits to any of
 *  these invalidate the canonical start frame. apply.ts uses this set to
 *  pick frame-vs-video redo, and `pickVideoStartFrame` uses it to decide
 *  whether previewVideo can reuse the canonical frame as-is. */
export const FRAME_AFFECTING_SHOT_FIELDS: ReadonlyArray<keyof Shot> = [
  "composition",
  "startFramePrompt",
  "endFramePrompt",
  "charactersPresent",
  "objectsPresent",
  "location",
  "continuousFromPrevious",
  "skipped",
];

/** True when `merged` differs from `live` on any frame-affecting field. */
export function shotFrameFieldsDiffer(live: Shot, merged: Shot): boolean {
  for (const key of FRAME_AFFECTING_SHOT_FIELDS) {
    if (JSON.stringify(live[key] ?? null) !== JSON.stringify(merged[key] ?? null)) {
      return true;
    }
  }
  return false;
}

/** Hash of the inputs that drive a reference-image preview for a location. */
export function locationReferenceInputsHash(opts: {
  artStyle: string;
  location: Location;
}): string {
  return sha256Hex(stableStringify({ kind: "referenceImage", artStyle: opts.artStyle, location: opts.location }));
}
