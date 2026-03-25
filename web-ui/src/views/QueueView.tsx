import type { QueueName } from "../stores/pipeline-store";
import { usePipelineStore } from "../stores/pipeline-store";
import { useRunStore } from "../stores/run-store";
import ProgressBar from "../components/ProgressBar";
import QueueColumn from "../components/QueueColumn";

const QUEUE_NAMES: QueueName[] = ["llm", "image", "video"];

export default function QueueView() {
  const queues = usePipelineStore((s) => s.queues);
  const runStartTime = useRunStore((s) => s.runStartTime);

  return (
    <div className="flex h-full flex-col">
      <ProgressBar queues={queues} runStartTime={runStartTime} />
      <div className="flex min-h-0 flex-1 divide-x divide-[--border]">
        {QUEUE_NAMES.map((name) => (
          <QueueColumn key={name} name={name} snapshot={queues[name]} />
        ))}
      </div>
    </div>
  );
}

