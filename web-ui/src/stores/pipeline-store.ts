import { create } from "zustand";
import { useRunStore } from "./run-store";
import { useUIStore } from "./ui-store";

// --- API types (mirrored from src/queue/types.ts for the web client) ---

export type QueueName = "llm" | "image" | "video";
export type WorkItemStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded";
export type WorkItemType =
  | "story_to_script"
  | "analyze_story"
  | "artifact"
  | "name_run"
  | "plan_shots"
  | "generate_asset"
  | "generate_frame"
  | "generate_video"
  | "assemble";
export type Priority = "normal" | "high";

export interface WorkItem {
  id: string;
  type: WorkItemType;
  queue: QueueName;
  status: WorkItemStatus;
  priority: Priority;
  version: number;
  itemKey: string;
  dependencies: string[];
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  retryCount: number;
  error: string | null;
  supersededBy: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface QueueSnapshot {
  queue: QueueName;
  pending: WorkItem[];
  inProgress: WorkItem[];
  completed: WorkItem[];
  failed: WorkItem[];
  cancelled: WorkItem[];
  superseded: WorkItem[];
}

export interface GraphNode {
  id: string;
  itemKey: string;
  type: WorkItemType;
  status: WorkItemStatus;
  version: number;
  queue: QueueName;
  priority: Priority;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface DependencyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type SSEStatus = "disconnected" | "connecting" | "connected";

// --- Store ---

interface PipelineState {
  queues: Record<QueueName, QueueSnapshot | null>;
  graph: DependencyGraph | null;
  sseStatus: SSEStatus;
}

interface PipelineActions {
  fetchQueues: (runId: string) => Promise<void>;
  fetchGraph: (runId: string) => Promise<void>;
  connectSSE: (runId: string) => void;
  disconnectSSE: () => void;
}

export type PipelineStore = PipelineState & PipelineActions;

let eventSource: EventSource | null = null;

export const usePipelineStore = create<PipelineStore>((set, get) => ({
  queues: { llm: null, image: null, video: null },
  graph: null,
  sseStatus: "disconnected",

  fetchQueues: async (runId: string) => {
    try {
      const res = await fetch(`/api/runs/${runId}/queues`);
      const data: { runId: string; queues: QueueSnapshot[] } =
        await res.json();
      const queues = { ...get().queues };
      for (const q of data.queues) {
        queues[q.queue] = q;
      }
      set({ queues });

      // Compute runStartTime: earliest startedAt across all items
      let earliestStart: number | null = null;
      for (const qName of ["llm", "image", "video"] as QueueName[]) {
        const q = queues[qName];
        if (!q) continue;
        for (const group of [q.inProgress, q.pending, q.completed, q.failed, q.superseded, q.cancelled]) {
          for (const item of group) {
            if (item.startedAt) {
              const t = new Date(item.startedAt).getTime();
              if (earliestStart === null || t < earliestStart) earliestStart = t;
            }
          }
        }
      }
      if (earliestStart !== null) {
        useRunStore.getState().setRunStartTime(earliestStart);
      }
    } catch (e) {
      console.error("fetchQueues:", e);
    }
  },

  fetchGraph: async (runId: string) => {
    try {
      const res = await fetch(`/api/runs/${runId}/graph`);
      const data: { runId: string; graph: DependencyGraph } =
        await res.json();
      set({ graph: data.graph });
    } catch (e) {
      console.error("fetchGraph:", e);
    }
  },

  connectSSE: (runId: string) => {
    get().disconnectSSE();

    const es = new EventSource(`/api/runs/${runId}/events`);
    eventSource = es;
    set({ sseStatus: "connecting" });

    es.onopen = () => {
      set({ sseStatus: "connected" });
    };

    es.onerror = () => {
      set({ sseStatus: "disconnected" });
    };

    const refreshData = () => {
      const activeRunId = useRunStore.getState().activeRunId;
      if (!activeRunId) return;
      get().fetchQueues(activeRunId);
      get().fetchGraph(activeRunId);
    };

    const handleItemEvent = () => {
      refreshData();
    };

    // Item lifecycle events
    for (const evt of [
      "item_started",
      "item_completed",
      "item_failed",
      "item_retried",
      "item_redo",
      "item_cancelled",
    ]) {
      es.addEventListener(evt, handleItemEvent);
    }

    // Run status events
    es.addEventListener("run_status", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as {
          payload?: { status?: string };
        };
        if (data.payload?.status) {
          useRunStore
            .getState()
            .setRunStatus(
              data.payload.status as import("./run-store").RunStatus,
            );
        }
      } catch {
        /* ignore parse errors */
      }
      useRunStore.getState().loadRuns();
      refreshData();
    });

    // Pipeline paused event
    es.addEventListener("pipeline_paused", (e: MessageEvent) => {
      useRunStore.getState().setRunStatus("stopped");
      let reason = "Pipeline paused";
      try {
        const data = JSON.parse(e.data) as { payload?: { reason?: string } };
        if (data.payload?.reason) reason = data.payload.reason;
      } catch { /* ignore */ }
      useUIStore.getState().showToast(reason, "warning");
      useRunStore.getState().loadRuns();
      refreshData();
    });

    // Generic message fallback
    es.onmessage = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as {
          type?: string;
          payload?: { status?: string; reason?: string };
        };
        if (
          data.type === "item_started" ||
          data.type === "item_completed" ||
          data.type === "item_failed" ||
          data.type === "item_redo" ||
          data.type === "item_cancelled" ||
          data.type === "item_retried"
        ) {
          refreshData();
        } else if (data.type === "run_status") {
          if (data.payload?.status) {
            useRunStore
              .getState()
              .setRunStatus(
                data.payload.status as import("./run-store").RunStatus,
              );
          }
          useRunStore.getState().loadRuns();
          refreshData();
        } else if (data.type === "pipeline_paused") {
          useRunStore.getState().setRunStatus("stopped");
          const reason = data.payload?.reason || "Pipeline paused";
          useUIStore.getState().showToast(reason, "warning");
          useRunStore.getState().loadRuns();
          refreshData();
        }
      } catch {
        /* ignore parse errors */
      }
    };
  },

  disconnectSSE: () => {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    set({ sseStatus: "disconnected" });
  },
}));

