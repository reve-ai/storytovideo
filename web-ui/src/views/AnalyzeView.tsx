import { useCallback, useState } from "react";
import { usePipelineStore, type WorkItem } from "../stores/pipeline-store";
import { useRunStore } from "../stores/run-store";

export default function AnalyzeView() {
  const activeRunId = useRunStore((s) => s.activeRunId);
  const runs = useRunStore((s) => s.runs);
  const analyzeItems = usePipelineStore((s) => s.analyzeItems);
  const acceptItem = usePipelineStore((s) => s.acceptAnalyzeItem);
  const rejectItem = usePipelineStore((s) => s.rejectAnalyzeItem);

  const run = runs.find((r) => r.id === activeRunId);
  const aspectRatio = (run?.options?.aspectRatio || "16:9").replace(":", "/");

  const sorted = [...analyzeItems].sort(
    (a, b) => (a.inputs.shotNumber as number) - (b.inputs.shotNumber as number),
  );

  if (!activeRunId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[--text-muted] text-sm">Select a run to review</p>
      </div>
    );
  }

  if (sorted.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[--muted] text-sm">No videos pending review</p>
      </div>
    );
  }

  return (
    <div className="analyze-view">
      {sorted.map((item) => (
        <AnalyzeCard
          key={item.id}
          item={item}
          runId={activeRunId}
          aspectRatio={aspectRatio}
          onAccept={acceptItem}
          onReject={rejectItem}
        />
      ))}
    </div>
  );
}

interface AnalyzeCardProps {
  item: WorkItem;
  runId: string;
  aspectRatio: string;
  onAccept: (runId: string, itemId: string, inputs?: Record<string, unknown>) => Promise<void>;
  onReject: (runId: string, itemId: string) => Promise<void>;
}

function AnalyzeCard({ item, runId, aspectRatio, onAccept, onReject }: AnalyzeCardProps) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const shotNumber = item.inputs.shotNumber as number;
  const shot = item.inputs.shot as Record<string, unknown> | undefined;
  const videoPath = item.inputs.videoPath as string | undefined;
  const startFramePath = item.inputs.startFramePath as string | undefined;

  const analysis = item.outputs as Record<string, unknown>;
  const matchScore = analysis.matchScore as number | undefined;
  const issues = (analysis.issues ?? []) as string[];
  const recommendations = (analysis.recommendations ?? []) as string[];

  const videoSrc = videoPath ? `/api/runs/${runId}/media/${videoPath}` : null;
  const frameSrc = startFramePath ? `/api/runs/${runId}/media/${startFramePath}` : null;

  const composition = shot?.composition as string | undefined;
  const durationSeconds = shot?.durationSeconds as number | undefined;
  const actionPrompt = shot?.actionPrompt as string | undefined;
  const dialogue = shot?.dialogue as string | undefined;

  const handleAccept = useCallback(async () => {
    setBusy(true);
    await onAccept(runId, item.id);
    setBusy(false);
  }, [runId, item.id, onAccept]);

  const handleReject = useCallback(async () => {
    setBusy(true);
    await onReject(runId, item.id);
    setBusy(false);
  }, [runId, item.id, onReject]);

  const handleEditAccept = useCallback(async () => {
    setBusy(true);
    await onAccept(runId, item.id);
    setBusy(false);
    setEditing(false);
  }, [runId, item.id, onAccept]);

  const scoreColor =
    matchScore != null
      ? matchScore >= 70
        ? "var(--green)"
        : matchScore >= 40
          ? "var(--orange)"
          : "var(--red)"
      : "var(--muted)";

  return (
    <div className="analyze-card">
      <div className="analyze-card-media">
        {videoSrc ? (
          <video
            src={videoSrc}
            controls
            className="analyze-video"
            style={{ aspectRatio }}
          />
        ) : frameSrc ? (
          <img src={frameSrc} alt={`Shot ${shotNumber}`} style={{ aspectRatio }} />
        ) : (
          <div className="analyze-placeholder" style={{ aspectRatio }}>
            No media
          </div>
        )}
      </div>

      <div className="analyze-card-body">
        <div className="analyze-card-header">
          <span className="story-shot-number">Shot {shotNumber}</span>
          {composition && <span className="story-shot-comp">{composition}</span>}
          {durationSeconds != null && <span className="story-shot-duration">{durationSeconds}s</span>}
          {matchScore != null && (
            <span className="analyze-score" style={{ color: scoreColor }}>
              {matchScore}%
            </span>
          )}
        </div>

        {actionPrompt && <div className="analyze-detail"><strong>Action:</strong> {actionPrompt}</div>}
        {dialogue && <div className="analyze-detail"><strong>Dialogue:</strong> {dialogue}</div>}

        {issues.length > 0 && (
          <div className="analyze-section">
            <h4>Issues</h4>
            <ul>{issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>
          </div>
        )}

        {recommendations.length > 0 && (
          <div className="analyze-section">
            <h4>Recommendations</h4>
            <ul>{recommendations.map((rec, i) => <li key={i}>{rec}</li>)}</ul>
          </div>
        )}

        <div className="analyze-actions">
          <button className="analyze-btn accept" onClick={handleAccept} disabled={busy}>
            ✓ Accept
          </button>
          <button
            className="analyze-btn edit"
            onClick={editing ? handleEditAccept : () => setEditing(true)}
            disabled={busy}
          >
            {editing ? "✓ Save & Accept" : "✎ Edit & Accept"}
          </button>
          <button className="analyze-btn reject" onClick={handleReject} disabled={busy}>
            ✗ Reject
          </button>
        </div>
      </div>
    </div>
  );
}

