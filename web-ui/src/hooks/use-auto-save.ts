import { useEffect, useRef } from "react";
import { useVideoEditorStore } from "../stores/video-editor-store";
import { timelineStorage } from "../stores/timeline-storage";

function saveProject(runId: string) {
  const { clips, tracks, crossTransitions, settings } = useVideoEditorStore.getState();
  return timelineStorage.save(runId, { tracks, clips, crossTransitions, settings });
}

export function useAutoSave(runId: string) {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsubscribe = useVideoEditorStore.subscribe(
      (state) => ({
        clips: state.clips,
        tracks: state.tracks,
        crossTransitions: state.crossTransitions,
        settings: state.settings,
      }),
      () => {
        // Debounced project save (2s)
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
        timeoutRef.current = setTimeout(() => {
          timeoutRef.current = null;
          void saveProject(runId);
        }, 2000);
      },
      {
        equalityFn: (a, b) =>
          a.clips === b.clips &&
          a.tracks === b.tracks &&
          a.crossTransitions === b.crossTransitions &&
          a.settings === b.settings,
      },
    );

    return () => {
      unsubscribe();
      // Flush any pending save immediately so changes aren't lost
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
        void saveProject(runId);
      }
    };
  }, [runId]);
}
