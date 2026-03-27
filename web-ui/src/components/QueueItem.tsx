import type { WorkItem, ItemProgress } from "../stores/pipeline-store";
import { usePipelineStore } from "../stores/pipeline-store";
import { useRunStore } from "../stores/run-store";
import { useUIStore } from "../stores/ui-store";
import VideoThumbnail from "./VideoThumbnail";

function getMediaPath(item: WorkItem): string | null {
  if (!item.outputs) return null;
  const out = item.outputs as Record<string, unknown>;
  if (item.type === "generate_frame") return (out.startPath as string) || null;
  if (item.type === "generate_asset") return (out.path as string) || null;
  if (item.type === "generate_video") return (out.path as string) || null;
  if (item.type === "assemble") return (out.path as string) || null;
  return null;
}

function getItemDescription(item: WorkItem): string | null {
  let desc: string | null = null;
  const inp = item.inputs as Record<string, unknown>;
  if (item.type === "generate_frame")
    desc = (inp.shot as Record<string, unknown>)?.startFramePrompt as string;
  else if (item.type === "generate_video")
    desc = (inp.shot as Record<string, unknown>)?.actionPrompt as string;
  else if (item.type === "generate_asset") desc = inp.description as string;
  else if (item.type === "artifact") {
    const at = inp.artifactType as string;
    if (at === "character") desc = inp.physicalDescription as string;
    else if (at === "location" || at === "object")
      desc = inp.visualDescription as string;
    else if (at === "scene") desc = inp.narrativeSummary as string;
    else if (at === "pacing") desc = inp.artStyle as string;
  }
  if (!desc) return null;
  return desc.length > 80 ? desc.slice(0, 80) + "…" : desc;
}

function getAspectRatio(runs: { id: string; options: { aspectRatio?: string } }[], activeRunId: string | null): string {
  const run = runs.find((r) => r.id === activeRunId);
  return (run?.options?.aspectRatio || "16:9").replace(":", "/");
}

interface QueueItemProps {
  item: WorkItem;
}

const STATUS_BORDER_COLORS: Record<string, string> = {
  in_progress: "var(--accent)",
  completed: "var(--green)",
  failed: "var(--red)",
  pending: "var(--border)",
  superseded: "var(--orange)",
  cancelled: "var(--gray)",
};

export default function QueueItem({ item }: QueueItemProps) {
  const activeRunId = useRunStore((s) => s.activeRunId);
  const runs = useRunStore((s) => s.runs);
  const openDetail = useUIStore((s) => s.openDetail);
  const fetchQueues = usePipelineStore((s) => s.fetchQueues);
  const progress = usePipelineStore((s) => s.itemProgress[item.id]);

  const statusBorderColor = STATUS_BORDER_COLORS[item.status] || "var(--border)";
  const isDimmed = item.status === "superseded" || item.status === "cancelled";

  const typeName =
    item.type === "artifact" &&
    (item.inputs as Record<string, unknown>)?.artifactType
      ? ((item.inputs as Record<string, unknown>).artifactType as string)
      : item.type.replace(/_/g, " ");

  const desc = getItemDescription(item);
  const mediaPath = item.status === "completed" ? getMediaPath(item) : null;
  const mediaSrc =
    mediaPath && activeRunId
      ? `/api/runs/${activeRunId}/media/${mediaPath}`
      : null;

  const isVideo = item.type === "generate_video" || item.type === "assemble";
  const thumbPath =
    item.type === "generate_video"
      ? ((item.inputs as Record<string, unknown>)?.startFramePath as string)
      : null;
  const thumbSrc =
    thumbPath && activeRunId
      ? `/api/runs/${activeRunId}/media/${thumbPath}`
      : undefined;

  const handleAction = async (action: "retry" | "redo" | "cancel") => {
    if (!activeRunId) return;
    try {
      await fetch(`/api/runs/${activeRunId}/items/${item.id}/${action}`, {
        method: "POST",
      });
      await fetchQueues(activeRunId);
    } catch (e) {
      console.error(`${action} failed:`, e);
    }
  };

  const retryBadge =
    item.retryCount > 0 ? (
      <span className="rounded bg-[--orange-dim] px-1.5 py-0.5 text-xs text-[--orange]">
        ↻{item.retryCount}
      </span>
    ) : null;

  const pacingBadge =
    (item.outputs as Record<string, unknown>)?.pacingAdjusted ? (
      <span className="rounded bg-[--accent-dim] px-1.5 py-0.5 text-xs text-[--accent]">
        ⏱ {String((item.outputs as Record<string, unknown>).originalDuration)}s →{" "}
        {String((item.outputs as Record<string, unknown>).newDuration)}s
      </span>
    ) : null;

  return (
    <div
      className="queue-item cursor-pointer rounded-lg border border-[--border] p-3"
      style={{
        borderLeftWidth: "3px",
        borderLeftColor: item.priority === "high" ? "var(--orange)" : statusBorderColor,
        background: "var(--surface)",
        opacity: isDimmed ? 0.6 : 1,
      }}
      data-opens-detail
      onClick={() => openDetail(item.id)}
    >
      {/* Header */}
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium capitalize">{typeName}</span>
        <StatusBadge status={item.status} />
        {item.priority === "high" && (
          <span className="rounded bg-[--orange-dim] px-1.5 py-0.5 text-xs text-[--orange]">
            ⚡ high
          </span>
        )}
        {item.version > 1 && (
          <span className="rounded bg-[--accent-dim] px-1.5 py-0.5 text-xs text-[--accent]">
            v{item.version}
          </span>
        )}
        {retryBadge}
        {pacingBadge}
      </div>

      {/* Item key */}
      <div className="mb-1 truncate text-xs text-[--muted]">{item.itemKey}</div>

      {/* Description */}
      {desc && <div className="mb-2 text-xs text-[--muted]">{desc}</div>}

      {/* LTX progress */}
      {progress && <ProgressIndicator progress={progress} />}

      {/* Media output */}
      {mediaSrc && isVideo && (
        <div className="mb-2">
          <VideoThumbnail
            videoSrc={mediaSrc}
            thumbnailSrc={thumbSrc}
            aspectRatio={getAspectRatio(runs, activeRunId)}
          />
        </div>
      )}
      {mediaSrc && !isVideo && (
        <div className="mb-2">
          <img src={mediaSrc} loading="lazy" className="w-full rounded" />
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-1.5" onClick={(e) => e.stopPropagation()}>
        {item.status === "failed" && (
          <button
            className="rounded bg-[--accent] px-2 py-1 text-xs text-white hover:opacity-80"
            onClick={() => handleAction("retry")}
          >
            ↻ Retry
          </button>
        )}
        {item.status === "completed" && (
          <button
            className="rounded bg-[--accent] px-2 py-1 text-xs text-white hover:opacity-80"
            onClick={() => handleAction("redo")}
          >
            ↻ Redo
          </button>
        )}
        {(item.status === "pending" || item.status === "in_progress") && (
          <button
            className="rounded bg-[--red-dim] px-2 py-1 text-xs text-[--red] hover:opacity-80"
            onClick={() => handleAction("cancel")}
          >
            ✕ Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: "bg-[--surface2] text-[--muted]",
    in_progress: "bg-[--accent-dim] text-[--accent]",
    completed: "bg-[--green-dim] text-[--green]",
    failed: "bg-[--red-dim] text-[--red]",
    superseded: "bg-[--surface2] text-[--muted]",
    cancelled: "bg-[--surface2] text-[--muted]",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs ${colors[status] || ""}`}>
      {status}
    </span>
  );
}

function ProgressIndicator({ progress }: { progress: ItemProgress }) {
  const pct = progress.progress !== undefined ? Math.round(progress.progress * 100) : null;

  let label: string;
  if (progress.status === "pending") {
    label = progress.queuePosition !== undefined
      ? `Queued (position ${progress.queuePosition})`
      : "Queued";
  } else if (pct !== null) {
    const stepStr = progress.step !== undefined && progress.totalSteps !== undefined
      ? ` · step ${progress.step}/${progress.totalSteps}`
      : "";
    label = `Generating ${pct}%${stepStr}`;
  } else {
    label = "Generating…";
  }

  return (
    <div className="mb-2">
      <div className="mb-0.5 text-xs text-[--muted]">{label}</div>
      {pct !== null && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[--surface2]">
          <div
            className="h-full rounded-full bg-[--accent] transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

