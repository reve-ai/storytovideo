import { useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router";
import { useRunStore } from "../stores/run-store";

interface HomeViewProps {
  onNewRun: () => void;
}

export default function HomeView({ onNewRun }: HomeViewProps) {
  const runs = useRunStore((s) => s.runs);
  const loadRuns = useRunStore((s) => s.loadRuns);
  const selectRun = useRunStore((s) => s.selectRun);
  const deleteRun = useRunStore((s) => s.deleteRun);
  const exportRun = useRunStore((s) => s.exportRun);
  const importRun = useRunStore((s) => s.importRun);
  const navigate = useNavigate();
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  const handleSelect = useCallback(
    async (runId: string) => {
      await selectRun(runId);
      navigate("/");
    },
    [selectRun, navigate],
  );

  const handleDelete = useCallback(
    async (e: React.MouseEvent, runId: string) => {
      e.stopPropagation();
      if (!confirm("Delete this project? This cannot be undone.")) return;
      await deleteRun(runId);
    },
    [deleteRun],
  );

  const handleExport = useCallback(
    (e: React.MouseEvent, runId: string) => {
      e.stopPropagation();
      exportRun(runId);
    },
    [exportRun],
  );

  const handleImport = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        await importRun(file);
        navigate("/");
      } catch (err) {
        alert(err instanceof Error ? err.message : "Import failed");
      }
      if (importInputRef.current) importInputRef.current.value = "";
    },
    [importRun, navigate],
  );

  return (
    <div className="home-view">
      <div className="home-grid">
        {/* New project card */}
        <div className="home-card home-card-new" onClick={onNewRun}>
          <div className="home-card-thumb home-card-plus">
            <span>+</span>
          </div>
          <div className="home-card-label">New Project</div>
        </div>

        {/* Import project card */}
        <div
          className="home-card home-card-new"
          onClick={() => importInputRef.current?.click()}
        >
          <div className="home-card-thumb home-card-plus">
            <span>📥</span>
          </div>
          <div className="home-card-label">Import Project</div>
          <input
            ref={importInputRef}
            type="file"
            accept=".zip"
            style={{ display: "none" }}
            onChange={handleImport}
          />
        </div>

        {/* Project cards */}
        {runs.map((run) => (
          <div
            key={run.id}
            className="home-card"
            onClick={() => handleSelect(run.id)}
          >
            <div className="home-card-thumb">
              <img
                src={`/api/runs/${run.id}/thumbnail`}
                alt={run.name || run.id.slice(0, 8)}
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                  (e.target as HTMLImageElement).parentElement!.classList.add(
                    "home-card-no-thumb",
                  );
                }}
              />
            </div>
            <div className="home-card-info">
              <div className="home-card-label">
                {run.name || run.id.slice(0, 8)}
              </div>
              {run.status && (
                <span className={`run-status-badge ${run.status}`}>
                  {run.status}
                </span>
              )}
            </div>
            <div className="home-card-actions">
              <button
                type="button"
                title="Export"
                onClick={(e) => handleExport(e, run.id)}
              >
                📦
              </button>
              <button
                type="button"
                title="Delete"
                className="home-card-delete"
                onClick={(e) => handleDelete(e, run.id)}
              >
                🗑
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
