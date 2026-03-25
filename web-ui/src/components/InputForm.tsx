import { useState, useCallback } from "react";

function camelToLabel(key: string): string {
  if (key === "durationSeconds") return "Duration (seconds)";
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

function collectValues(
  original: Record<string, unknown>,
  edited: Record<string, unknown>,
  prefix: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, origValue] of Object.entries(original)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (
      origValue !== null &&
      typeof origValue === "object" &&
      !Array.isArray(origValue)
    ) {
      result[key] = collectValues(
        origValue as Record<string, unknown>,
        edited,
        path,
      );
    } else {
      result[key] = path in edited ? edited[path] : origValue;
    }
  }
  return result;
}

interface FormFieldsProps {
  obj: Record<string, unknown>;
  prefix: string;
  editable: boolean;
  edited: Record<string, unknown>;
  onFieldChange: (path: string, value: unknown) => void;
}

function FormFields({
  obj,
  prefix,
  editable,
  edited,
  onFieldChange,
}: FormFieldsProps) {
  return (
    <>
      {Object.entries(obj).map(([key, value]) => {
        const fieldPath = prefix ? `${prefix}.${key}` : key;
        const label = camelToLabel(key);

        if (
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value)
        ) {
          return (
            <CollapsibleGroup key={fieldPath} label={label}>
              <FormFields
                obj={value as Record<string, unknown>}
                prefix={fieldPath}
                editable={editable}
                edited={edited}
                onFieldChange={onFieldChange}
              />
            </CollapsibleGroup>
          );
        }

        return (
          <SingleField
            key={fieldPath}
            fieldPath={fieldPath}
            label={label}
            originalValue={value}
            editable={editable}
            editedValue={
              fieldPath in edited ? edited[fieldPath] : undefined
            }
            onFieldChange={onFieldChange}
          />
        );
      })}
    </>
  );
}

function CollapsibleGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className={`input-group${collapsed ? " collapsed" : ""}`}>
      <div
        className="input-group-header"
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className="chevron">▼</span> {label}
      </div>
      <div className="input-group-body">{children}</div>
    </div>
  );
}

interface SingleFieldProps {
  fieldPath: string;
  label: string;
  originalValue: unknown;
  editable: boolean;
  editedValue: unknown;
  onFieldChange: (path: string, value: unknown) => void;
}

function SingleField({
  fieldPath,
  label,
  originalValue,
  editable,
  editedValue,
  onFieldChange,
}: SingleFieldProps) {
  const value = editedValue !== undefined ? editedValue : originalValue;

  if (typeof originalValue === "boolean") {
    if (editable) {
      return (
        <div className="input-field">
          <div className="checkbox-row">
            <input
              type="checkbox"
              checked={value as boolean}
              onChange={(e) => onFieldChange(fieldPath, e.target.checked)}
            />
            <span className="input-label">{label}</span>
          </div>
        </div>
      );
    }
    return (
      <div className="input-field">
        <span className="input-label">{label}</span>
        <span className="readonly-value">
          {originalValue ? "✓ Yes" : "✗ No"}
        </span>
      </div>
    );
  }

  if (typeof originalValue === "number") {
    if (editable) {
      return (
        <div className="input-field">
          <span className="input-label">{label}</span>
          <input
            type="number"
            value={value as number}
            step="any"
            onChange={(e) =>
              onFieldChange(fieldPath, parseFloat(e.target.value) || 0)
            }
          />
        </div>
      );
    }
    return (
      <div className="input-field">
        <span className="input-label">{label}</span>
        <span className="readonly-value">{String(originalValue)}</span>
      </div>
    );
  }

  if (Array.isArray(originalValue)) {
    const strVal = (value as unknown[]).join(", ");
    if (editable) {
      return (
        <div className="input-field">
          <span className="input-label">{label}</span>
          <input
            type="text"
            value={strVal}
            onChange={(e) =>
              onFieldChange(
                fieldPath,
                e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
          />
        </div>
      );
    }
    return (
      <div className="input-field">
        <span className="input-label">{label}</span>
        <span className="readonly-value">
          {(originalValue as unknown[]).join(", ") || "—"}
        </span>
      </div>
    );
  }

  // String or null/undefined
  const strValue = originalValue == null ? "" : String(value);
  const isLong = strValue.length > 100;

  if (editable) {
    if (originalValue == null) {
      return (
        <div className="input-field">
          <span className="input-label">{label}</span>
          <input type="text" value="" disabled placeholder="null" />
        </div>
      );
    }
    if (isLong) {
      return (
        <div className="input-field">
          <span className="input-label">{label}</span>
          <textarea
            value={strValue}
            onChange={(e) => onFieldChange(fieldPath, e.target.value)}
          />
        </div>
      );
    }
    return (
      <div className="input-field">
        <span className="input-label">{label}</span>
        <input
          type="text"
          value={strValue}
          onChange={(e) => onFieldChange(fieldPath, e.target.value)}
        />
      </div>
    );
  }

  // Read-only
  if (isLong) {
    return (
      <div className="input-field">
        <span className="input-label">{label}</span>
        <div
          className="readonly-value"
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 120,
            overflowY: "auto",
          }}
        >
          {String(originalValue)}
        </div>
      </div>
    );
  }
  return (
    <div className="input-field">
      <span className="input-label">{label}</span>
      <span className="readonly-value">
        {String(originalValue ?? "") || "—"}
      </span>
    </div>
  );
}

// --- Main InputForm component ---

export interface InputFormProps {
  inputs: Record<string, unknown>;
  itemId: string;
  itemStatus: string;
  editable: boolean;
  onSave: (itemId: string, inputs: Record<string, unknown>) => Promise<void>;
}

export default function InputForm({
  inputs,
  itemId,
  itemStatus,
  editable,
  onSave,
}: InputFormProps) {
  const [edited, setEdited] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);

  const isDirty = Object.keys(edited).length > 0;
  const isRedo = itemStatus === "completed" || itemStatus === "failed";
  const btnLabel = isRedo ? "Save & Redo" : "Save Changes";

  const onFieldChange = useCallback((path: string, value: unknown) => {
    setEdited((prev) => ({ ...prev, [path]: value }));
  }, []);

  const handleSave = useCallback(async () => {
    if (!isDirty || saving) return;
    setSaving(true);
    try {
      const merged = collectValues(inputs, edited, "");
      await onSave(itemId, merged);
      setEdited({});
    } finally {
      setSaving(false);
    }
  }, [isDirty, saving, inputs, edited, onSave, itemId]);

  if (!inputs || Object.keys(inputs).length === 0) {
    return (
      <div style={{ color: "var(--muted)", fontSize: "0.8rem" }}>
        No inputs
      </div>
    );
  }

  return (
    <div className="input-form">
      <FormFields
        obj={inputs}
        prefix=""
        editable={editable}
        edited={edited}
        onFieldChange={onFieldChange}
      />
      {editable && (
        <button
          className={`save-inputs-btn${isDirty ? " visible" : ""}`}
          onClick={handleSave}
          disabled={saving || !isDirty}
        >
          {saving ? (isRedo ? "Redoing..." : "Saving...") : btnLabel}
        </button>
      )}
    </div>
  );
}

