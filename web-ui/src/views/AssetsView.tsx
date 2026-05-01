import { useEffect, useState, useCallback } from "react";
import { usePipelineStore, type AssetEntry } from "../stores/pipeline-store";
import { useRunStore } from "../stores/run-store";
import { useUIStore } from "../stores/ui-store";
import AssetReplace from "../components/AssetReplace";
import { mediaUrl } from "../utils/media-url";

function AssetCard({ asset, runId, onOpenChat }: { asset: AssetEntry; runId: string; onOpenChat?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editDesc, setEditDesc] = useState(asset.description);
  const [loading, setLoading] = useState(false);
  const fetchAssets = usePipelineStore((s) => s.fetchAssets);
  const redoAsset = usePipelineStore((s) => s.redoAsset);
  const imgSrc = asset.imagePath
    ? mediaUrl(runId, asset.imagePath)
    : null;

  const handleUploaded = useCallback(() => {
    fetchAssets(runId);
  }, [fetchAssets, runId]);

  const handleRegenerate = useCallback(async () => {
    const note = window.prompt("Director's note (optional — leave blank to proceed without):");
    if (note === null) return; // user cancelled
    setLoading(true);
    try {
      await redoAsset(runId, asset.assetKey, undefined, note || undefined);
    } finally {
      setLoading(false);
    }
  }, [redoAsset, runId, asset.assetKey]);

  const handleSaveAndRegenerate = useCallback(async () => {
    const note = window.prompt("Director's note (optional — leave blank to proceed without):");
    if (note === null) return; // user cancelled
    setLoading(true);
    try {
      const ok = await redoAsset(runId, asset.assetKey, editDesc, note || undefined);
      if (ok) setEditing(false);
    } finally {
      setLoading(false);
    }
  }, [redoAsset, runId, asset.assetKey, editDesc]);

  const handleStartEdit = useCallback(() => {
    setEditDesc(asset.description);
    setEditing(true);
  }, [asset.description]);

  const desc = asset.description;
  const truncated = desc.length > 120 && !expanded;

  return (
    <div style={{
      background: "var(--surface)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius)",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
    }}>
      <div style={{
        aspectRatio: "1",
        background: "var(--surface2)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}>
        {imgSrc ? (
          <img
            src={imgSrc}
            alt={asset.name}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
            loading="lazy"
          />
        ) : (
          <span style={{ color: "var(--muted)", fontSize: "2rem" }}>🖼</span>
        )}
      </div>
      <div style={{ padding: "0.75rem" }}>
        <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>{asset.name}</div>
        {editing ? (
          <div style={{ marginBottom: "0.5rem" }}>
            <textarea
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
              rows={4}
              style={{
                width: "100%",
                fontSize: "0.8rem",
                padding: "0.4rem",
                borderRadius: "4px",
                border: "1px solid var(--border)",
                background: "var(--surface2)",
                color: "var(--text)",
                resize: "vertical",
                fontFamily: "inherit",
              }}
            />
            <div style={{ display: "flex", gap: "0.25rem", marginTop: "0.25rem" }}>
              <button
                className="btn btn-xs btn-primary"
                onClick={handleSaveAndRegenerate}
                disabled={loading}
              >
                {loading ? "Saving…" : "Save & Regenerate"}
              </button>
              <button
                className="btn btn-xs"
                onClick={() => setEditing(false)}
                disabled={loading}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            {desc && (
              <div
                style={{ fontSize: "0.8rem", color: "var(--muted)", cursor: desc.length > 120 ? "pointer" : "default" }}
                onClick={() => desc.length > 120 && setExpanded(!expanded)}
              >
                {truncated ? desc.slice(0, 120) + "…" : desc}
              </div>
            )}
          </>
        )}
        <div style={{ display: "flex", gap: "0.25rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
          <button
            className="btn btn-xs"
            onClick={handleRegenerate}
            disabled={loading || editing}
            title="Regenerate this asset image"
          >
            {loading && !editing ? "Regenerating…" : "🔄 Regenerate"}
          </button>
          {!editing && (
            <button
              className="btn btn-xs"
              onClick={handleStartEdit}
              disabled={loading}
              title="Edit description and regenerate"
            >
              ✏️ Edit
            </button>
          )}
          <AssetReplace assetKey={asset.assetKey} label={asset.name} onSuccess={handleUploaded} />
          {onOpenChat && (
            <button
              className="btn btn-xs"
              onClick={onOpenChat}
              disabled={loading}
              title="Open chat to edit this object"
            >
              💬 Chat
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function AssetSection({
  title,
  assets,
  runId,
  onOpenChatFor,
}: {
  title: string;
  assets: AssetEntry[];
  runId: string;
  onOpenChatFor?: (asset: AssetEntry) => void;
}) {
  if (assets.length === 0) return null;
  return (
    <div style={{ marginBottom: "2rem" }}>
      <h2 style={{ fontSize: "1.1rem", marginBottom: "0.75rem", color: "var(--text)" }}>{title}</h2>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
        gap: "1rem",
      }}>
        {assets.map((asset) => (
          <AssetCard
            key={asset.assetKey}
            asset={asset}
            runId={runId}
            onOpenChat={onOpenChatFor ? () => onOpenChatFor(asset) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

export default function AssetsView() {
  const activeRunId = useRunStore((s) => s.activeRunId);
  const assets = usePipelineStore((s) => s.assets);
  const fetchAssets = usePipelineStore((s) => s.fetchAssets);
  const openObjectChat = useUIStore((s) => s.openObjectChat);

  useEffect(() => {
    if (activeRunId) fetchAssets(activeRunId);
  }, [activeRunId, fetchAssets]);

  if (!activeRunId) {
    return <div className="story-empty">Select a run to view assets.</div>;
  }

  if (!assets) {
    return <div className="story-empty">No story analysis available yet. Assets will appear after the story is analyzed.</div>;
  }

  const total = assets.characters.length + assets.locations.length + assets.objects.length;
  if (total === 0) {
    return <div className="story-empty">No assets found in the story analysis.</div>;
  }

  return (
    <div className="p-3">
      <AssetSection title="Characters" assets={assets.characters} runId={activeRunId} />
      <AssetSection title="Locations" assets={assets.locations} runId={activeRunId} />
      <AssetSection
        title="Objects"
        assets={assets.objects}
        runId={activeRunId}
        onOpenChatFor={(asset) => openObjectChat(asset.name)}
      />
    </div>
  );
}
