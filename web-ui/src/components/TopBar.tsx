import { useEffect, useCallback, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router";
import { useRunStore, getUrlState } from "../stores/run-store";
import { usePipelineStore } from "../stores/pipeline-store";
import { useUIStore, type ViewName } from "../stores/ui-store";

interface TopBarProps {
  onNewRun: () => void;
}

const VIEW_TABS = [
  { to: "/", label: "Queues", end: true },
  { to: "/script", label: "Script", end: false },
  { to: "/graph", label: "Graph", end: false },
  { to: "/story", label: "Story", end: false },
  { to: "/video", label: "Video", end: false },
  { to: "/timeline", label: "Timeline", end: false },
  { to: "/analyze", label: "Analyze", end: false },
  { to: "/assets", label: "Assets", end: false },
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
  const analyzeCount = usePipelineStore((s) => s.analyzeItems.length);
  const navigate = useNavigate();

  // Load runs on mount, restore state from URL hash
  useEffect(() => {
    const urlState = getUrlState();
    // Restore view from hash
    if (urlState.view) {
      const viewMap: Record<string, { route: string; view: ViewName }> = {
        queue: { route: "/", view: "queue" },
        script: { route: "/script", view: "script" },
        graph: { route: "/graph", view: "graph" },
        story: { route: "/story", view: "story" },
        video: { route: "/video", view: "video" },
        timeline: { route: "/timeline", view: "timeline" },
        analyze: { route: "/analyze", view: "analyze" },
        assets: { route: "/assets", view: "assets" },
      };
      const mapping = viewMap[urlState.view];
      if (mapping) {
        useUIStore.getState().setView(mapping.view);
        navigate(mapping.route);
      }
    }

    loadRuns().then(() => {
      const state = useRunStore.getState();
      if (!state.activeRunId && state.runs.length > 0) {
        // Prefer run ID from URL hash
        const hashRunId = urlState.runId;
        if (hashRunId && state.runs.some((r) => r.id === hashRunId)) {
          selectRun(hashRunId);
        } else {
          const latest = state.runs[state.runs.length - 1];
          selectRun(latest.id);
        }
      }
    });
  }, [loadRuns, selectRun, navigate]);

  const handleRunChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const runId = e.target.value;
      if (runId) selectRun(runId);
    },
    [selectRun],
  );

  const exportRun = useRunStore((s) => s.exportRun);
  const importRun = useRunStore((s) => s.importRun);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!showMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowMenu(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showMenu]);

  const handleDelete = useCallback(async () => {
    if (!activeRunId) return;
    if (!confirm("Delete this project? This cannot be undone.")) return;
    await deleteRun(activeRunId);
    navigate("/");
  }, [activeRunId, deleteRun, navigate]);

  const handleExport = useCallback(() => {
    if (activeRunId) exportRun(activeRunId);
  }, [activeRunId, exportRun]);

  const handleImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await importRun(file);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Import failed");
    }
    // Reset input so the same file can be re-selected
    if (importInputRef.current) importInputRef.current.value = "";
  }, [importRun]);

  const queues = usePipelineStore((s) => s.queues);

  // Check if there's any pending or in-progress work left
  const hasPendingWork = (["llm", "image", "video"] as const).some((qName) => {
    const q = queues[qName];
    return q && ((q.pending?.length ?? 0) > 0 || (q.inProgress?.length ?? 0) > 0);
  });

  const showPlayPause =
    runStatus === "running" ||
    runStatus === "stopped" ||
    runStatus === "stopping";
  const playDisabled = runStatus === "stopped" && !hasPendingWork;
  const activeRun = runs.find((run) => run.id === activeRunId);

  return (
    <header className="top-bar">
      <div className="top-bar-left">
        <h1 style={{ fontWeight: 700, letterSpacing: "-0.02em" }}>R<em style={{ fontStyle: "italic" }}>e</em>v<em style={{ fontStyle: "italic" }}>e</em>Movi<em style={{ fontStyle: "italic" }}>e</em>s</h1>
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
              {label === "Analyze" && analyzeCount > 0 && (
                <span className="tab-badge">{analyzeCount}</span>
              )}
            </NavLink>
          ))}
        </nav>
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            marginTop: "0.5rem",
            fontSize: "0.75rem",
            color: "var(--muted)",
            flexWrap: "wrap",
          }}
        >
          {activeRun && (
            <>
              <span>Assets: {activeRun.options.assetImageBackend ?? activeRun.options.imageBackend ?? "grok"}</span>
              <span>Frames: {activeRun.options.imageBackend ?? "grok"}</span>
              <span>Video: {activeRun.options.videoBackend ?? "grok"}</span>
            </>
          )}
          <span>LLM: {activeRun?.options?.llmProvider ?? "anthropic"}</span>
        </div>
      </div>
      <div className="top-bar-right">
        <select
          value={activeRunId ?? ""}
          onChange={handleRunChange}
          aria-label="Select project"
        >
          <option value="">— select project —</option>
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
            disabled={playDisabled}
            title={
              playDisabled
                ? "Nothing left to process"
                : runStatus === "running"
                  ? "Stop pipeline"
                  : "Resume pipeline"
            }
          >
            {runStatus === "running" ? "⏸" : "▶"}
          </button>
        )}

        <button type="button" onClick={onNewRun} title="New project">
          +
        </button>

        <div className="top-bar-menu-wrapper" ref={menuRef}>
          <button
            type="button"
            onClick={() => setShowMenu((v) => !v)}
            className="top-bar-menu-btn"
            title="More actions"
          >
            ⋯
          </button>
          {showMenu && (
            <div className="top-bar-menu-dropdown" style={{ background: "#0f1117" }}>
              {activeRunId && (
                <button type="button" onClick={() => { handleExport(); setShowMenu(false); }}>
                  📦 Export project
                </button>
              )}
              <button type="button" onClick={() => { importInputRef.current?.click(); setShowMenu(false); }}>
                📥 Import project
              </button>
              {activeRunId && (
                <button
                  type="button"
                  disabled={runStatus === "running"}
                  onClick={() => { handleDelete(); setShowMenu(false); }}
                  className="top-bar-menu-danger"
                >
                  🗑 Delete project
                </button>
              )}
            </div>
          )}
        </div>
        <input
          ref={importInputRef}
          type="file"
          accept=".zip"
          style={{ display: "none" }}
          onChange={handleImport}
        />

        <span
          className={`sse-dot ${sseStatus}`}
          title={sseStatus === "connected" ? "Connected" : sseStatus === "connecting" ? "Connecting…" : "Disconnected"}
        />
      </div>
    </header>
  );
}

