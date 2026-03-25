import type { QueueName } from "../stores/pipeline-store";
import { usePipelineStore } from "../stores/pipeline-store";
import { useRunStore } from "../stores/run-store";
import ProgressBar from "../components/ProgressBar";
import QueueColumn from "../components/QueueColumn";
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

function AssemblySection() {
  const activeRunId = useRunStore((s) => s.activeRunId);
  const runs = useRunStore((s) => s.runs);
  const assemblyItem = useAssemblyItem();

  if (!assemblyItem || !activeRunId) return null;

  const path = (assemblyItem.outputs as Record<string, unknown>).path as string;
  const src = `/api/runs/${activeRunId}/media/${path}`;
  const run = runs.find((r) => r.id === activeRunId);
  const aspectRatio = (run?.options?.aspectRatio || "16:9").replace(":", "/");

  return (
    <div className="border-b border-[--border] bg-[--surface] p-4">
      <h3 className="mb-2 text-sm font-semibold">🎬 Final Assembled Video</h3>
      <div className="mx-auto max-w-xl">
        <VideoThumbnail
          videoSrc={src}
          aspectRatio={aspectRatio}
          className="rounded-lg"
        />
      </div>
    </div>
  );
}

export default function QueueView() {
  const queues = usePipelineStore((s) => s.queues);
  const runStartTime = useRunStore((s) => s.runStartTime);

  return (
    <div className="flex h-full flex-col">
      <ProgressBar queues={queues} runStartTime={runStartTime} />
      <AssemblySection />
      <div className="flex min-h-0 flex-1 divide-x divide-[--border]">
        {QUEUE_NAMES.map((name) => (
          <QueueColumn key={name} name={name} snapshot={queues[name]} />
        ))}
      </div>
    </div>
  );
}

