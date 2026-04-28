import { useMemo } from "react";

import { useRunStore } from "../../stores/run-store";
import { usePipelineStore, type WorkItem } from "../../stores/pipeline-store";
import {
  selectSession,
  useChatSessionStore,
  type ChatScope,
} from "../../stores/chat-session-store";
import { mediaUrl } from "../../utils/media-url";

interface Props {
  runId: string;
  scope: ChatScope;
  scopeKey: string;
  sceneNumber: number;
  shotInScene: number;
}

interface AssetRow {
  name: string;
  description: string;
  imagePath: string | null;
}

function findItemsByKey(
  queues: ReturnType<typeof usePipelineStore.getState>["queues"],
  itemKey: string,
): WorkItem[] {
  const out: WorkItem[] = [];
  for (const qName of ["llm", "image", "video"] as const) {
    const q = queues[qName];
    if (!q) continue;
    for (const group of [q.inProgress, q.pending, q.completed, q.failed]) {
      for (const item of group) {
        if (item.itemKey === itemKey && item.status !== "superseded") out.push(item);
      }
    }
  }
  return out;
}

export default function ShotInspector({
  runId,
  scope,
  scopeKey,
  sceneNumber,
  shotInScene,
}: Props) {
  const activeRunId = useRunStore((s) => s.activeRunId);
  const assets = usePipelineStore((s) => s.assets);
  const queues = usePipelineStore((s) => s.queues);
  const session = useChatSessionStore((s) => selectSession(s, runId, scope, scopeKey));

  const liveShot = (session?.scopeContext?.liveShot as Record<string, unknown> | null | undefined) ?? null;
  const draftFields = session?.draft?.shotFields ?? {};
  const intermediates = session?.intermediates ?? [];

  const characterNames = (draftFields.charactersPresent as string[] | undefined)
    ?? (liveShot?.charactersPresent as string[] | undefined) ?? [];
  const objectNames = (draftFields.objectsPresent as string[] | undefined)
    ?? (liveShot?.objectsPresent as string[] | undefined) ?? [];
  const locationName = (draftFields.location as string | undefined)
    ?? (liveShot?.location as string | undefined) ?? "";

  const characters: AssetRow[] = useMemo(
    () => characterNames.map((n) => {
      const a = assets?.characters.find((c) => c.name === n);
      return { name: n, description: a?.description ?? "", imagePath: a?.imagePath ?? null };
    }),
    [characterNames, assets],
  );
  const objects: AssetRow[] = useMemo(
    () => objectNames.map((n) => {
      const a = assets?.objects.find((c) => c.name === n);
      return { name: n, description: a?.description ?? "", imagePath: a?.imagePath ?? null };
    }),
    [objectNames, assets],
  );
  const location: AssetRow | null = useMemo(() => {
    if (!locationName) return null;
    const a = assets?.locations.find((l) => l.name === locationName);
    return { name: locationName, description: a?.description ?? "", imagePath: a?.imagePath ?? null };
  }, [locationName, assets]);

  const downstream = useMemo(() => {
    const frameKey = `frame:scene:${sceneNumber}:shot:${shotInScene}`;
    const videoKey = `video:scene:${sceneNumber}:shot:${shotInScene}`;
    return [
      ...findItemsByKey(queues, frameKey),
      ...findItemsByKey(queues, videoKey),
    ];
  }, [queues, sceneNumber, shotInScene]);

  const renderAsset = (row: AssetRow, label: string) => (
    <div className="shot-inspector-asset" key={`${label}-${row.name}`}>
      {row.imagePath && activeRunId && (
        <img
          src={mediaUrl(activeRunId, row.imagePath)}
          alt={row.name}
          className="shot-inspector-asset-img"
        />
      )}
      <div className="shot-inspector-asset-text">
        <div className="shot-inspector-asset-name">{row.name}</div>
        {row.description && (
          <div className="shot-inspector-asset-desc">{row.description}</div>
        )}
      </div>
    </div>
  );

  return (
    <div className="shot-inspector">
      <details className="shot-inspector-section" open>
        <summary>Context</summary>
        {location && (
          <div className="shot-inspector-group">
            <div className="shot-inspector-group-label">Location</div>
            {renderAsset(location, "loc")}
          </div>
        )}
        {characters.length > 0 && (
          <div className="shot-inspector-group">
            <div className="shot-inspector-group-label">Characters</div>
            {characters.map((c) => renderAsset(c, "char"))}
          </div>
        )}
        {objects.length > 0 && (
          <div className="shot-inspector-group">
            <div className="shot-inspector-group-label">Objects</div>
            {objects.map((o) => renderAsset(o, "obj"))}
          </div>
        )}
        {!location && characters.length === 0 && objects.length === 0 && (
          <div className="shot-inspector-empty">No characters, objects, or location set.</div>
        )}
      </details>

      <details className="shot-inspector-section" open={intermediates.length > 0}>
        <summary>Intermediates ({intermediates.length})</summary>
        {intermediates.length === 0 ? (
          <div className="shot-inspector-empty">
            Frames or videos generated in this chat session will appear here.
          </div>
        ) : (
          <div className="shot-inspector-intermediates">
            {intermediates.map((it, i) => (
              <div className="shot-inspector-intermediate" key={`${it.path}-${i}`}>
                {activeRunId && it.kind === "frame" && (
                  <img src={mediaUrl(activeRunId, it.path)} alt="frame" />
                )}
                {activeRunId && it.kind === "video" && (
                  <video controls>
                    <source src={mediaUrl(activeRunId, it.path)} />
                  </video>
                )}
                <div className="shot-inspector-intermediate-meta">
                  <span>{it.kind}</span>
                  <span>{new Date(it.createdAt).toLocaleTimeString()}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </details>

      <details className="shot-inspector-section" open>
        <summary>Downstream impact ({downstream.length})</summary>
        {downstream.length === 0 ? (
          <div className="shot-inspector-empty">No active pipeline items for this shot.</div>
        ) : (
          <ul className="shot-inspector-downstream">
            {downstream.map((d) => (
              <li key={d.id}>
                <span className={`badge badge-${d.status}`}>{d.status}</span>
                <code>{d.type}</code>
                <span className="shot-inspector-downstream-key">{d.itemKey}</span>
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}
