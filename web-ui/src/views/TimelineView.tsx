import { useEffect, useRef } from "react";
import { useRunStore } from "../stores/run-store";
import { useTimelineStore } from "../stores/timeline-store";
import { useVideoEditorStore, type MediaAsset } from "../stores/video-editor-store";
import { usePipelineStore } from "../stores/pipeline-store";
import { timelineStorage } from "../stores/timeline-storage";
import { useAutoSave } from "../hooks/use-auto-save";
import { CanvasTimeline } from "../components/timeline/canvas-timeline";
import { VideoPreview } from "../components/timeline/VideoPreview";

/**
 * Bridge timeline-store data into video-editor-store so CanvasTimeline
 * (which reads from video-editor-store) renders our pipeline clips.
 */
function pushToEditorStore(settings?: { width: number; height: number; fps: number }) {
  const { tracks, clips, crossTransitions } = useTimelineStore.getState();

  // Build assets from clips that have an assetId
  const assets: MediaAsset[] = clips
    .filter((c) => c.type === "video" && (c as { assetId?: string }).assetId)
    .map((c) => {
      const vc = c as { assetId: string; duration: number; name?: string };
      return {
        id: vc.assetId,
        type: "video" as const,
        name: vc.name ?? vc.assetId,
        url: vc.assetId,
        duration: vc.duration,
      };
    });

  useVideoEditorStore.getState().loadProject({
    tracks,
    clips,
    crossTransitions,
    assets,
    settings: settings ?? { width: 1920, height: 1080, fps: 30 },
  });
}

export default function TimelineView() {
  const activeRunId = useRunStore((s) => s.activeRunId);
  const initialized = useRef(false);

  // Wire up auto-save to persist timeline state to the server
  useAutoSave(activeRunId ?? "");

  // Load saved timeline state or populate from pipeline on mount / run change
  useEffect(() => {
    if (!activeRunId) return;
    let cancelled = false;

    (async () => {
      const saved = await timelineStorage.load(activeRunId);
      if (cancelled) return;

      if (saved && saved.tracks.length > 0) {
        // Restore from saved state
        useTimelineStore.setState({
          tracks: saved.tracks,
          clips: saved.clips,
          crossTransitions: saved.crossTransitions,
        });
        pushToEditorStore(saved.settings);
      } else {
        // Fall back to building from pipeline data
        useTimelineStore.getState().populateFromPipeline(activeRunId);
        pushToEditorStore();
      }
      initialized.current = true;
    })();

    return () => { cancelled = true; };
  }, [activeRunId]);

  // Subscribe to pipeline store changes for incremental sync
  useEffect(() => {
    const unsub = usePipelineStore.subscribe(() => {
      if (!initialized.current) return;
      useTimelineStore.getState().syncFromPipeline();
      pushToEditorStore();
    });
    return unsub;
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <VideoPreview />
      <CanvasTimeline />
    </div>
  );
}
