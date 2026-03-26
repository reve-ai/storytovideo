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

const COLUMN_CONFIG: Record<QueueName, { label: string; emoji: string; tintVar: string; badgeVar: string; textVar: string }> = {
  llm: { label: "LLM", emoji: "🧠", tintVar: "var(--col-llm-tint)", badgeVar: "var(--col-llm-badge)", textVar: "var(--col-llm-text)" },
  image: { label: "Image", emoji: "🎨", tintVar: "var(--col-image-tint)", badgeVar: "var(--col-image-badge)", textVar: "var(--col-image-text)" },
  video: { label: "Video", emoji: "🎬", tintVar: "var(--col-video-tint)", badgeVar: "var(--col-video-badge)", textVar: "var(--col-video-text)" },
};

export default function QueueColumn({ name, snapshot }: QueueColumnProps) {
  const config = COLUMN_CONFIG[name];

  if (!snapshot) {
    return (
      <div className="flex min-w-0 flex-1 flex-col" style={{ background: config.tintVar }}>
        <div className="flex items-center justify-between border-b border-[--border] px-3 py-2">
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-sm font-semibold"
            style={{ background: config.badgeVar, color: config.textVar }}
          >
            <span>{config.emoji}</span> {config.label}
          </span>
          <span className="text-xs text-[--muted]">0</span>
        </div>
      </div>
    );
  }

  const groups: StatusGroup[] = [
    { label: "In Progress", status: "in_progress", items: snapshot.inProgress || [] },
    { label: "Completed", status: "completed", items: (snapshot.completed || []).slice().sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || '')) },
    { label: "Failed", status: "failed", items: snapshot.failed || [] },
    { label: "Pending", status: "pending", items: (snapshot.pending || []).slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)) },
    { label: "Superseded", status: "superseded", items: snapshot.superseded || [] },
    { label: "Cancelled", status: "cancelled", items: snapshot.cancelled || [] },
  ];

  const activeGroups = groups.filter(
    (g) => g.status !== "superseded" && g.status !== "cancelled",
  );
  const activeItems = activeGroups.flatMap((g) => g.items);
  const doneCount = (snapshot.completed || []).length;

  return (
    <div className="flex min-w-0 flex-1 flex-col" style={{ background: config.tintVar }}>
      <div className="flex items-center justify-between border-b border-[--border] px-3 py-2">
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-sm font-semibold"
          style={{ background: config.badgeVar, color: config.textVar }}
        >
          <span>{config.emoji}</span> {config.label}
        </span>
        <span className="text-xs text-[--muted]">
          {doneCount}/{activeItems.length}
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

