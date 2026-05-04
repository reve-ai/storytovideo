import { useCallback, useEffect, useRef, useState } from "react";

import {
  isSceneDraft,
  selectSession,
  useChatSessionStore,
  type ChatScope,
} from "../../stores/chat-session-store";

interface Props {
  runId: string;
  scope: ChatScope;
  scopeKey: string;
}

interface FieldDef {
  key: "title" | "narrativeSummary" | "location" | "charactersPresent" | "estimatedDurationSeconds";
  label: string;
  kind: "text" | "textarea" | "array" | "number";
}

const FIELDS: FieldDef[] = [
  { key: "title", label: "Title", kind: "text" },
  { key: "narrativeSummary", label: "Narrative summary", kind: "textarea" },
  { key: "location", label: "Location", kind: "text" },
  { key: "charactersPresent", label: "Characters present", kind: "array" },
  { key: "estimatedDurationSeconds", label: "Estimated duration seconds", kind: "number" },
];

function formatValue(v: unknown): string {
  if (Array.isArray(v)) return v.map(String).join(", ");
  if (typeof v === "number") return String(v);
  return typeof v === "string" ? v : "";
}

function effectiveValue(
  field: FieldDef,
  liveScene: Record<string, unknown> | null,
  draftFields: Record<string, unknown>,
): string {
  if (field.key in draftFields) return formatValue(draftFields[field.key]);
  return formatValue(liveScene?.[field.key]);
}

function parseValue(field: FieldDef, value: string): unknown {
  if (field.kind === "array") {
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (field.kind === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return value;
}

export default function SceneForm({ runId, scope, scopeKey }: Props) {
  const session = useChatSessionStore((s) => selectSession(s, runId, scope, scopeKey));
  const stageDraftFields = useChatSessionStore((s) => s.stageDraftFields);

  const liveScene =
    (session?.scopeContext?.liveScene as Record<string, unknown> | null | undefined) ?? null;
  const stats =
    (session?.scopeContext?.stats as
      | { shotCount: number; framesGenerated: number; videosGenerated: number }
      | null
      | undefined) ?? null;
  const draftFields: Record<string, unknown> =
    session && isSceneDraft(session.draft) ? session.draft.sceneFields : {};

  const [local, setLocal] = useState<Record<string, string>>({});
  const focusedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setLocal((prev) => {
      const next: Record<string, string> = {};
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
      const localValue = local[field.key];
      const serverValue = effectiveValue(field, liveScene, draftFields);
      const parsed = parseValue(field, localValue);
      if (localValue === serverValue || parsed === null) {
        setLocal((prev) => {
          const next = { ...prev };
          delete next[field.key];
          return next;
        });
        return;
      }
      await stageDraftFields(runId, scope, scopeKey, { [field.key]: parsed });
      setLocal((prev) => {
        const next = { ...prev };
        delete next[field.key];
        return next;
      });
    },
    [local, liveScene, draftFields, stageDraftFields, runId, scope, scopeKey],
  );

  if (!liveScene) {
    return <div className="shot-form-empty">No scene loaded.</div>;
  }

  return (
    <div className="shot-form">
      <div className="shot-form-header">
        <h3>Scene {scopeKey}: {formatValue(liveScene.title)}</h3>
        {stats && (
          <div className="shot-form-meta">
            {stats.shotCount} shots · {stats.framesGenerated} frames · {stats.videosGenerated} videos
          </div>
        )}
        <div className="shot-form-meta" style={{ marginTop: 4 }}>
          Apply commits the draft. <strong>Apply does NOT cascade</strong> — click Redo Scene after
          applying if you want shots re-planned and regenerated.
        </div>
      </div>
      {FIELDS.map((field) => {
        const value =
          field.key in local ? local[field.key] : effectiveValue(field, liveScene, draftFields);
        const isStaged = field.key in draftFields;
        return (
          <label key={field.key} className={`shot-form-field${isStaged ? " staged" : ""}`}>
            <span>{field.label}</span>
            {field.kind === "textarea" ? (
              <textarea
                value={value}
                rows={5}
                onChange={(e) => setLocal((prev) => ({ ...prev, [field.key]: e.target.value }))}
                onFocus={() => handleFocus(field.key)}
                onBlur={() => handleBlur(field)}
              />
            ) : (
              <input
                type={field.kind === "number" ? "number" : "text"}
                value={value}
                onChange={(e) => setLocal((prev) => ({ ...prev, [field.key]: e.target.value }))}
                onFocus={() => handleFocus(field.key)}
                onBlur={() => handleBlur(field)}
              />
            )}
          </label>
        );
      })}
    </div>
  );
}