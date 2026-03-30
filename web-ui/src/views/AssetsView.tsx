import { useEffect, useState, useCallback } from "react";
import { usePipelineStore, type AssetEntry } from "../stores/pipeline-store";
import { useRunStore } from "../stores/run-store";
import AssetReplace from "../components/AssetReplace";

function AssetCard({ asset, runId }: { asset: AssetEntry; runId: string }) {
  const [expanded, setExpanded] = useState(false);
  const fetchAssets = usePipelineStore((s) => s.fetchAssets);
  const imgSrc = asset.imagePath
    ? `/api/runs/${runId}/media/${asset.imagePath}`
    : null;

  const handleUploaded = useCallback(() => {
    fetchAssets(runId);
  }, [fetchAssets, runId]);

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
        {desc && (
          <div
            style={{ fontSize: "0.8rem", color: "var(--muted)", cursor: desc.length > 120 ? "pointer" : "default" }}
            onClick={() => desc.length > 120 && setExpanded(!expanded)}
          >
            {truncated ? desc.slice(0, 120) + "…" : desc}
          </div>
        )}
        <AssetReplace assetKey={asset.assetKey} label={asset.name} onSuccess={handleUploaded} />
      </div>
    </div>
  );
}

function AssetSection({ title, assets, runId }: { title: string; assets: AssetEntry[]; runId: string }) {
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
          <AssetCard key={asset.assetKey} asset={asset} runId={runId} />
        ))}
      </div>
    </div>
  );
}

export default function AssetsView() {
  const activeRunId = useRunStore((s) => s.activeRunId);
  const assets = usePipelineStore((s) => s.assets);
  const fetchAssets = usePipelineStore((s) => s.fetchAssets);

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
      <AssetSection title="Objects" assets={assets.objects} runId={activeRunId} />
    </div>
  );
}
