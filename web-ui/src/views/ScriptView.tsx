import { useState, useEffect, useCallback } from "react";
import { usePipelineStore, type WorkItem } from "../stores/pipeline-store";
import { useRunStore } from "../stores/run-store";
import { useUIStore } from "../stores/ui-store";

function getAllItems(queues: ReturnType<typeof usePipelineStore.getState>["queues"]): WorkItem[] {
  const items: WorkItem[] = [];
  for (const qName of ["llm", "image", "video"] as const) {
    const q = queues[qName];
    if (!q) continue;
    for (const group of [q.inProgress, q.pending, q.completed, q.failed, q.superseded, q.cancelled]) {
      if (group) items.push(...group);
    }
  }
  return items;
}

export default function ScriptView() {
  const activeRunId = useRunStore((s) => s.activeRunId);
  const scriptData = usePipelineStore((s) => s.scriptData);
  const fetchScript = usePipelineStore((s) => s.fetchScript);
  const updateScript = usePipelineStore((s) => s.updateScript);
  const redoScene = usePipelineStore((s) => s.redoScene);
  const queues = usePipelineStore((s) => s.queues);
  const showToast = useUIStore((s) => s.showToast);

  const [editText, setEditText] = useState("");
  const [saving, setSaving] = useState(false);
  const [redoingScene, setRedoingScene] = useState<number | null>(null);

  useEffect(() => {
    if (activeRunId) fetchScript(activeRunId);
  }, [activeRunId, fetchScript]);

  useEffect(() => {
    if (scriptData) {
      setEditText(scriptData.convertedScript ?? scriptData.storyText);
    }
  }, [scriptData]);

  const originalText = scriptData?.convertedScript ?? scriptData?.storyText ?? "";
  const hasChanges = editText !== originalText;

  const handleSave = useCallback(async () => {
    if (!activeRunId || !hasChanges || saving) return;
    setSaving(true);
    const ok = await updateScript(activeRunId, editText);
    setSaving(false);
    if (ok) {
      showToast("Script saved — re-analysis started", "info");
    } else {
      showToast("Failed to save script", "error");
    }
  }, [activeRunId, editText, hasChanges, saving, updateScript, showToast]);

  const handleRedoScene = useCallback(async (sceneNumber: number) => {
    if (!activeRunId || redoingScene !== null) return;
    const note = window.prompt("Director's note (optional — leave blank to proceed without):");
    if (note === null) return; // user cancelled
    setRedoingScene(sceneNumber);
    const ok = await redoScene(activeRunId, sceneNumber, note || undefined);
    setRedoingScene(null);
    if (ok) {
      showToast(`Scene ${sceneNumber} redo started`, "info");
    } else {
      showToast(`Failed to redo scene ${sceneNumber}`, "error");
    }
  }, [activeRunId, redoingScene, redoScene, showToast]);

  // Check which scenes have active processing items
  const allItems = getAllItems(queues);
  const activeScenes = new Set<number>();
  for (const item of allItems) {
    if (item.status !== "in_progress" && item.status !== "pending") continue;
    if (item.type === "plan_shots" || item.type === "generate_frame" || item.type === "generate_video") {
      const match = item.itemKey.match(/scene:(\d+)/);
      if (match) activeScenes.add(parseInt(match[1], 10));
    }
  }

  if (!activeRunId) {
    return <div style={{ padding: "2rem", color: "var(--muted)" }}>Select a run to view its script.</div>;
  }

  if (!scriptData) {
    return <div style={{ padding: "2rem", color: "var(--muted)" }}>Loading script…</div>;
  }

  return (
    <div style={{ padding: "1rem", maxWidth: "900px", margin: "0 auto" }}>
      <h2 style={{ marginTop: 0 }}>Script</h2>

      {scriptData.convertedScript && (
        <div style={{
          marginBottom: "1rem",
          padding: "0.75rem",
          borderRadius: "6px",
          border: "1px solid var(--border, #444)",
          background: "var(--surface, #f9f9f9)",
        }}>
          <div style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--muted, #888)", marginBottom: "0.35rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Original Prompt
          </div>
          <div style={{ fontSize: "0.85rem", color: "var(--text, #1a1a1a)", whiteSpace: "pre-wrap" }}>
            {scriptData.storyText}
          </div>
        </div>
      )}

      <div style={{ marginBottom: "1rem" }}>
        <textarea
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          rows={16}
          style={{
            width: "100%",
            fontFamily: "monospace",
            fontSize: "0.85rem",
            padding: "0.75rem",
            borderRadius: "6px",
            border: "1px solid var(--border, #444)",
            background: "var(--surface, #f9f9f9)",
            color: "var(--text, #1a1a1a)",
            resize: "vertical",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginTop: "0.5rem" }}>
          <button
            type="button"
            className="primary"
            disabled={!hasChanges || saving}
            onClick={handleSave}
          >
            {saving ? "Saving…" : "Save & Re-analyze"}
          </button>
          {hasChanges && (
            <span style={{ fontSize: "0.8rem", color: "var(--warning, #f0ad4e)" }}>
              ⚠ Saving will re-analyze the story and regenerate all shots
            </span>
          )}
        </div>
      </div>

      {scriptData.scenes.length > 0 && (
        <>
          <h3>Scene Breakdown</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {scriptData.scenes.map((scene) => {
              const isActive = activeScenes.has(scene.sceneNumber);
              return (
                <div
                  key={scene.sceneNumber}
                  style={{
                    border: `1px solid ${isActive ? "var(--accent, #58a6ff)" : "var(--border, #444)"}`,
                    borderRadius: "6px",
                    padding: "0.75rem 1rem",
                    background: "var(--surface, #f9f9f9)",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div>
                      <strong>Scene {scene.sceneNumber}: {scene.title}</strong>
                      {isActive && <span style={{ marginLeft: "0.5rem", fontSize: "0.75rem", color: "var(--accent, #58a6ff)" }}>● processing</span>}
                      <div style={{ fontSize: "0.85rem", color: "var(--muted, #888)", marginTop: "0.25rem" }}>{scene.narrativeSummary}</div>
                      <div style={{ fontSize: "0.8rem", color: "var(--muted, #888)", marginTop: "0.25rem" }}>
                        📍 {scene.location} · 👥 {scene.charactersPresent.join(", ") || "—"}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={redoingScene !== null}
                      onClick={() => handleRedoScene(scene.sceneNumber)}
                      style={{ whiteSpace: "nowrap", flexShrink: 0, marginLeft: "1rem" }}
                    >
                      {redoingScene === scene.sceneNumber ? "Redoing…" : "Redo Scene"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
