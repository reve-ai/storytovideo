import { useEffect, useRef } from "react";
import { useRunStore } from "../stores/run-store";
import { useTimelineStore } from "../stores/timeline-store";
import { useVideoEditorStore, type MediaAsset } from "../stores/video-editor-store";
import { usePipelineStore } from "../stores/pipeline-store";
import { CanvasTimeline } from "../components/timeline/canvas-timeline";

/**
 * Bridge timeline-store data into video-editor-store so CanvasTimeline
 * (which reads from video-editor-store) renders our pipeline clips.
 */
function pushToEditorStore() {
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
    settings: { width: 1920, height: 1080, fps: 30 },
  });
}

export default function TimelineView() {
  const activeRunId = useRunStore((s) => s.activeRunId);
  const initialized = useRef(false);

  // Populate timeline from pipeline on mount / run change
  useEffect(() => {
    if (!activeRunId) return;
    useTimelineStore.getState().populateFromPipeline(activeRunId);
    pushToEditorStore();
    initialized.current = true;
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
      <CanvasTimeline />
    </div>
  );
}
