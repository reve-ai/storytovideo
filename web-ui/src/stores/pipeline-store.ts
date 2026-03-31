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

export interface ItemProgress {
  status: "pending" | "running";
  progress?: number;       // 0.0–1.0
  step?: number;
  totalSteps?: number;
  queuePosition?: number;
}

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

export interface AssetEntry {
  name: string;
  description: string;
  imagePath: string | null;
  assetKey: string;
}

export interface AssetsData {
  characters: AssetEntry[];
  locations: AssetEntry[];
  objects: AssetEntry[];
}

// --- Store ---

export interface ScriptScene {
  sceneNumber: number;
  title: string;
  narrativeSummary: string;
  location: string;
  charactersPresent: string[];
}

export interface ScriptData {
  convertedScript: string | null;
  storyText: string;
  scenes: ScriptScene[];
}

interface PipelineState {
  queues: Record<QueueName, QueueSnapshot | null>;
  graph: DependencyGraph | null;
  analyzeItems: WorkItem[];
  assets: AssetsData | null;
  scriptData: ScriptData | null;
  /** Live progress info for in-progress items, keyed by item ID. Cleared when item completes/fails. */
  itemProgress: Record<string, ItemProgress>;
  sseStatus: SSEStatus;
}

interface PipelineActions {
  fetchQueues: (runId: string) => Promise<void>;
  fetchGraph: (runId: string) => Promise<void>;
  fetchAnalyzeItems: (runId: string) => Promise<void>;
  fetchAssets: (runId: string) => Promise<void>;
  fetchScript: (runId: string) => Promise<void>;
  updateScript: (runId: string, script: string) => Promise<boolean>;
  redoScene: (runId: string, sceneNumber: number) => Promise<boolean>;
  acceptAnalyzeItem: (runId: string, itemId: string, inputs?: Record<string, unknown>) => Promise<void>;
  rejectAnalyzeItem: (runId: string, itemId: string) => Promise<void>;
  uploadImage: (runId: string, file: File, itemId?: string, field?: string) => Promise<boolean>;
  replaceAsset: (runId: string, assetKey: string, file: File) => Promise<{ framesRequeued: number } | null>;
  redoAsset: (runId: string, assetKey: string, description?: string) => Promise<boolean>;
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
  assets: null,
  scriptData: null,
  itemProgress: {},
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

  fetchAssets: async (runId: string) => {
    try {
      const res = await fetch(`/api/runs/${runId}`);
      if (!res.ok) return;
      const data = await res.json();
      const state = data.state ?? {};
      const analysis = state.storyAnalysis;
      const outputs: Record<string, string> = state.generatedOutputs ?? {};

      if (!analysis) {
        set({ assets: null });
        return;
      }

      const characters: AssetEntry[] = (analysis.characters ?? []).map(
        (c: { name: string; physicalDescription?: string }) => {
          const key = `character:${c.name}:front`;
          return {
            name: c.name,
            description: c.physicalDescription ?? "",
            imagePath: outputs[key] ?? null,
            assetKey: key,
          };
        },
      );

      const locations: AssetEntry[] = (analysis.locations ?? []).map(
        (l: { name: string; visualDescription?: string }) => {
          const key = `location:${l.name}:front`;
          return {
            name: l.name,
            description: l.visualDescription ?? "",
            imagePath: outputs[key] ?? null,
            assetKey: key,
          };
        },
      );

      const objects: AssetEntry[] = (analysis.objects ?? []).map(
        (o: { name: string; visualDescription?: string }) => {
          const key = `object:${o.name}:front`;
          return {
            name: o.name,
            description: o.visualDescription ?? "",
            imagePath: outputs[key] ?? null,
            assetKey: key,
          };
        },
      );

      set({ assets: { characters, locations, objects } });
    } catch (e) {
      console.error("fetchAssets:", e);
    }
  },

  fetchScript: async (runId: string) => {
    try {
      const res = await fetch(`/api/runs/${runId}/script`);
      if (!res.ok) return;
      const data: ScriptData = await res.json();
      set({ scriptData: data });
    } catch (e) {
      console.error("fetchScript:", e);
    }
  },

  updateScript: async (runId: string, script: string) => {
    try {
      const res = await fetch(`/api/runs/${runId}/script`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script }),
      });
      if (!res.ok) {
        console.error("updateScript failed:", await res.text());
        return false;
      }
      await Promise.all([
        get().fetchQueues(runId),
        get().fetchGraph(runId),
        get().fetchScript(runId),
      ]);
      return true;
    } catch (e) {
      console.error("updateScript:", e);
      return false;
    }
  },

  redoScene: async (runId: string, sceneNumber: number) => {
    try {
      const res = await fetch(`/api/runs/${runId}/scenes/${sceneNumber}/redo`, {
        method: "POST",
      });
      if (!res.ok) {
        console.error("redoScene failed:", await res.text());
        return false;
      }
      await Promise.all([
        get().fetchQueues(runId),
        get().fetchGraph(runId),
      ]);
      return true;
    } catch (e) {
      console.error("redoScene:", e);
      return false;
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

  replaceAsset: async (runId: string, assetKey: string, file: File) => {
    try {
      const params = new URLSearchParams({ assetKey });
      const res = await fetch(`/api/runs/${runId}/assets/replace?${params}`, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!res.ok) {
        console.error("replaceAsset failed:", await res.text());
        return null;
      }
      const data = await res.json();
      await get().fetchQueues(runId);
      await get().fetchGraph(runId);
      return { framesRequeued: data.framesRequeued ?? 0 };
    } catch (e) {
      console.error("replaceAsset:", e);
      return null;
    }
  },

  redoAsset: async (runId: string, assetKey: string, description?: string) => {
    try {
      const res = await fetch(`/api/runs/${runId}/assets/${encodeURIComponent(assetKey)}/redo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(description !== undefined ? { description } : {}),
      });
      if (!res.ok) {
        console.error("redoAsset failed:", await res.text());
        return false;
      }
      await Promise.all([
        get().fetchQueues(runId),
        get().fetchAssets(runId),
      ]);
      return true;
    } catch (e) {
      console.error("redoAsset:", e);
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
        // Clear progress when item finishes
        if (evt === "item_completed" || evt === "item_failed" || evt === "item_cancelled") {
          try {
            const data = JSON.parse(e.data) as { payload?: { itemId?: string } };
            const itemId = data.payload?.itemId;
            if (itemId) {
              set((s) => {
                const next = { ...s.itemProgress };
                delete next[itemId];
                return { itemProgress: next };
              });
            }
          } catch { /* ignore */ }
        }
        if (isAnalyzeEvent(e)) {
          refreshData();
        } else {
          refreshCoreData();
        }
      });
    }

    // LTX progress updates — lightweight, no queue refresh needed
    es.addEventListener("item_progress", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { payload?: { itemId?: string; progress?: ItemProgress } };
        const itemId = data.payload?.itemId;
        const progress = data.payload?.progress;
        if (itemId && progress) {
          set((s) => ({ itemProgress: { ...s.itemProgress, [itemId]: progress } }));
        }
      } catch { /* ignore */ }
    });

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
          payload?: {
            status?: string;
            reason?: string;
            type?: string;
            itemType?: string;
          };
        };
        if (
          data.type === "item_started" ||
          data.type === "item_completed" ||
          data.type === "item_failed" ||
          data.type === "item_redo" ||
          data.type === "item_cancelled" ||
          data.type === "item_retried"
        ) {
          const itemType = data.payload?.type || data.payload?.itemType;
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

