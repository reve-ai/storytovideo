import { useEffect, useRef } from "react";
import { useVideoEditorStore } from "../stores/video-editor-store";

// TODO: Replace with server-side persistence (PUT /api/runs/{runId}/timeline)
function saveProject(_projectId: string) {
  const { clips, tracks, crossTransitions, assets, settings } = useVideoEditorStore.getState();
  console.debug("[useAutoSave] Save stubbed — project data:", {
    trackCount: tracks.length,
    clipCount: clips.length,
    crossTransitionCount: crossTransitions.length,
    assetCount: assets.length,
    settings,
  });
  return Promise.resolve();
}

// TODO: Thumbnail generation requires WASM compositor — stubbed for now
async function generateThumbnail(_projectId: string): Promise<void> {
  // No-op: WASM compositor not available in web-ui yet
}

export function useAutoSave(projectId: string) {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thumbTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsubscribe = useVideoEditorStore.subscribe(
      (state) => ({
        clips: state.clips,
        tracks: state.tracks,
        crossTransitions: state.crossTransitions,
        assets: state.assets,
        settings: state.settings,
      }),
      () => {
        // Debounced project save (1s)
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
        timeoutRef.current = setTimeout(() => {
          timeoutRef.current = null;
          void saveProject(projectId);
        }, 1000);

        // Debounced thumbnail generation (5s)
        if (thumbTimeoutRef.current) {
          clearTimeout(thumbTimeoutRef.current);
        }
        thumbTimeoutRef.current = setTimeout(() => {
          thumbTimeoutRef.current = null;
          void generateThumbnail(projectId);
        }, 5000);
      },
      {
        equalityFn: (a, b) =>
          a.clips === b.clips &&
          a.tracks === b.tracks &&
          a.crossTransitions === b.crossTransitions &&
          a.assets === b.assets &&
          a.settings === b.settings,
      },
    );

    return () => {
      unsubscribe();
      // Flush any pending save immediately so changes aren't lost
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
        void saveProject(projectId);
      }
      if (thumbTimeoutRef.current) {
        clearTimeout(thumbTimeoutRef.current);
        thumbTimeoutRef.current = null;
      }
    };
  }, [projectId]);
}
