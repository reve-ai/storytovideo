import { useCallback, useRef, useState } from "react";
import { usePipelineStore } from "../stores/pipeline-store";
import { useRunStore } from "../stores/run-store";

interface AssetReplaceProps {
  assetKey: string;
  label?: string;
}

export default function AssetReplace({ assetKey, label }: AssetReplaceProps) {
  const activeRunId = useRunStore((s) => s.activeRunId);
  const replaceAsset = usePipelineStore((s) => s.replaceAsset);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      inputRef.current?.click();
    },
    [],
  );

  const handleChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !activeRunId) return;
      setUploading(true);
      setMessage(null);
      try {
        const result = await replaceAsset(activeRunId, assetKey, file);
        if (result) {
          const assetName = assetKey.split(":")[1] ?? assetKey;
          setMessage(`Replaced ${assetName}. Regenerating ${result.framesRequeued} frame${result.framesRequeued !== 1 ? "s" : ""}.`);
          setTimeout(() => setMessage(null), 5000);
        }
      } finally {
        setUploading(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [activeRunId, replaceAsset, assetKey],
  );

  return (
    <>
      <button
        className="asset-replace-btn"
        onClick={handleClick}
        disabled={uploading}
        title={`Replace ${label ?? "asset"} with custom image`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 12px",
          marginTop: 8,
          borderRadius: 6,
          border: "1px solid var(--border, #444)",
          background: "var(--surface-2, #1a1a2e)",
          color: "var(--text, #e0e0e0)",
          cursor: uploading ? "wait" : "pointer",
          fontSize: "0.8rem",
          opacity: uploading ? 0.6 : 1,
        }}
      >
        {uploading ? (
          <span className="image-upload-spinner" />
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        )}
        Upload replacement
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={handleChange}
      />
      {message && (
        <div style={{
          marginTop: 6,
          padding: "6px 10px",
          borderRadius: 6,
          background: "var(--green-bg, #143a1e)",
          color: "var(--green, #4ade80)",
          fontSize: "0.8rem",
        }}>
          {message}
        </div>
      )}
    </>
  );
}
