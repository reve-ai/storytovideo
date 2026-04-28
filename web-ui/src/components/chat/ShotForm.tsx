import { useCallback, useEffect, useRef, useState } from "react";

import {
  selectSession,
  useChatSessionStore,
  type ChatScope,
} from "../../stores/chat-session-store";

interface Props {
  runId: string;
  scope: ChatScope;
  scopeKey: string;
  sceneNumber: number;
  shotInScene: number;
}

type FieldType = "string" | "longString" | "number" | "boolean" | "stringArray";

interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
}

const FIELDS: FieldDef[] = [
  { key: "durationSeconds", label: "Duration (s)", type: "number" },
  { key: "composition", label: "Composition", type: "string" },
  { key: "location", label: "Location", type: "string" },
  { key: "speaker", label: "Speaker", type: "string" },
  { key: "dialogue", label: "Dialogue", type: "longString" },
  { key: "videoPrompt", label: "Video Prompt", type: "longString" },
  { key: "startFramePrompt", label: "Start Frame Prompt", type: "longString" },
  { key: "endFramePrompt", label: "End Frame Prompt", type: "longString" },
  { key: "actionPrompt", label: "Action Prompt", type: "longString" },
  { key: "soundEffects", label: "Sound Effects", type: "longString" },
  { key: "cameraDirection", label: "Camera Direction", type: "longString" },
  { key: "charactersPresent", label: "Characters Present", type: "stringArray" },
  { key: "objectsPresent", label: "Objects Present", type: "stringArray" },
  { key: "continuousFromPrevious", label: "Continuous From Previous", type: "boolean" },
  { key: "skipped", label: "Skipped", type: "boolean" },
];

function effectiveValue(field: FieldDef, live: Record<string, unknown> | null, draftFields: Record<string, unknown>): unknown {
  if (field.key in draftFields) return draftFields[field.key];
  return live?.[field.key];
}

function arrayToString(v: unknown): string {
  if (Array.isArray(v)) return (v as unknown[]).map(String).join(", ");
  return "";
}

export default function ShotForm({ runId, scope, scopeKey, sceneNumber, shotInScene }: Props) {
  const session = useChatSessionStore((s) => selectSession(s, runId, scope, scopeKey));
  const stageDraftFields = useChatSessionStore((s) => s.stageDraftFields);

  const liveShot = (session?.scopeContext?.liveShot as Record<string, unknown> | null | undefined) ?? null;
  const draftFields = session?.draft?.shotFields ?? {};

  // Per-field local edits and focus tracking.
  const [local, setLocal] = useState<Record<string, unknown>>({});
  const focusedRef = useRef<Set<string>>(new Set());

  // When the session updates, drop any local edits for fields the user isn't currently editing.
  useEffect(() => {
    setLocal((prev) => {
      const next: Record<string, unknown> = {};
      for (const k of Object.keys(prev)) {
        if (focusedRef.current.has(k)) next[k] = prev[k];
      }
      return next;
    });
  }, [session?.lastSavedAt]);

  const handleFocus = useCallback((key: string) => {
    focusedRef.current.add(key);
  }, []);

  const handleBlur = useCallback(
    async (field: FieldDef) => {
      focusedRef.current.delete(field.key);
      if (!(field.key in local)) return;
      let localValue = local[field.key];
      if (field.type === "stringArray" && typeof localValue === "string") {
        localValue = localValue.split(",").map((x) => x.trim()).filter(Boolean);
      }
      const serverValue = effectiveValue(field, liveShot, draftFields);
      const isSame = JSON.stringify(localValue) === JSON.stringify(serverValue);
      if (isSame) {
        setLocal((prev) => {
          const next = { ...prev };
          delete next[field.key];
          return next;
        });
        return;
      }
      await stageDraftFields(runId, scope, scopeKey, sceneNumber, shotInScene, {
        [field.key]: localValue,
      });
      setLocal((prev) => {
        const next = { ...prev };
        delete next[field.key];
        return next;
      });
    },
    [local, liveShot, draftFields, stageDraftFields, runId, scope, scopeKey, sceneNumber, shotInScene],
  );

  if (!liveShot) {
    return (
      <div className="shot-form-empty">
        Live shot not yet loaded. Open this panel after the analysis has produced this shot.
      </div>
    );
  }

  return (
    <div className="shot-form">
      {FIELDS.map((f) => {
        const isDraftOverride = f.key in draftFields;
        const serverValue = effectiveValue(f, liveShot, draftFields);
        const value = f.key in local ? local[f.key] : serverValue;
        const labelEl = (
          <span className="shot-form-label">
            {f.label}
            {isDraftOverride && <span className="shot-form-draft-badge" title="Draft override">●</span>}
          </span>
        );
        if (f.type === "boolean") {
          return (
            <div className="shot-form-field shot-form-field-bool" key={f.key}>
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(value)}
                  onFocus={() => handleFocus(f.key)}
                  onBlur={() => handleBlur(f)}
                  onChange={(e) => setLocal((prev) => ({ ...prev, [f.key]: e.target.checked }))}
                />
                {labelEl}
              </label>
            </div>
          );
        }
        if (f.type === "number") {
          return (
            <div className="shot-form-field" key={f.key}>
              {labelEl}
              <input
                type="number"
                step="any"
                value={(value as number | string | undefined) ?? ""}
                onFocus={() => handleFocus(f.key)}
                onBlur={() => handleBlur(f)}
                onChange={(e) => setLocal((prev) => ({ ...prev, [f.key]: parseFloat(e.target.value) }))}
              />
            </div>
          );
        }
        if (f.type === "stringArray") {
          return (
            <div className="shot-form-field" key={f.key}>
              {labelEl}
              <input
                type="text"
                value={f.key in local ? (local[f.key] as string) : arrayToString(serverValue)}
                onFocus={() => handleFocus(f.key)}
                onBlur={() => handleBlur({ ...f, key: f.key })}
                onChange={(e) => setLocal((prev) => ({ ...prev, [f.key]: e.target.value }))}
                placeholder="comma, separated"
              />
            </div>
          );
        }
        const strVal = value == null ? "" : String(value);
        if (f.type === "longString") {
          return (
            <div className="shot-form-field" key={f.key}>
              {labelEl}
              <textarea
                value={strVal}
                onFocus={() => handleFocus(f.key)}
                onBlur={() => handleBlur(f)}
                onChange={(e) => setLocal((prev) => ({ ...prev, [f.key]: e.target.value }))}
              />
            </div>
          );
        }
        return (
          <div className="shot-form-field" key={f.key}>
            {labelEl}
            <input
              type="text"
              value={strVal}
              onFocus={() => handleFocus(f.key)}
              onBlur={() => handleBlur(f)}
              onChange={(e) => setLocal((prev) => ({ ...prev, [f.key]: e.target.value }))}
            />
          </div>
        );
      })}
    </div>
  );
}
