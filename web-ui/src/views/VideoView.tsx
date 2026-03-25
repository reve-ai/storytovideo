import type { QueueName } from "../stores/pipeline-store";
import { usePipelineStore } from "../stores/pipeline-store";
import { useRunStore } from "../stores/run-store";
import VideoThumbnail from "../components/VideoThumbnail";

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

  if (!assemblyItem || !activeRunId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[--text-muted] text-sm">
          Video will appear here once assembly is complete
        </p>
      </div>
    );
  }

  const path = (assemblyItem.outputs as Record<string, unknown>).path as string;
  const src = `/api/runs/${activeRunId}/media/${path}`;
  const run = runs.find((r) => r.id === activeRunId);
  const aspectRatio = (run?.options?.aspectRatio || "16:9").replace(":", "/");

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-3xl">
        <h3 className="mb-4 text-sm font-semibold">🎬 Final Assembled Video</h3>
        <VideoThumbnail
          videoSrc={src}
          aspectRatio={aspectRatio}
          className="rounded-lg"
        />
      </div>
    </div>
  );
}

