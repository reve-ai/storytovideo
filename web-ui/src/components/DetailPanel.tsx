import { useCallback, useRef, useEffect } from "react";
import { useUIStore } from "../stores/ui-store";
import { usePipelineStore, type WorkItem } from "../stores/pipeline-store";
import { useRunStore } from "../stores/run-store";
import InputForm from "./InputForm";
import ImageUpload from "./ImageUpload";

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString();
}

function getMediaPath(item: WorkItem): string | null {
  if (!item.outputs) return null;
  const o = item.outputs as Record<string, string>;
  if (item.type === "generate_frame") return o.startPath || null;
  if (item.type === "generate_asset") return o.path || null;
  if (item.type === "generate_video") return o.path || null;
  if (item.type === "assemble") return o.path || null;
  return null;
}

function findItem(
  queues: ReturnType<typeof usePipelineStore.getState>["queues"],
  itemId: string,
): WorkItem | null {
  for (const qName of ["llm", "image", "video"] as const) {
    const q = queues[qName];
    if (!q) continue;
    for (const group of [
      q.inProgress,
      q.pending,
      q.completed,
      q.failed,
      q.superseded,
      q.cancelled,
    ]) {
      const found = group.find((i) => i.id === itemId);
      if (found) return found;
    }
  }
  return null;
}

export default function DetailPanel() {
  const { detailPanelOpen, detailItemId, closeDetail } = useUIStore();
  const queues = usePipelineStore((s) => s.queues);
  const fetchQueues = usePipelineStore((s) => s.fetchQueues);
  const fetchGraph = usePipelineStore((s) => s.fetchGraph);
  const activeRunId = useRunStore((s) => s.activeRunId);
  const runs = useRunStore((s) => s.runs);
  const panelRef = useRef<HTMLDivElement>(null);

  const item = detailItemId ? findItem(queues, detailItemId) : null;

  // Click outside to close
  useEffect(() => {
    if (!detailPanelOpen) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (panelRef.current?.contains(target)) return;
      // Don't close when clicking elements that open the detail panel
      if (target.closest("[data-opens-detail]")) return;
      closeDetail();
    }
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [detailPanelOpen, closeDetail]);

  const handleAction = useCallback(
    async (action: string, itemId: string) => {
      if (!activeRunId) return;
      const base = `/api/runs/${activeRunId}/items/${itemId}`;
      try {
        const endpoint =
          action === "retry"
            ? `${base}/retry`
            : action === "redo"
              ? `${base}/redo`
              : action === "cancel"
                ? `${base}/cancel`
                : null;
        if (!endpoint) return;
        const res = await fetch(endpoint, { method: "POST" });
        if (!res.ok) console.error(`${action} failed:`, await res.text());
        await Promise.all([fetchQueues(activeRunId), fetchGraph(activeRunId)]);
        closeDetail();
      } catch (e) {
        console.error(`${action} failed:`, e);
      }
    },
    [activeRunId, fetchQueues, fetchGraph, closeDetail],
  );

  const handleSaveInputs = useCallback(
    async (itemId: string, inputs: Record<string, unknown>) => {
      if (!activeRunId) return;
      const base = `/api/runs/${activeRunId}/items/${itemId}`;
      const itemInQueue = findItem(queues, itemId);
      const status = itemInQueue?.status;
      const isRedo = status === "completed" || status === "failed";

      if (isRedo) {
        const res = await fetch(`${base}/redo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inputs }),
        });
        const data = await res.json();
        await Promise.all([fetchQueues(activeRunId), fetchGraph(activeRunId)]);
        if (data.newItem?.id) {
          useUIStore.getState().openDetail(data.newItem.id);
        } else {
          closeDetail();
        }
      } else {
        await fetch(`${base}/edit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inputs }),
        });
        await Promise.all([fetchQueues(activeRunId), fetchGraph(activeRunId)]);
      }
    },
    [activeRunId, queues, fetchQueues, fetchGraph, closeDetail],
  );

  // Compute aspect ratio from active run
  const aspectRatio = (() => {
    const run = runs.find((r) => r.id === activeRunId);
    return (run?.options?.aspectRatio || "16:9").replace(":", "/");
  })();

  const typeName = item ? item.type.replace(/_/g, " ") : "";
  const editable =
    item?.status === "pending" ||
    item?.status === "completed" ||
    item?.status === "failed";

  return (
    <div
      ref={panelRef}
      className={`detail-panel${detailPanelOpen && item ? " open" : ""}`}
    >
      <button className="close-btn" onClick={closeDetail}>
        ×
      </button>
      {item && (
        <div>
          <DetailHeader item={item} typeName={typeName} />
          <DetailTimestamps item={item} />
          {item.retryCount > 0 && (
            <div className="detail-section">
              <h3>Retries</h3>
              <span className="badge badge-retry">{item.retryCount}/3</span>
            </div>
          )}
          {item.error && (
            <div className="detail-section">
              <h3>Error</h3>
              <pre style={{ color: "var(--red)" }}>{item.error}</pre>
            </div>
          )}
          <div className="detail-section">
            <h3>Inputs</h3>
            <InputForm
              inputs={(item.inputs ?? {}) as Record<string, unknown>}
              itemId={item.id}
              itemStatus={item.status}
              editable={!!editable}
              onSave={handleSaveInputs}
            />
          </div>
          <DetailOutputs
            item={item}
            activeRunId={activeRunId}
            aspectRatio={aspectRatio}
          />
          <DetailActions
            item={item}
            onAction={handleAction}
          />
        </div>
      )}
    </div>
  );
}

// --- Sub-components ---

function DetailHeader({
  item,
  typeName,
}: {
  item: WorkItem;
  typeName: string;
}) {
  const vBadge =
    item.version > 1 ? (
      <span className="badge badge-version">v{item.version}</span>
    ) : null;
  const priBadge =
    item.priority === "high" ? (
      <span className="badge badge-high">⚡ high</span>
    ) : null;
  const pacingInfo =
    (item.outputs as Record<string, unknown>)?.pacingAdjusted ? (
      <span className="badge badge-pacing" style={{ fontSize: "0.85rem" }}>
        ⏱ {String((item.outputs as Record<string, unknown>).originalDuration)}s →{" "}
        {String((item.outputs as Record<string, unknown>).newDuration)}s
      </span>
    ) : null;

  return (
    <>
      <div className="detail-section">
        <h2 style={{ margin: "0 0 0.5rem" }}>
          {typeName} {vBadge} {priBadge}
        </h2>
        <span className={`badge badge-${item.status}`} style={{ fontSize: "0.85rem" }}>
          {item.status}
        </span>
        {pacingInfo}
      </div>
      <div className="detail-section">
        <h3>Item Key</h3>
        <code>{item.itemKey}</code>
      </div>
      <div className="detail-section">
        <h3>Queue</h3>
        <code>{item.queue}</code>
      </div>
    </>
  );
}

function DetailTimestamps({ item }: { item: WorkItem }) {
  return (
    <div className="detail-section">
      <h3>Timestamps</h3>
      <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>
        Created: {fmtTime(item.createdAt)}
        <br />
        Started: {fmtTime(item.startedAt)}
        <br />
        Completed: {fmtTime(item.completedAt)}
      </div>
    </div>
  );
}

function DetailOutputs({
  item,
  activeRunId,
  aspectRatio,
}: {
  item: WorkItem;
  activeRunId: string | null;
  aspectRatio: string;
}) {
  if (!item.outputs || Object.keys(item.outputs).length === 0) return null;

  const mediaPath = getMediaPath(item);
  let mediaEl: React.ReactNode = null;

  if (mediaPath && activeRunId) {
    const src = `/api/runs/${activeRunId}/media/${mediaPath}`;
    if (item.type === "generate_video" || item.type === "assemble") {
      const thumbUrl =
        item.type === "generate_video" &&
        (item.inputs as Record<string, string>)?.startFramePath
          ? `/api/runs/${activeRunId}/media/${(item.inputs as Record<string, string>).startFramePath}`
          : "";
      if (thumbUrl) {
        mediaEl = (
          <video controls style={{ maxWidth: "100%", borderRadius: 6 }}>
            <source src={src} />
          </video>
        );
      } else {
        mediaEl = (
          <video
            controls
            style={{
              maxWidth: "100%",
              borderRadius: 6,
              aspectRatio,
              background: "#000",
            }}
          >
            <source src={src} />
          </video>
        );
      }
    } else {
      const uploadField =
        item.type === "generate_frame" ? "startPath" : item.type === "generate_asset" ? "path" : null;
      mediaEl = (
        <div className="detail-media-wrap">
          <img
            src={src}
            style={{ maxWidth: "100%", borderRadius: 6 }}
            alt="Output"
          />
          {uploadField && (
            <ImageUpload itemId={item.id} field={uploadField} />
          )}
        </div>
      );
    }
  }

  return (
    <div className="detail-section">
      <h3>Outputs</h3>
      {mediaEl}
      <pre>{JSON.stringify(item.outputs, null, 2)}</pre>
    </div>
  );
}

function DetailActions({
  item,
  onAction,
}: {
  item: WorkItem;
  onAction: (action: string, itemId: string) => void;
}) {
  if (item.status === "failed") {
    return (
      <div className="detail-actions">
        <button className="primary" onClick={() => onAction("retry", item.id)}>
          ↻ Retry
        </button>
      </div>
    );
  }
  if (item.status === "completed") {
    return (
      <div className="detail-actions">
        <button className="primary" onClick={() => onAction("redo", item.id)}>
          ↻ Redo
        </button>
      </div>
    );
  }
  if (item.status === "pending" || item.status === "in_progress") {
    return (
      <div className="detail-actions">
        <button className="danger" onClick={() => onAction("cancel", item.id)}>
          ✕ Cancel
        </button>
      </div>
    );
  }
  return null;
}

