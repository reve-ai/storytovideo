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
  | "analyze_video"
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
  reviewStatus?: string;
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
  analyzeItems: WorkItem[];
  sseStatus: SSEStatus;
}

interface PipelineActions {
  fetchQueues: (runId: string) => Promise<void>;
  fetchGraph: (runId: string) => Promise<void>;
  fetchAnalyzeItems: (runId: string) => Promise<void>;
  acceptAnalyzeItem: (runId: string, itemId: string, inputs?: Record<string, unknown>) => Promise<void>;
  rejectAnalyzeItem: (runId: string, itemId: string) => Promise<void>;
  uploadImage: (runId: string, file: File, itemId?: string, field?: string) => Promise<boolean>;
  enqueueAllAnalysis: (runId: string) => Promise<number>;
  connectSSE: (runId: string) => void;
  disconnectSSE: () => void;
}

export type PipelineStore = PipelineState & PipelineActions;

let eventSource: EventSource | null = null;

export const usePipelineStore = create<PipelineStore>((set, get) => ({
  queues: { llm: null, image: null, video: null },
  graph: null,
  analyzeItems: [],
  sseStatus: "disconnected",

  fetchQueues: async (runId: string) => {
    try {
      const res = await fetch(`/api/runs/${runId}/queues`);
      if (!res.ok) return;
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

  fetchAnalyzeItems: async (runId: string) => {
    try {
      const res = await fetch(`/api/runs/${runId}/analyze`);
      if (!res.ok) return;
      const data: { runId: string; items: WorkItem[] } = await res.json();
      const newItems = data.items;
      const oldItems = get().analyzeItems;

      // Build a map of old items by ID for quick lookup
      const oldMap = new Map(oldItems.map(i => [i.id, i]));

      // Merge: reuse old object references when data hasn't changed
      const merged = newItems.map(newItem => {
        const oldItem = oldMap.get(newItem.id);
        if (oldItem && oldItem.status === newItem.status && oldItem.version === newItem.version) {
          return oldItem; // Same reference — React.memo will skip re-render
        }
        return newItem;
      });

      // Only update state if something actually changed
      const changed = merged.length !== oldItems.length || merged.some((item, i) => item !== oldItems[i]);
      if (changed) {
        set({ analyzeItems: merged });
      }
    } catch (e) {
      console.error("fetchAnalyzeItems:", e);
    }
  },

  acceptAnalyzeItem: async (runId: string, itemId: string, inputs?: Record<string, unknown>) => {
    try {
      await fetch(`/api/runs/${runId}/analyze/${itemId}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(inputs ? { inputs } : {}),
      });
      set({ analyzeItems: get().analyzeItems.filter((i) => i.id !== itemId) });
    } catch (e) {
      console.error("acceptAnalyzeItem:", e);
    }
  },

  rejectAnalyzeItem: async (runId: string, itemId: string) => {
    try {
      await fetch(`/api/runs/${runId}/analyze/${itemId}/reject`, {
        method: "POST",
      });
      set({ analyzeItems: get().analyzeItems.filter((i) => i.id !== itemId) });
    } catch (e) {
      console.error("rejectAnalyzeItem:", e);
    }
  },

  uploadImage: async (runId: string, file: File, itemId?: string, field?: string) => {
    try {
      const params = new URLSearchParams();
      if (itemId) params.set("itemId", itemId);
      if (field) params.set("field", field);
      const res = await fetch(`/api/runs/${runId}/upload?${params}`, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!res.ok) {
        console.error("uploadImage failed:", await res.text());
        return false;
      }
      await get().fetchQueues(runId);
      return true;
    } catch (e) {
      console.error("uploadImage:", e);
      return false;
    }
  },

  enqueueAllAnalysis: async (runId: string) => {
    try {
      const res = await fetch(`/api/runs/${runId}/analyze/enqueue-all`, {
        method: "POST",
      });
      const data: { created: number } = await res.json();
      return data.created;
    } catch (e) {
      console.error("enqueueAllAnalysis:", e);
      return 0;
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

    /** Refresh queues + graph only (does NOT touch analyzeItems). */
    const refreshCoreData = () => {
      const activeRunId = useRunStore.getState().activeRunId;
      if (!activeRunId) return;
      get().fetchQueues(activeRunId);
      get().fetchGraph(activeRunId);
    };

    /** Refresh everything including analyzeItems. */
    const refreshData = () => {
      const activeRunId = useRunStore.getState().activeRunId;
      if (!activeRunId) return;
      refreshCoreData();
      get().fetchAnalyzeItems(activeRunId);
    };

    /** Check whether an SSE event payload is about an analyze_video item. */
    const isAnalyzeEvent = (e: MessageEvent): boolean => {
      try {
        const data = JSON.parse(e.data) as { payload?: { type?: string; itemType?: string } };
        const itemType = data.payload?.type || data.payload?.itemType;
        return itemType === "analyze_video";
      } catch {
        return false;
      }
    };

    // Item lifecycle events — only refresh analyzeItems when the event
    // is about an analyze_video item; otherwise just refresh queues/graph.
    for (const evt of [
      "item_started",
      "item_completed",
      "item_failed",
      "item_retried",
      "item_redo",
      "item_cancelled",
    ]) {
      es.addEventListener(evt, (e: MessageEvent) => {
        if (isAnalyzeEvent(e)) {
          refreshData();
        } else {
          refreshCoreData();
        }
      });
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
      refreshCoreData();
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
      refreshCoreData();
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
          const itemType = data.payload?.type || (data.payload as Record<string, unknown> | undefined)?.itemType;
          if (itemType === "analyze_video") {
            refreshData();
          } else {
            refreshCoreData();
          }
        } else if (data.type === "run_status") {
          if (data.payload?.status) {
            useRunStore
              .getState()
              .setRunStatus(
                data.payload.status as import("./run-store").RunStatus,
              );
          }
          useRunStore.getState().loadRuns();
          refreshCoreData();
        } else if (data.type === "pipeline_paused") {
          useRunStore.getState().setRunStatus("stopped");
          const reason = data.payload?.reason || "Pipeline paused";
          useUIStore.getState().showToast(reason, "warning");
          useRunStore.getState().loadRuns();
          refreshCoreData();
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

