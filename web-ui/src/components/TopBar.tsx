import { useEffect, useCallback, useState, useRef } from "react";
import { NavLink, useNavigate } from "react-router";
import { useRunStore, getUrlState } from "../stores/run-store";
import { usePipelineStore } from "../stores/pipeline-store";
import { useUIStore, type ViewName } from "../stores/ui-store";

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

export default function TopBar() {
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
        // Only restore run from URL hash — otherwise show home page
        const hashRunId = urlState.runId;
        if (hashRunId && state.runs.some((r) => r.id === hashRunId)) {
          selectRun(hashRunId);
        }
      }
    });
  }, [loadRuns, selectRun, navigate]);

  const exportRun = useRunStore((s) => s.exportRun);

  const handleDelete = useCallback(async () => {
    if (!activeRunId) return;
    if (!confirm("Delete this project? This cannot be undone.")) return;
    await deleteRun(activeRunId);
    navigate("/");
  }, [activeRunId, deleteRun, navigate]);

  const [showExportMenu, setShowExportMenu] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  // Close export menu on outside click
  useEffect(() => {
    if (!showExportMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showExportMenu]);

  const handleExportZip = useCallback(() => {
    if (activeRunId) exportRun(activeRunId);
    setShowExportMenu(false);
  }, [activeRunId, exportRun]);

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
  const clearActiveRun = useRunStore((s) => s.clearActiveRun);

  const handleGoHome = useCallback(() => {
    const pipeline = usePipelineStore.getState();
    pipeline.disconnectSSE();
    clearActiveRun();
    navigate("/");
  }, [clearActiveRun, navigate]);

  return (
    <header className="top-bar">
      <div className="top-bar-left">
        <h1
          style={{ fontWeight: 700, letterSpacing: "-0.02em", cursor: "pointer" }}
          onClick={handleGoHome}
          title="Home"
        >R<em style={{ fontStyle: "italic" }}>e</em>v<em style={{ fontStyle: "italic" }}>e</em>Movi<em style={{ fontStyle: "italic" }}>e</em>s</h1>
        {activeRunId && (
          <>
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
          </>
        )}
      </div>
      <div className="top-bar-right">
        {activeRunId && (
          <>
            {runStatus && (
              <span className={`run-status-badge ${runStatus}`}>{runStatus}</span>
            )}

            {showPlayPause && (
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

            <div ref={exportMenuRef} style={{ position: "relative", display: "inline-block" }}>
              <button type="button" onClick={() => setShowExportMenu((v) => !v)} title="Export project">
                📦
              </button>
              {showExportMenu && (
                <div
                  style={{
                    position: "absolute",
                    top: "100%",
                    right: 0,
                    marginTop: "0.25rem",
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "0.375rem",
                    boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
                    zIndex: 100,
                    minWidth: "12rem",
                    overflow: "hidden",
                  }}
                >
                  <button
                    type="button"
                    onClick={handleExportZip}
                    style={{
                      display: "block",
                      width: "100%",
                      padding: "0.5rem 0.75rem",
                      background: "none",
                      border: "none",
                      color: "inherit",
                      textAlign: "left",
                      cursor: "pointer",
                      fontSize: "0.85rem",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover, #f5f5f5)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
                  >
                    📦 Download ZIP
                  </button>
                </div>
              )}
            </div>

            <button
              type="button"
              className="delete-run-btn"
              disabled={runStatus === "running"}
              onClick={handleDelete}
              title="Delete project"
            >
              🗑
            </button>

            <span
              className={`sse-dot ${sseStatus}`}
              title={sseStatus === "connected" ? "Connected" : sseStatus === "connecting" ? "Connecting…" : "Disconnected"}
            />
          </>
        )}
      </div>
    </header>
  );
}

