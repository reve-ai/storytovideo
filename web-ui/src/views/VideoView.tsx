import { useCallback, useEffect, useState } from "react";
import type { QueueName } from "../stores/pipeline-store";
import { usePipelineStore } from "../stores/pipeline-store";
import { useRunStore } from "../stores/run-store";
import VideoThumbnail from "../components/VideoThumbnail";
import { mediaUrl } from "../utils/media-url";

const QUEUE_NAMES: QueueName[] = ["llm", "image", "video"];

/** Find the completed assembly item across all queues. */
function useAssemblyItem() {
  const queues = usePipelineStore((s) => s.queues);
  for (const qName of QUEUE_NAMES) {
    const q = queues[qName];
    if (!q) continue;
    for (const item of q.completed || []) {
      if (
        item.type === "assemble" &&
        item.outputs &&
        (item.outputs as Record<string, unknown>).path
      ) {
        return item;
      }
    }
  }
  return null;
}

export default function VideoView() {
  const activeRunId = useRunStore((s) => s.activeRunId);
  const runs = useRunStore((s) => s.runs);
  const assemblyItem = useAssemblyItem();

  const [elevenLabsAvailable, setElevenLabsAvailable] = useState(false);
  const [musicLoading, setMusicLoading] = useState(false);
  const [musicError, setMusicError] = useState<string | null>(null);
  const [hasMusicVersion, setHasMusicVersion] = useState(false);
  const [showMusicVersion, setShowMusicVersion] = useState(false);

  // Check capabilities on mount
  useEffect(() => {
    fetch("/api/capabilities")
      .then((r) => r.json())
      .then((data) => setElevenLabsAvailable(data.elevenLabsAvailable ?? false))
      .catch(() => setElevenLabsAvailable(false));
  }, []);

  // Check if final-music.mp4 already exists when assembly is ready
  useEffect(() => {
    if (!activeRunId || !assemblyItem) return;
    const musicSrc = mediaUrl(activeRunId, "final-music.mp4");
    fetch(musicSrc, { method: "HEAD" })
      .then((r) => {
        if (r.ok) {
          setHasMusicVersion(true);
          setShowMusicVersion(true);
        }
      })
      .catch(() => {});
  }, [activeRunId, assemblyItem]);

  const handleAddMusic = useCallback(async () => {
    if (!activeRunId) return;
    setMusicLoading(true);
    setMusicError(null);
    try {
      const resp = await fetch(`/api/runs/${activeRunId}/add-music`, { method: "POST" });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || "Failed to add music");
      }
      setHasMusicVersion(true);
      setShowMusicVersion(true);
    } catch (err) {
      setMusicError(err instanceof Error ? err.message : "Failed to add music");
    } finally {
      setMusicLoading(false);
    }
  }, [activeRunId]);

  if (!assemblyItem || !activeRunId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[--text-muted] text-sm">
          Video will appear here once assembly is complete
        </p>
      </div>
    );
  }

  const originalPath = (assemblyItem.outputs as Record<string, unknown>).path as string;
  const videoFile = showMusicVersion && hasMusicVersion ? "final-music.mp4" : originalPath;
  const src = mediaUrl(activeRunId, videoFile);
  const run = runs.find((r) => r.id === activeRunId);
  const aspectRatio = (run?.options?.aspectRatio || "16:9").replace(":", "/");

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="flex w-full max-w-3xl flex-col items-center max-h-[calc(100vh-8rem)]">
        <h3 className="mb-4 text-sm font-semibold">
          🎬 Final Assembled Video
          {showMusicVersion && hasMusicVersion && (
            <span className="ml-2 text-xs font-normal text-green-400">♪ Music added</span>
          )}
        </h3>
        <VideoThumbnail
          videoSrc={src}
          aspectRatio={aspectRatio}
          className="max-h-[calc(100vh-12rem)] rounded-lg"
        />
        <div className="mt-4 flex items-center gap-3">
          {elevenLabsAvailable && !hasMusicVersion && (
            <button
              onClick={handleAddMusic}
              disabled={musicLoading}
              className="rounded-md bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {musicLoading ? "Generating music…" : "🎵 Add Music"}
            </button>
          )}
          {hasMusicVersion && (
            <button
              onClick={() => setShowMusicVersion((v) => !v)}
              className="rounded-md border border-[--border] px-3 py-1.5 text-xs text-[--text-muted] hover:text-[--text] hover:border-[--text-muted]"
            >
              {showMusicVersion ? "Show Original" : "Show With Music"}
            </button>
          )}
          {musicError && (
            <span className="text-xs text-red-400">{musicError}</span>
          )}
        </div>
      </div>
    </div>
  );
}

