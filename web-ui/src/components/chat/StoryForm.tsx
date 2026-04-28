import { useCallback, useEffect, useRef, useState } from "react";

import {
  isStoryDraft,
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
  key: "title" | "artStyle";
  label: string;
  multiline?: boolean;
}

const FIELDS: FieldDef[] = [
  { key: "title", label: "Title" },
  { key: "artStyle", label: "Art style", multiline: true },
];

function effectiveValue(
  field: FieldDef,
  liveStory: Record<string, unknown> | null,
  draftFields: Record<string, unknown>,
): string {
  if (field.key in draftFields) {
    const v = draftFields[field.key];
    return typeof v === "string" ? v : "";
  }
  const v = liveStory?.[field.key];
  return typeof v === "string" ? v : "";
}

export default function StoryForm({ runId, scope, scopeKey }: Props) {
  const session = useChatSessionStore((s) => selectSession(s, runId, scope, scopeKey));
  const stageDraftFields = useChatSessionStore((s) => s.stageDraftFields);

  const liveStory =
    (session?.scopeContext?.liveStory as Record<string, unknown> | null | undefined) ?? null;
  const stats =
    (session?.scopeContext?.stats as
      | { sceneCount: number; shotCount: number; characterCount: number; locationCount: number; objectCount: number }
      | null
      | undefined) ?? null;
  const draftFields: Record<string, unknown> =
    session && isStoryDraft(session.draft) ? session.draft.storyFields : {};

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
      const serverValue = effectiveValue(field, liveStory, draftFields);
      if (localValue === serverValue) {
        setLocal((prev) => {
          const next = { ...prev };
          delete next[field.key];
          return next;
        });
        return;
      }
      await stageDraftFields(runId, scope, scopeKey, { [field.key]: localValue });
      setLocal((prev) => {
        const next = { ...prev };
        delete next[field.key];
        return next;
      });
    },
    [local, liveStory, draftFields, stageDraftFields, runId, scope, scopeKey],
  );

  if (!liveStory) {
    return <div className="shot-form-empty">No story loaded.</div>;
  }

  return (
    <div className="shot-form">
      <div className="shot-form-header">
        <h3>Story</h3>
        {stats && (
          <div className="shot-form-meta">
            {stats.sceneCount} scenes · {stats.shotCount} shots · {stats.characterCount} characters ·{" "}
            {stats.locationCount} locations · {stats.objectCount} objects
          </div>
        )}
        <div className="shot-form-meta" style={{ marginTop: 4 }}>
          Apply commits the draft. <strong>Apply does NOT trigger a project-wide re-frame</strong> even
          when the art style changes — re-run frames manually if you want them redone.
        </div>
      </div>
      {FIELDS.map((field) => {
        const value =
          field.key in local ? local[field.key] : effectiveValue(field, liveStory, draftFields);
        const isStaged = field.key in draftFields;
        return (
          <label key={field.key} className={`shot-form-field${isStaged ? " staged" : ""}`}>
            <span>{field.label}</span>
            {field.multiline ? (
              <textarea
                value={value}
                rows={4}
                onChange={(e) => setLocal((prev) => ({ ...prev, [field.key]: e.target.value }))}
                onFocus={() => handleFocus(field.key)}
                onBlur={() => handleBlur(field)}
              />
            ) : (
              <input
                type="text"
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
