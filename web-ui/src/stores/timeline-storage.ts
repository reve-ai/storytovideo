import type { EditableTrack, CrossTransitionRef } from "../lib/render-engine";
import type { EditorClip, ProjectSettings } from "./video-editor-store";

export interface TimelineState {
  tracks: EditableTrack[];
  clips: EditorClip[];
  crossTransitions: CrossTransitionRef[];
  settings: ProjectSettings;
}

export interface TimelineStorage {
  load(runId: string): Promise<TimelineState | null>;
  save(runId: string, state: TimelineState): Promise<void>;
}

export class RunTimelineStorage implements TimelineStorage {
  async load(runId: string): Promise<TimelineState | null> {
    try {
      const res = await fetch(`/api/runs/${runId}/timeline`);
      if (res.status === 404) return null;
      if (!res.ok) {
        console.error("[TimelineStorage] load failed:", res.status, await res.text());
        return null;
      }
      return await res.json();
    } catch (err) {
      console.error("[TimelineStorage] load error:", err);
      return null;
    }
  }

  async save(runId: string, state: TimelineState): Promise<void> {
    try {
      const res = await fetch(`/api/runs/${runId}/timeline`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
      });
      if (!res.ok) {
        console.error("[TimelineStorage] save failed:", res.status, await res.text());
      }
    } catch (err) {
      console.error("[TimelineStorage] save error:", err);
    }
  }
}

export const timelineStorage = new RunTimelineStorage();
