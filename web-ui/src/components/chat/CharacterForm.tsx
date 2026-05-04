import { useCallback, useEffect, useRef, useState } from "react";

import {
  isCharacterDraft,
  selectSession,
  useChatSessionStore,
  type ChatScope,
} from "../../stores/chat-session-store";
import { useRunStore } from "../../stores/run-store";
import { usePipelineStore } from "../../stores/pipeline-store";
import { mediaUrl } from "../../utils/media-url";

interface Props {
  runId: string;
  scope: ChatScope;
  scopeKey: string;
}

interface FieldDef {
  key: "physicalDescription" | "personality" | "ageRange";
  label: string;
  multiline?: boolean;
}

const FIELDS: FieldDef[] = [
  { key: "physicalDescription", label: "Physical description", multiline: true },
  { key: "personality", label: "Personality", multiline: true },
  { key: "ageRange", label: "Age range" },
];

function effectiveValue(
  field: FieldDef,
  liveCharacter: Record<string, unknown> | null,
  draftFields: Record<string, unknown>,
): string {
  if (field.key in draftFields) {
    const v = draftFields[field.key];
    return typeof v === "string" ? v : "";
  }
  const v = liveCharacter?.[field.key];
  return typeof v === "string" ? v : "";
}

export default function CharacterForm({ runId, scope, scopeKey }: Props) {
  const session = useChatSessionStore((s) => selectSession(s, runId, scope, scopeKey));
  const stageDraftFields = useChatSessionStore((s) => s.stageDraftFields);
  const activeRunId = useRunStore((s) => s.activeRunId);
  const assets = usePipelineStore((s) => s.assets);

  const liveCharacter =
    (session?.scopeContext?.liveCharacter as Record<string, unknown> | null | undefined) ?? null;
  const draftFields: Record<string, unknown> =
    session && isCharacterDraft(session.draft) ? session.draft.characterFields : {};
  const pendingReferenceImage =
    session && isCharacterDraft(session.draft) ? session.draft.pendingReferenceImage : null;

  const characterName = (liveCharacter?.name as string | undefined) ?? scopeKey;
  const assetEntry = assets?.characters.find((c) => c.name === characterName) ?? null;
  const referenceImagePath = pendingReferenceImage?.path ?? assetEntry?.imagePath ?? null;

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
      const serverValue = effectiveValue(field, liveCharacter, draftFields);
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
    [local, liveCharacter, draftFields, stageDraftFields, runId, scope, scopeKey],
  );

  if (!liveCharacter) {
    return <div className="shot-form-empty">No character loaded.</div>;
  }

  return (
    <div className="shot-form">
      <div className="shot-form-header">
        <h3>Character: {characterName}</h3>
        <div className="shot-form-meta" style={{ marginTop: 4 }}>
          Apply commits the draft to <code>updateCharacter</code>. Only{" "}
          <code>physicalDescription</code> changes (or a staged reference image)
          re-queue the asset and frames using this character; personality and
          age-range edits update the canonical record only.
        </div>
      </div>
      {referenceImagePath && activeRunId && (
        <div className="shot-form-field">
          <span className="shot-form-label">
            Reference image
            {pendingReferenceImage && (
              <span className="shot-form-draft-badge" title="Staged replacement">●</span>
            )}
          </span>
          <img
            src={mediaUrl(activeRunId, referenceImagePath)}
            alt={characterName}
            style={{ maxWidth: "100%", borderRadius: 6 }}
          />
        </div>
      )}
      {FIELDS.map((field) => {
        const value =
          field.key in local ? local[field.key] : effectiveValue(field, liveCharacter, draftFields);
        const isStaged = field.key in draftFields;
        return (
          <label key={field.key} className={`shot-form-field${isStaged ? " staged" : ""}`}>
            <span>{field.label}</span>
            {field.multiline ? (
              <textarea
                value={value}
                rows={6}
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
