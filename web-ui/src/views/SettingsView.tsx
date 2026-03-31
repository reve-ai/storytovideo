import { useEffect, useState, useCallback } from "react";

type LlmProvider = "anthropic" | "openai";

interface AppSettings {
  llmProvider: LlmProvider;
}

const PROVIDER_OPTIONS: { value: LlmProvider; label: string }[] = [
  { value: "anthropic", label: "Anthropic (Claude)" },
  { value: "openai", label: "OpenAI (GPT-5.4)" },
];

export default function SettingsView() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: AppSettings) => setSettings(data))
      .catch(() => setError("Failed to load settings"));
  }, []);

  const handleProviderChange = useCallback(
    async (e: React.ChangeEvent<HTMLSelectElement>) => {
      const provider = e.target.value as LlmProvider;
      setSettings((prev) => (prev ? { ...prev, llmProvider: provider } : prev));
      setSaving(true);
      setError(null);
      try {
        const res = await fetch("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ llmProvider: provider }),
        });
        if (!res.ok) throw new Error("Save failed");
        const updated: AppSettings = await res.json();
        setSettings(updated);
        window.dispatchEvent(new Event("settings-changed"));
      } catch {
        setError("Failed to save settings");
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  return (
    <div
      style={{
        padding: "2rem",
        maxWidth: 560,
      }}
    >
      <h2 style={{ margin: "0 0 1.5rem", fontSize: "1.3rem", fontWeight: 600 }}>
        Settings
      </h2>

      {error && (
        <div
          style={{
            background: "var(--red-dim)",
            color: "var(--red)",
            padding: "0.5rem 0.75rem",
            borderRadius: "var(--radius)",
            marginBottom: "1rem",
            fontSize: "0.85rem",
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "1.25rem",
        }}
      >
        <label
          style={{
            display: "block",
            fontSize: "0.85rem",
            fontWeight: 500,
            color: "var(--muted)",
            marginBottom: "0.5rem",
          }}
        >
          LLM Provider
        </label>

        {settings ? (
          <select
            value={settings.llmProvider}
            onChange={handleProviderChange}
            disabled={saving}
            style={{ minWidth: 220 }}
          >
            {PROVIDER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        ) : (
          <span style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
            Loading…
          </span>
        )}

        {saving && (
          <span
            style={{
              marginLeft: "0.75rem",
              color: "var(--muted)",
              fontSize: "0.8rem",
            }}
          >
            Saving…
          </span>
        )}
      </div>
    </div>
  );
}
