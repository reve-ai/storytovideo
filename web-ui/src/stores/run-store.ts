import { create } from "zustand";
import { usePipelineStore } from "./pipeline-store";

// --- URL hash helpers ---

export function getUrlState(): { runId: string | null; view: string | null } {
  const params = new URLSearchParams(window.location.hash.slice(1));
  return { runId: params.get("run"), view: params.get("view") };
}

export function setUrlState(runId: string | null, view: string | null): void {
  const params = new URLSearchParams();
  if (runId) params.set("run", runId);
  if (view) params.set("view", view);
  history.replaceState(null, "", "#" + params.toString());
}

// --- API types ---

export type RunStatus =
  | "running"
  | "pausing"
  | "stopped"
  | "completed"
  | "failed";

export type ImageBackend = "grok" | "reve" | "nano-banana";
export type VideoBackend = "grok" | "veo" | "ltx-full" | "ltx-distilled";

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
    imageBackend?: ImageBackend;
    videoBackend?: VideoBackend;
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
  setRunStartTime: (time: number) => void;
  createRun: (
    storyText: string,
    options?: {
      aspectRatio?: string;
      imageBackend?: ImageBackend;
      videoBackend?: VideoBackend;
    },
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
    // Sync URL hash — read current view from hash since ui-store may not be imported here
    const currentHash = getUrlState();
    setUrlState(runId, currentHash.view);

    const pipeline = usePipelineStore.getState();
    pipeline.disconnectSSE();

    await Promise.all([
      pipeline.fetchQueues(runId),
      pipeline.fetchGraph(runId),
      pipeline.fetchAnalyzeItems(runId),
      get().fetchRunStatus(),
    ]);

    pipeline.connectSSE(runId);
  },

  setRunStatus: (status: RunStatus) => {
    set({ runStatus: status });
  },

  setRunStartTime: (time: number) => {
    set({ runStartTime: time });
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
    const currentHash = getUrlState();
    setUrlState(null, currentHash.view);
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

