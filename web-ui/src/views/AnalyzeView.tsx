import React, { useCallback, useMemo, useState } from "react";
import { usePipelineStore, type WorkItem } from "../stores/pipeline-store";
import { useRunStore } from "../stores/run-store";
import VideoThumbnail from "../components/VideoThumbnail";
import { mediaUrl } from "../utils/media-url";

function ReviewAllButton({ runId }: { runId: string }) {
  const [loading, setLoading] = useState(false);
  const enqueueAll = usePipelineStore((s) => s.enqueueAllAnalysis);

  const handleClick = useCallback(async () => {
    setLoading(true);
    try {
      await enqueueAll(runId);
    } finally {
      setLoading(false);
    }
  }, [enqueueAll, runId]);

  return (
    <button
      className="analyze-btn accept"
      onClick={handleClick}
      disabled={loading}
      style={{ marginTop: 12 }}
    >
      {loading ? "Enqueuing…" : "Review All Clips"}
    </button>
  );
}

const bySceneThenShot = (a: WorkItem, b: WorkItem) => {
  const aShot = a.inputs.shot as Record<string, unknown> | undefined;
  const bShot = b.inputs.shot as Record<string, unknown> | undefined;
  const aScene = typeof aShot?.sceneNumber === "number" ? aShot.sceneNumber : Infinity;
  const bScene = typeof bShot?.sceneNumber === "number" ? bShot.sceneNumber : Infinity;
  if (aScene !== bScene) return aScene - bScene;
  const aShotIn = typeof aShot?.shotInScene === "number" ? aShot.shotInScene : Infinity;
  const bShotIn = typeof bShot?.shotInScene === "number" ? bShot.shotInScene : Infinity;
  return aShotIn - bShotIn;
};

export default function AnalyzeView() {
  const activeRunId = useRunStore((s) => s.activeRunId);
  const runs = useRunStore((s) => s.runs);
  const analyzeItems = usePipelineStore((s) => s.analyzeItems);
  const acceptItem = usePipelineStore((s) => s.acceptAnalyzeItem);
  const rejectItem = usePipelineStore((s) => s.rejectAnalyzeItem);

  const run = runs.find((r) => r.id === activeRunId);
  const aspectRatio = (run?.options?.aspectRatio || "16:9").replace(":", "/");

  const inProgress = analyzeItems.filter((i) => i.status === "in_progress").sort(bySceneThenShot);
  const pending = analyzeItems.filter((i) => i.status === "pending").sort(bySceneThenShot);
  const completed = analyzeItems
    .filter((i) => i.status === "completed")
    .sort(bySceneThenShot);

  if (!activeRunId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[--text-muted] text-sm">Select a run to review</p>
      </div>
    );
  }

  if (analyzeItems.length === 0) {
    return (
      <div className="flex h-full items-center justify-center flex-col gap-2">
        <p className="text-[--muted] text-sm">No videos pending review</p>
        <ReviewAllButton runId={activeRunId} />
      </div>
    );
  }

  return (
    <div className="analyze-view">
      {completed.map((item) => (
        <AnalyzeCard
          key={item.id}
          item={item}
          runId={activeRunId}
          aspectRatio={aspectRatio}
          onAccept={acceptItem}
          onReject={rejectItem}
        />
      ))}
      {inProgress.map((item) => (
        <AnalyzeStatusCard
          key={item.id}
          item={item}
          runId={activeRunId}
          aspectRatio={aspectRatio}
          status="analyzing"
        />
      ))}
      {pending.map((item) => (
        <AnalyzeStatusCard
          key={item.id}
          item={item}
          runId={activeRunId}
          aspectRatio={aspectRatio}
          status="queued"
        />
      ))}
    </div>
  );
}

/** Card for pending/in-progress analyze items — shows a status indicator instead of review actions. */
function AnalyzeStatusCard({
  item,
  runId,
  aspectRatio,
  status,
}: {
  item: WorkItem;
  runId: string;
  aspectRatio: string;
  status: "analyzing" | "queued";
}) {
  const shot = item.inputs.shot as Record<string, unknown> | undefined;
  const sceneNumber = typeof shot?.sceneNumber === "number" ? shot.sceneNumber : null;
  const shotInScene = typeof shot?.shotInScene === "number" ? shot.shotInScene : null;
  const videoPath = item.inputs.videoPath as string | undefined;
  const startFramePath = item.inputs.startFramePath as string | undefined;

  const composition = shot?.composition as string | undefined;
  const durationSeconds = shot?.durationSeconds as number | undefined;
  const shotLabel = sceneNumber != null && shotInScene != null ? `S${sceneNumber}.${shotInScene}` : `Item ${item.id.slice(0, 8)}`;

  const videoSrc = videoPath ? mediaUrl(runId, videoPath) : null;
  const frameSrc = startFramePath ? mediaUrl(runId, startFramePath) : null;

  return (
    <div className="analyze-card" style={{ opacity: status === "queued" ? 0.7 : 1 }}>
      <div className="analyze-card-media">
        {videoSrc ? (
          <VideoThumbnail
            videoSrc={videoSrc}
            thumbnailSrc={frameSrc ?? undefined}
            aspectRatio={aspectRatio}
            className="analyze-video"
          />
        ) : frameSrc ? (
          <img src={frameSrc} alt={shotLabel} style={{ aspectRatio }} />
        ) : (
          <div className="analyze-placeholder" style={{ aspectRatio, minHeight: 120 }}>No media</div>
        )}
      </div>
      <div className="analyze-card-body">
        <div className="analyze-card-header">
          <span className="story-shot-number">{shotLabel}</span>
          {composition && <span className="story-shot-comp">{composition}</span>}
          {durationSeconds != null && <span className="story-shot-duration">{durationSeconds}s</span>}
        </div>
        <div className="analyze-actions">
          {status === "analyzing" ? (
            <span className="analyze-status-badge" style={{ color: "var(--orange)" }}>
              ⟳ Analyzing…
            </span>
          ) : (
            <span className="analyze-status-badge" style={{ color: "var(--muted)" }}>
              ◷ Queued
            </span>
          )}
        </div>
      </div>
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
  videoPrompt: string;
  dialogue: string;
  startFramePrompt: string;
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

const AnalyzeCard = React.memo(function AnalyzeCard({ item, runId, aspectRatio, onAccept, onReject }: AnalyzeCardProps) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const shot = item.inputs.shot as Record<string, unknown> | undefined;
  const sceneNumber = typeof shot?.sceneNumber === "number" ? shot.sceneNumber : null;
  const shotInScene = typeof shot?.shotInScene === "number" ? shot.shotInScene : null;
  const videoPath = item.inputs.videoPath as string | undefined;
  const startFramePath = item.inputs.startFramePath as string | undefined;
  const shotLabel = sceneNumber != null && shotInScene != null ? `S${sceneNumber}.${shotInScene}` : `Item ${item.id.slice(0, 8)}`;

  const analysis = (item.outputs ?? {}) as Record<string, unknown>;
  const matchScore = analysis.matchScore as number | undefined;
  const issues = (analysis.issues ?? []) as string[];
  const recommendations = (analysis.recommendations ?? []) as Array<
    string | { type?: string; commentary?: string; suggestedInputs?: Record<string, unknown> }
  >;
  const recommendationStrings = recommendations.map((r) =>
    typeof r === "string" ? r : (r as { commentary?: string; type?: string }).commentary ?? (r as { type?: string }).type ?? JSON.stringify(r),
  );

  const videoSrc = videoPath ? mediaUrl(runId, videoPath) : null;
  const frameSrc = startFramePath ? mediaUrl(runId, startFramePath) : null;

  const composition = shot?.composition as string | undefined;
  const durationSeconds = shot?.durationSeconds as number | undefined;
  const videoPrompt = (shot?.videoPrompt ?? shot?.actionPrompt) as string | undefined;
  const dialogue = shot?.dialogue as string | undefined;

  // Original values from the shot
  const originalValues: EditFormValues = useMemo(() => ({
    durationSeconds: (shot?.durationSeconds as number) ?? 8,
    videoPrompt: ((shot?.videoPrompt ?? shot?.actionPrompt) as string) ?? "",
    dialogue: (shot?.dialogue as string) ?? "",
    startFramePrompt: (shot?.startFramePrompt as string) ?? "",
    cameraDirection: (shot?.cameraDirection as string) ?? "",
  }), [shot]);

  // Suggested values = original overridden by suggestedInputs from recommendations
  const suggestedInputs = useMemo(() => buildSuggestedInputs(item.outputs), [item.outputs]);
  const suggestedValues: EditFormValues = useMemo(() => ({
    durationSeconds: (suggestedInputs.durationSeconds as number) ?? originalValues.durationSeconds,
    videoPrompt: ((suggestedInputs.videoPrompt ?? suggestedInputs.actionPrompt) as string) ?? originalValues.videoPrompt,
    dialogue: (suggestedInputs.dialogue as string) ?? originalValues.dialogue,
    startFramePrompt: (suggestedInputs.startFramePrompt as string) ?? originalValues.startFramePrompt,
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
      videoPrompt: formValues.videoPrompt,
      dialogue: formValues.dialogue,
      startFramePrompt: formValues.startFramePrompt,
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
          <VideoThumbnail
            videoSrc={videoSrc}
            thumbnailSrc={frameSrc ?? undefined}
            aspectRatio={aspectRatio}
            className="analyze-video"
          />
        ) : frameSrc ? (
          <img src={frameSrc} alt={shotLabel} style={{ aspectRatio }} />
        ) : (
          <div className="analyze-placeholder" style={{ aspectRatio, minHeight: 120 }}>
            No media
          </div>
        )}
      </div>

      <div className="analyze-card-body">
        <div className="analyze-card-header">
          <span className="story-shot-number">{shotLabel}</span>
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
            {videoPrompt && <div className="analyze-detail"><strong>Video Direction:</strong> {videoPrompt}</div>}
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
            isContinuityShot={!!shot?.continuousFromPrevious}
          />
        )}

        <div className="analyze-actions">
          {!editing && (
            <>
              <button className="analyze-btn reject" onClick={handleAccept} disabled={busy}>
                Make Change
              </button>
              <button className="analyze-btn edit" onClick={enterEditMode} disabled={busy}>
                Edit Change
              </button>
              <button className="analyze-btn accept" onClick={handleReject} disabled={busy}>
                Ok
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
}, (prev, next) => {
  // Only re-render if the item data actually changed
  return prev.item.id === next.item.id
    && prev.item.status === next.item.status
    && prev.item.version === next.item.version
    && prev.runId === next.runId
    && prev.aspectRatio === next.aspectRatio;
});

/* ------------------------------------------------------------------ */
/*  Inline edit form                                                   */
/* ------------------------------------------------------------------ */

interface EditFormProps {
  formValues: EditFormValues;
  originalValues: EditFormValues;
  onUpdate: <K extends keyof EditFormValues>(key: K, value: EditFormValues[K]) => void;
  onReset: <K extends keyof EditFormValues>(key: K) => void;
  isContinuityShot?: boolean;
}

function EditForm({ formValues, originalValues, onUpdate, onReset, isContinuityShot }: EditFormProps) {
  return (
    <div className="analyze-edit-form">
      <EditField
        label="Start frame prompt"
        fieldKey="startFramePrompt"
        type="textarea"
        value={formValues.startFramePrompt}
        original={originalValues.startFramePrompt}
        onChange={(v) => onUpdate("startFramePrompt", v as string)}
        onReset={() => onReset("startFramePrompt")}
        disabled={isContinuityShot}
        disabledNote="Start frame is extracted from the previous shot (continuity mode)"
      />
      <EditField
        label="Video Direction"
        fieldKey="videoPrompt"
        type="textarea"
        value={formValues.videoPrompt}
        original={originalValues.videoPrompt}
        onChange={(v) => onUpdate("videoPrompt", v as string)}
        onReset={() => onReset("videoPrompt")}
      />
      <EditField
        label="Dialogue"
        fieldKey="dialogue"
        type="textarea"
        value={formValues.dialogue}
        original={originalValues.dialogue}
        onChange={(v) => onUpdate("dialogue", v as string)}
        onReset={() => onReset("dialogue")}
      />
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
  disabled?: boolean;
  disabledNote?: string;
}

function EditField({ label, type, value, original, onChange, onReset, disabled, disabledNote }: EditFieldProps) {
  const changed = String(value) !== String(original);

  return (
    <div className={`analyze-edit-field${changed ? " changed" : ""}${disabled ? " disabled" : ""}`}>
      <div className="analyze-edit-field-header">
        <label className="input-label">{label}</label>
        {changed && !disabled && (
          <button type="button" className="analyze-edit-reset" onClick={onReset}>
            Reset
          </button>
        )}
      </div>
      {disabled && disabledNote && (
        <p className="analyze-edit-disabled-note">{disabledNote}</p>
      )}
      {type === "textarea" ? (
        <textarea
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          disabled={disabled}
        />
      ) : type === "number" ? (
        <input
          type="number"
          value={value}
          min={1}
          step={1}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
          disabled={disabled}
        />
      ) : (
        <input
          type="text"
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
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

