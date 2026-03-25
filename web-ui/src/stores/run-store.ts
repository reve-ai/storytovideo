import { create } from "zustand";
import { usePipelineStore } from "./pipeline-store";

// --- API types ---

export type RunStatus =
  | "running"
  | "pausing"
  | "stopped"
  | "completed"
  | "failed";

export interface RunRecord {
  id: string;
  name?: string;
  storyText: string;
  outputDir: string;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  options: {
    needsConversion?: boolean;
    aspectRatio?: string;
    dryRun?: boolean;
  };
}

// --- Store ---

interface RunState {
  runs: RunRecord[];
  activeRunId: string | null;
  runStatus: RunStatus | null;
  runStartTime: number | null;
}

interface RunActions {
  loadRuns: () => Promise<void>;
  selectRun: (runId: string) => Promise<void>;
  setRunStatus: (status: RunStatus) => void;
  createRun: (
    storyText: string,
    options?: { aspectRatio?: string },
  ) => Promise<RunRecord>;
  deleteRun: (runId: string) => Promise<void>;
  togglePlayPause: () => Promise<void>;
  fetchRunStatus: () => Promise<void>;
  clearActiveRun: () => void;
}

export type RunStore = RunState & RunActions;

export const useRunStore = create<RunStore>((set, get) => ({
  runs: [],
  activeRunId: null,
  runStatus: null,
  runStartTime: null,

  loadRuns: async () => {
    const res = await fetch("/api/runs");
    const data: { runs: RunRecord[] } = await res.json();
    set({ runs: data.runs });
  },

  selectRun: async (runId: string) => {
    set({ activeRunId: runId, runStartTime: null, runStatus: null });

    const pipeline = usePipelineStore.getState();
    pipeline.disconnectSSE();

    await Promise.all([
      pipeline.fetchQueues(runId),
      pipeline.fetchGraph(runId),
      get().fetchRunStatus(),
    ]);

    pipeline.connectSSE(runId);
  },

  setRunStatus: (status: RunStatus) => {
    set({ runStatus: status });
  },

  createRun: async (storyText, options = {}) => {
    const res = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storyText, options }),
    });
    const run: RunRecord = await res.json();
    await get().loadRuns();
    await get().selectRun(run.id);
    return run;
  },

  deleteRun: async (runId: string) => {
    await fetch(`/api/runs/${runId}`, { method: "DELETE" });
    const pipeline = usePipelineStore.getState();
    pipeline.disconnectSSE();
    set({ activeRunId: null, runStatus: null, runStartTime: null });
    await get().loadRuns();
  },

  togglePlayPause: async () => {
    const { activeRunId, runStatus } = get();
    if (!activeRunId) return;

    if (runStatus === "running") {
      await fetch(`/api/runs/${activeRunId}/stop`, { method: "POST" });
    } else if (runStatus === "stopped" || runStatus === "pausing") {
      await fetch(`/api/runs/${activeRunId}/resume`, { method: "POST" });
    }
  },

  fetchRunStatus: async () => {
    const { activeRunId } = get();
    if (!activeRunId) return;
    const res = await fetch(`/api/runs/${activeRunId}`);
    const data: { status: RunStatus } = await res.json();
    set({ runStatus: data.status });
  },

  clearActiveRun: () => {
    set({ activeRunId: null, runStatus: null, runStartTime: null });
  },
}));

