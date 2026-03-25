import type {
  QueueName,
  QueueSnapshot,
  WorkItem,
} from "../stores/pipeline-store";
import QueueItem from "./QueueItem";

interface StatusGroup {
  label: string;
  status: string;
  items: WorkItem[];
}

interface QueueColumnProps {
  name: QueueName;
  snapshot: QueueSnapshot | null;
}

const COLUMN_LABELS: Record<QueueName, string> = {
  llm: "LLM",
  image: "Image",
  video: "Video",
};

export default function QueueColumn({ name, snapshot }: QueueColumnProps) {
  if (!snapshot) {
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-[--border] px-3 py-2">
          <span className="text-sm font-semibold">{COLUMN_LABELS[name]}</span>
          <span className="text-xs text-[--muted]">0</span>
        </div>
      </div>
    );
  }

  const groups: StatusGroup[] = [
    { label: "In Progress", status: "in_progress", items: snapshot.inProgress || [] },
    { label: "Pending", status: "pending", items: snapshot.pending || [] },
    { label: "Completed", status: "completed", items: snapshot.completed || [] },
    { label: "Failed", status: "failed", items: snapshot.failed || [] },
    { label: "Superseded", status: "superseded", items: snapshot.superseded || [] },
    { label: "Cancelled", status: "cancelled", items: snapshot.cancelled || [] },
  ];

  const allItems = groups.flatMap((g) => g.items);
  const doneCount = (snapshot.completed || []).length;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-[--border] px-3 py-2">
        <span className="text-sm font-semibold">{COLUMN_LABELS[name]}</span>
        <span className="text-xs text-[--muted]">
          {doneCount}/{allItems.length}
        </span>
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {groups.map(
          (group) =>
            group.items.length > 0 && (
              <div key={group.status}>
                <div className="mb-1 mt-2 text-xs font-medium text-[--muted] first:mt-0">
                  {group.label} ({group.items.length})
                </div>
                <div className="space-y-1.5">
                  {group.items.map((item) => (
                    <QueueItem key={item.id} item={item} />
                  ))}
                </div>
              </div>
            ),
        )}
      </div>
    </div>
  );
}

