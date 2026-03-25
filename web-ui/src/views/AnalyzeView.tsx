import { useCallback, useMemo, useState } from "react";
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

/** Fields that the edit form exposes. */
interface EditFormValues {
  durationSeconds: number;
  actionPrompt: string;
  startFramePrompt: string;
  endFramePrompt: string;
  cameraDirection: string;
}

/** Merge suggestedInputs from structured recommendations (if any). */
function buildSuggestedInputs(outputs: Record<string, unknown>): Record<string, unknown> {
  const recs = (outputs.recommendations ?? []) as Array<
    string | { type?: string; suggestedInputs?: Record<string, unknown> }
  >;
  let merged: Record<string, unknown> = {};
  for (const r of recs) {
    if (typeof r === "object" && r.suggestedInputs) {
      merged = { ...merged, ...r.suggestedInputs };
    }
  }
  return merged;
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
  const recommendations = (analysis.recommendations ?? []) as Array<
    string | { type?: string; suggestedInputs?: Record<string, unknown> }
  >;
  const recommendationStrings = recommendations.map((r) =>
    typeof r === "string" ? r : (r as Record<string, unknown>).type as string ?? JSON.stringify(r),
  );

  const videoSrc = videoPath ? `/api/runs/${runId}/media/${videoPath}` : null;
  const frameSrc = startFramePath ? `/api/runs/${runId}/media/${startFramePath}` : null;

  const composition = shot?.composition as string | undefined;
  const durationSeconds = shot?.durationSeconds as number | undefined;
  const actionPrompt = shot?.actionPrompt as string | undefined;
  const dialogue = shot?.dialogue as string | undefined;

  // Original values from the shot
  const originalValues: EditFormValues = useMemo(() => ({
    durationSeconds: (shot?.durationSeconds as number) ?? 8,
    actionPrompt: (shot?.actionPrompt as string) ?? "",
    startFramePrompt: (shot?.startFramePrompt as string) ?? "",
    endFramePrompt: (shot?.endFramePrompt as string) ?? "",
    cameraDirection: (shot?.cameraDirection as string) ?? "",
  }), [shot]);

  // Suggested values = original overridden by suggestedInputs from recommendations
  const suggestedInputs = useMemo(() => buildSuggestedInputs(item.outputs), [item.outputs]);
  const suggestedValues: EditFormValues = useMemo(() => ({
    durationSeconds: (suggestedInputs.durationSeconds as number) ?? originalValues.durationSeconds,
    actionPrompt: (suggestedInputs.actionPrompt as string) ?? originalValues.actionPrompt,
    startFramePrompt: (suggestedInputs.startFramePrompt as string) ?? originalValues.startFramePrompt,
    endFramePrompt: (suggestedInputs.endFramePrompt as string) ?? originalValues.endFramePrompt,
    cameraDirection: (suggestedInputs.cameraDirection as string) ?? originalValues.cameraDirection,
  }), [suggestedInputs, originalValues]);

  // Editable form state — initialised from suggested values
  const [formValues, setFormValues] = useState<EditFormValues>(suggestedValues);

  // Reset form when entering edit mode
  const enterEditMode = useCallback(() => {
    setFormValues(suggestedValues);
    setEditing(true);
  }, [suggestedValues]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
  }, []);

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

  const handleApply = useCallback(async () => {
    setBusy(true);
    // Build the shot object merging edited values over the original shot
    const editedShot = { ...shot, ...formValues };
    await onAccept(runId, item.id, {
      shot: editedShot,
      durationSeconds: formValues.durationSeconds,
      actionPrompt: formValues.actionPrompt,
      startFramePrompt: formValues.startFramePrompt,
      endFramePrompt: formValues.endFramePrompt,
      cameraDirection: formValues.cameraDirection,
    });
    setBusy(false);
    setEditing(false);
  }, [runId, item.id, onAccept, shot, formValues]);

  const updateField = useCallback(<K extends keyof EditFormValues>(key: K, value: EditFormValues[K]) => {
    setFormValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const resetField = useCallback(<K extends keyof EditFormValues>(key: K) => {
    setFormValues((prev) => ({ ...prev, [key]: originalValues[key] }));
  }, [originalValues]);

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

        {!editing && (
          <>
            {actionPrompt && <div className="analyze-detail"><strong>Action:</strong> {actionPrompt}</div>}
            {dialogue && <div className="analyze-detail"><strong>Dialogue:</strong> {dialogue}</div>}

            {issues.length > 0 && (
              <div className="analyze-section">
                <h4>Issues</h4>
                <ul>{issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>
              </div>
            )}

            {recommendationStrings.length > 0 && (
              <div className="analyze-section">
                <h4>Recommendations</h4>
                <ul>{recommendationStrings.map((rec, i) => <li key={i}>{rec}</li>)}</ul>
              </div>
            )}
          </>
        )}

        {editing && (
          <EditForm
            formValues={formValues}
            originalValues={originalValues}
            onUpdate={updateField}
            onReset={resetField}
          />
        )}

        <div className="analyze-actions">
          {!editing && (
            <>
              <button className="analyze-btn accept" onClick={handleAccept} disabled={busy}>
                ✓ Accept
              </button>
              <button className="analyze-btn edit" onClick={enterEditMode} disabled={busy}>
                ✎ Edit & Accept
              </button>
              <button className="analyze-btn reject" onClick={handleReject} disabled={busy}>
                ✗ Reject
              </button>
            </>
          )}
          {editing && (
            <>
              <button className="analyze-btn accept" onClick={handleApply} disabled={busy}>
                ✓ Apply
              </button>
              <button className="analyze-btn edit" onClick={cancelEdit} disabled={busy}>
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Inline edit form                                                   */
/* ------------------------------------------------------------------ */

interface EditFormProps {
  formValues: EditFormValues;
  originalValues: EditFormValues;
  onUpdate: <K extends keyof EditFormValues>(key: K, value: EditFormValues[K]) => void;
  onReset: <K extends keyof EditFormValues>(key: K) => void;
}

function EditForm({ formValues, originalValues, onUpdate, onReset }: EditFormProps) {
  return (
    <div className="analyze-edit-form">
      <EditField
        label="Duration (seconds)"
        fieldKey="durationSeconds"
        type="number"
        value={formValues.durationSeconds}
        original={originalValues.durationSeconds}
        onChange={(v) => onUpdate("durationSeconds", Number(v))}
        onReset={() => onReset("durationSeconds")}
      />
      <EditField
        label="Action prompt"
        fieldKey="actionPrompt"
        type="textarea"
        value={formValues.actionPrompt}
        original={originalValues.actionPrompt}
        onChange={(v) => onUpdate("actionPrompt", v as string)}
        onReset={() => onReset("actionPrompt")}
      />
      <EditField
        label="Start frame prompt"
        fieldKey="startFramePrompt"
        type="textarea"
        value={formValues.startFramePrompt}
        original={originalValues.startFramePrompt}
        onChange={(v) => onUpdate("startFramePrompt", v as string)}
        onReset={() => onReset("startFramePrompt")}
      />
      <EditField
        label="End frame prompt"
        fieldKey="endFramePrompt"
        type="textarea"
        value={formValues.endFramePrompt}
        original={originalValues.endFramePrompt}
        onChange={(v) => onUpdate("endFramePrompt", v as string)}
        onReset={() => onReset("endFramePrompt")}
      />
      <EditField
        label="Camera direction"
        fieldKey="cameraDirection"
        type="text"
        value={formValues.cameraDirection}
        original={originalValues.cameraDirection}
        onChange={(v) => onUpdate("cameraDirection", v as string)}
        onReset={() => onReset("cameraDirection")}
      />
    </div>
  );
}

interface EditFieldProps {
  label: string;
  fieldKey: string;
  type: "text" | "number" | "textarea";
  value: string | number;
  original: string | number;
  onChange: (value: string | number) => void;
  onReset: () => void;
}

function EditField({ label, type, value, original, onChange, onReset }: EditFieldProps) {
  const changed = String(value) !== String(original);

  return (
    <div className={`analyze-edit-field${changed ? " changed" : ""}`}>
      <div className="analyze-edit-field-header">
        <label className="input-label">{label}</label>
        {changed && (
          <button type="button" className="analyze-edit-reset" onClick={onReset}>
            Reset
          </button>
        )}
      </div>
      {type === "textarea" ? (
        <textarea
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
        />
      ) : type === "number" ? (
        <input
          type="number"
          value={value}
          min={1}
          step={1}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
        />
      ) : (
        <input
          type="text"
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {changed && (
        <span className="analyze-edit-original" title={`Original: ${original}`}>
          was: {String(original) || "(empty)"}
        </span>
      )}
    </div>
  );
}

