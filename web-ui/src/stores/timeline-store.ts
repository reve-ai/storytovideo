/**
 * Timeline store — bridges pipeline data to tooscut editor clip format.
 *
 * Reads completed plan_shots / generate_video / generate_frame items from the
 * pipeline store and produces EditorClip[] + EditableTrack[] that the timeline
 * UI can render.
 */
import { create } from "zustand";
import type { EditableTrack, CrossTransitionRef } from "../lib/render-engine";
import { addTrackPair } from "../lib/render-engine";
import type { VideoClip, AudioClip, EditorClip } from "./video-editor-store";
import { usePipelineStore, type WorkItem } from "./pipeline-store";
import { useRunStore } from "./run-store";

// ============================================================================
// Types
// ============================================================================

export type ClipStatus = "pending" | "ready" | "failed";

export interface TimelineClipMeta {
  sceneNumber: number;
  shotInScene: number;
  status: ClipStatus;
  dialogue?: string;
  speaker?: string;
  /** Transition type at the START of this clip's scene (only on first shot of scene) */
  sceneTransition?: "cut" | "fade_black";
}

/** Map from clip ID → pipeline metadata */
type ClipMetaMap = Record<string, TimelineClipMeta>;

// ============================================================================
// Store interface
// ============================================================================

interface TimelineState {
  tracks: EditableTrack[];
  clips: EditorClip[];
  clipMeta: ClipMetaMap;
  crossTransitions: CrossTransitionRef[];
  currentTime: number;
  zoom: number;
  scrollX: number;
  isPlaying: boolean;
  selectedClipIds: string[];
  duration: number;
}

interface TimelineActions {
  populateFromPipeline: (runId: string) => Promise<void>;
  syncFromPipeline: () => void;
  setCurrentTime: (t: number) => void;
  setZoom: (z: number) => void;
  setScrollX: (x: number) => void;
  setIsPlaying: (p: boolean) => void;
  setSelectedClipIds: (ids: string[]) => void;
}

export type TimelineStore = TimelineState & TimelineActions;

// ============================================================================
// Helpers
// ============================================================================

function clipId(sceneNumber: number, shotInScene: number): string {
  return `timeline-s${sceneNumber}-sh${shotInScene}`;
}

function mediaUrl(runId: string, relativePath: string): string {
  return `/api/runs/${runId}/media/${relativePath}`;
}

interface ShotInput {
  sceneNumber?: number;
  shotInScene?: number;
  durationSeconds?: number;
  dialogue?: string;
  speaker?: string;
  transition?: string;
}

function extractShot(item: WorkItem): ShotInput | null {
  const inputs = item.inputs as Record<string, unknown> | undefined;
  if (!inputs) return null;
  const shot = inputs.shot as ShotInput | undefined;
  return shot ?? null;
}

/** Collect completed items of a given type across all queues. */
function completedByType(type: string): WorkItem[] {
  const { queues } = usePipelineStore.getState();
  const items: WorkItem[] = [];
  for (const q of Object.values(queues)) {
    if (!q) continue;
    for (const item of q.completed) {
      if (item.type === type) items.push(item);
    }
  }
  return items;
}

/** Build the default tracks (video + audio pair, plus standalone music track). */
function ensureTracks(existing: EditableTrack[]): EditableTrack[] {
  if (existing.length >= 3) return existing;
  const { tracks } = addTrackPair([], "tl-video-0", "tl-audio-0");
  // Add standalone music track (not paired — uses itself as pairedTrackId)
  const musicTrack: EditableTrack = {
    id: "tl-music-0",
    index: 1,
    type: "audio",
    name: "Music",
    pairedTrackId: "tl-music-0",
    muted: false,
    locked: false,
    volume: 1,
  };
  return [...tracks, musicTrack];
}

function buildTimeline(runId: string) {
  const planShots = completedByType("plan_shots");
  const genVideos = completedByType("generate_video");
  const _genFrames = completedByType("generate_frame");

  // Index generate_video and generate_frame by scene:shot key
  const videoByKey = new Map<string, WorkItem>();
  for (const item of genVideos) {
    const shot = extractShot(item);
    if (shot?.sceneNumber != null && shot?.shotInScene != null) {
      videoByKey.set(`${shot.sceneNumber}:${shot.shotInScene}`, item);
    }
  }
  const frameByKey = new Map<string, WorkItem>();
  for (const item of _genFrames) {
    const shot = extractShot(item);
    if (shot?.sceneNumber != null && shot?.shotInScene != null) {
      frameByKey.set(`${shot.sceneNumber}:${shot.shotInScene}`, item);
    }
  }

  // Collect all shots from plan_shots outputs
  interface PlannedShot {
    sceneNumber: number;
    shotInScene: number;
    durationSeconds: number;
    dialogue?: string;
    speaker?: string;
    transition?: string;
  }

  const allShots: PlannedShot[] = [];
  for (const item of planShots) {
    const outputs = item.outputs as Record<string, unknown> | undefined;
    const inputs = item.inputs as Record<string, unknown> | undefined;
    // plan_shots outputs contain the shots array, or we can fall back to input
    const shotsArr =
      (outputs?.shots as PlannedShot[] | undefined) ??
      (inputs?.shots as PlannedShot[] | undefined);
    if (Array.isArray(shotsArr)) {
      allShots.push(...shotsArr);
    } else {
      // Single shot from input
      const shot = extractShot(item);
      if (shot?.sceneNumber != null && shot?.shotInScene != null) {
        allShots.push({
          sceneNumber: shot.sceneNumber,
          shotInScene: shot.shotInScene,
          durationSeconds: shot.durationSeconds ?? 4,
          dialogue: shot.dialogue,
          speaker: shot.speaker,
          transition: shot.transition,
        });
      }
    }
  }

  // Sort by scene then shot
  allShots.sort((a, b) => a.sceneNumber - b.sceneNumber || a.shotInScene - b.shotInScene);

  // Deduplicate (keep latest)
  const seen = new Set<string>();
  const uniqueShots: PlannedShot[] = [];
  for (let i = allShots.length - 1; i >= 0; i--) {
    const key = `${allShots[i].sceneNumber}:${allShots[i].shotInScene}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueShots.unshift(allShots[i]);
    }
  }

  // Build clips sequentially
  const clips: EditorClip[] = [];
  const meta: ClipMetaMap = {};
  const crossTransitions: CrossTransitionRef[] = [];
  let cursor = 0;
  let prevSceneNumber: number | null = null;
  let prevClipId: string | null = null;

  const videoTrackId = "tl-video-0";
  const audioTrackId = "tl-audio-0";

  for (const shot of uniqueShots) {
    const key = `${shot.sceneNumber}:${shot.shotInScene}`;
    const id = clipId(shot.sceneNumber, shot.shotInScene);
    const videoItem = videoByKey.get(key);
    // Determine duration — use actual if available
    let duration = shot.durationSeconds || 4;
    let status: ClipStatus = "pending";
    let assetId = "";
    if (videoItem) {
      const out = videoItem.outputs as Record<string, unknown>;
      const path = out?.path as string | undefined;
      const actualDuration = out?.durationSeconds as number | undefined;
      if (actualDuration && actualDuration > 0) duration = actualDuration;
      if (path) assetId = mediaUrl(runId, path);
      status = "ready";
    }

    // Scene transition handling
    const isNewScene = prevSceneNumber !== null && shot.sceneNumber !== prevSceneNumber;
    const transitionType = shot.transition === "fade_black" ? "fade_black" : "cut";

    if (isNewScene && transitionType === "fade_black" && prevClipId) {
      const fadeMs = 0.75; // 750ms in seconds
      const ctId = `ct-s${prevSceneNumber}-s${shot.sceneNumber}`;
      crossTransitions.push({
        id: ctId,
        outgoingClipId: prevClipId,
        incomingClipId: id,
        duration: fadeMs,
        type: "Fade",
        boundary: cursor,
        easing: { preset: "EaseInOut" },
      });
    }

    const clipName = `S${shot.sceneNumber} Shot ${shot.shotInScene}`;
    const audioId = `audio-${id}`;

    const clip: VideoClip = {
      id,
      type: "video",
      startTime: cursor,
      duration,
      trackId: videoTrackId,
      inPoint: 0,
      assetId,
      speed: 1,
      transform: {
        x: 960,
        y: 540,
        scale_x: 1,
        scale_y: 1,
        rotation: 0,
        anchor_x: 0.5,
        anchor_y: 0.5,
      },
      name: clipName,
      linkedClipId: audioId,
    };

    const audioClip: AudioClip = {
      id: audioId,
      type: "audio",
      startTime: cursor,
      duration,
      trackId: audioTrackId,
      inPoint: 0,
      assetId,
      speed: 1,
      name: clipName,
      linkedClipId: id,
    };

    clips.push(clip);
    clips.push(audioClip);

    meta[id] = {
      sceneNumber: shot.sceneNumber,
      shotInScene: shot.shotInScene,
      status,
      dialogue: shot.dialogue,
      speaker: shot.speaker,
      ...(isNewScene ? { sceneTransition: transitionType } : {}),
    };

    cursor += duration;
    prevSceneNumber = shot.sceneNumber;
    prevClipId = id;
  }

  const totalDuration = Math.max(30, cursor + 5);

  return { clips, meta, crossTransitions, duration: totalDuration };
}

// ============================================================================
// Store
// ============================================================================

export const useTimelineStore = create<TimelineStore>((set, get) => ({
  tracks: ensureTracks([]),
  clips: [],
  clipMeta: {},
  crossTransitions: [],
  currentTime: 0,
  zoom: 50,
  scrollX: 0,
  isPlaying: false,
  selectedClipIds: [],
  duration: 30,

  populateFromPipeline: async (runId: string) => {
    const { clips, meta, crossTransitions, duration } = buildTimeline(runId);

    // Check if background music file exists before adding music clip
    try {
      const res = await fetch(
        `/api/runs/${encodeURIComponent(runId)}/media/generated-music.mp3`,
        { method: "HEAD" },
      );
      if (res.ok) {
        const musicClip: AudioClip = {
          id: "music-bg",
          type: "audio",
          startTime: 0,
          duration,
          trackId: "tl-music-0",
          inPoint: 0,
          assetId: mediaUrl(runId, "generated-music.mp3"),
          speed: 1,
          name: "Background Music",
          volume: 0.3,
        };
        clips.push(musicClip);
      }
    } catch {
      /* no music file available */
    }

    set({
      tracks: ensureTracks(get().tracks),
      clips,
      clipMeta: meta,
      crossTransitions,
      duration,
    });
  },

  syncFromPipeline: () => {
    const runId = useRunStore.getState().activeRunId;
    if (!runId) return;
    get().populateFromPipeline(runId); // fire-and-forget async
  },

  setCurrentTime: (t) => set({ currentTime: Math.max(0, t) }),
  setZoom: (z) => set({ zoom: Math.max(1, Math.min(500, z)) }),
  setScrollX: (x) => set({ scrollX: Math.max(0, x) }),
  setIsPlaying: (p) => set({ isPlaying: p }),
  setSelectedClipIds: (ids) => set({ selectedClipIds: ids }),
}));
