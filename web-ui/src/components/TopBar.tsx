import { useEffect, useCallback } from "react";
import { NavLink, useNavigate } from "react-router";
import { useRunStore } from "../stores/run-store";
import { usePipelineStore } from "../stores/pipeline-store";

interface TopBarProps {
  onNewRun: () => void;
}

const VIEW_TABS = [
  { to: "/", label: "Queues", end: true },
  { to: "/graph", label: "Graph", end: false },
  { to: "/story", label: "Story", end: false },
] as const;

export default function TopBar({ onNewRun }: TopBarProps) {
  const runs = useRunStore((s) => s.runs);
  const activeRunId = useRunStore((s) => s.activeRunId);
  const runStatus = useRunStore((s) => s.runStatus);
  const loadRuns = useRunStore((s) => s.loadRuns);
  const selectRun = useRunStore((s) => s.selectRun);
  const togglePlayPause = useRunStore((s) => s.togglePlayPause);
  const deleteRun = useRunStore((s) => s.deleteRun);
  const sseStatus = usePipelineStore((s) => s.sseStatus);
  const navigate = useNavigate();

  // Load runs on mount, auto-select latest
  useEffect(() => {
    loadRuns().then(() => {
      const state = useRunStore.getState();
      if (!state.activeRunId && state.runs.length > 0) {
        const latest = state.runs[state.runs.length - 1];
        selectRun(latest.id);
      }
    });
  }, [loadRuns, selectRun]);

  const handleRunChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const runId = e.target.value;
      if (runId) selectRun(runId);
    },
    [selectRun],
  );

  const handleDelete = useCallback(async () => {
    if (!activeRunId) return;
    if (!confirm("Delete this run? This cannot be undone.")) return;
    await deleteRun(activeRunId);
    navigate("/");
  }, [activeRunId, deleteRun, navigate]);

  const showPlayPause =
    runStatus === "running" ||
    runStatus === "stopped" ||
    runStatus === "pausing";

  return (
    <header className="top-bar">
      <div className="top-bar-left">
        <h1>Queue Pipeline</h1>
        <nav className="view-tabs">
          {VIEW_TABS.map(({ to, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `tab${isActive ? " active" : ""}`
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
      </div>
      <div className="top-bar-right">
        <select
          value={activeRunId ?? ""}
          onChange={handleRunChange}
          aria-label="Select run"
        >
          <option value="">— select run —</option>
          {runs.map((run) => (
            <option key={run.id} value={run.id}>
              {run.name || run.id.slice(0, 8)}
            </option>
          ))}
        </select>

        {activeRunId && runStatus && (
          <span className={`run-status-badge ${runStatus}`}>{runStatus}</span>
        )}

        {activeRunId && showPlayPause && (
          <button
            type="button"
            className={`play-pause-btn ${runStatus === "running" ? "running" : "stopped"}`}
            onClick={togglePlayPause}
            title={
              runStatus === "running" ? "Pause pipeline" : "Resume pipeline"
            }
          >
            {runStatus === "running" ? "⏸" : "▶"}
          </button>
        )}

        {activeRunId && (
          <button
            type="button"
            className="delete-run-btn"
            onClick={handleDelete}
            disabled={runStatus === "running"}
            title={
              runStatus === "running"
                ? "Stop the run before deleting"
                : "Delete run"
            }
          >
            🗑
          </button>
        )}

        <button type="button" onClick={onNewRun}>
          + New Run
        </button>

        <span className={`sse-badge ${sseStatus}`}>{sseStatus}</span>
      </div>
    </header>
  );
}

