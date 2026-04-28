import { useMemo } from "react";
import type { UIMessage } from "ai";

import { useRunStore } from "../../stores/run-store";
import { usePipelineStore, type ItemProgress, type WorkItem } from "../../stores/pipeline-store";
import {
  isShotDraft,
  selectSession,
  useChatSessionStore,
  type ChatScope,
} from "../../stores/chat-session-store";
import { mediaUrl } from "../../utils/media-url";
import ContextInspector, { type ContextInspectorSection } from "./ContextInspector";

interface Props {
  runId: string;
  scope: ChatScope;
  scopeKey: string;
  sceneNumber: number;
  shotInScene: number;
  messages: UIMessage[];
}

interface AssetRow {
  name: string;
  description: string;
  imagePath: string | null;
}

interface ToolCallEntry {
  toolCallId: string;
  name: string;
  state: string;
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

function pickLatest(items: WorkItem[]): WorkItem | null {
  if (items.length === 0) return null;
  return items.reduce((best, cur) => (best === null || cur.version > best.version ? cur : best), null as WorkItem | null);
}

function pickLatestCompleted(items: WorkItem[]): WorkItem | null {
  return pickLatest(items.filter((i) => i.status === "completed"));
}

function progressLabel(progress: ItemProgress | undefined): string {
  if (!progress) return "Regenerating…";
  if (progress.status === "pending") {
    return progress.queuePosition !== undefined
      ? `Queued (position ${progress.queuePosition})`
      : "Queued";
  }
  if (progress.progress !== undefined) {
    const pct = Math.round(progress.progress * 100);
    const stepStr =
      progress.step !== undefined && progress.totalSteps !== undefined
        ? ` · step ${progress.step}/${progress.totalSteps}`
        : "";
    return `Regenerating ${pct}%${stepStr}`;
  }
  return "Regenerating…";
}

function extractToolCalls(messages: UIMessage[]): ToolCallEntry[] {
  const out: ToolCallEntry[] = [];
  for (const m of messages) {
    for (const p of m.parts) {
      const type = (p as { type?: string }).type ?? "";
      if (!type.startsWith("tool-") && !type.startsWith("dynamic-tool-")) continue;
      const part = p as { type: string; toolCallId?: string; state?: string };
      const name = type.startsWith("tool-")
        ? type.slice("tool-".length)
        : type.slice("dynamic-tool-".length);
      out.push({
        toolCallId: part.toolCallId ?? `${m.id}:${name}`,
        name,
        state: part.state ?? "input-available",
      });
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
  messages,
}: Props) {
  const activeRunId = useRunStore((s) => s.activeRunId);
  const assets = usePipelineStore((s) => s.assets);
  const queues = usePipelineStore((s) => s.queues);
  const itemProgress = usePipelineStore((s) => s.itemProgress);
  const session = useChatSessionStore((s) => selectSession(s, runId, scope, scopeKey));

  const liveShot = (session?.scopeContext?.liveShot as Record<string, unknown> | null | undefined) ?? null;
  const storyContext = (session?.scopeContext?.storyContext as {
    title?: string;
    artStyle?: string;
    characters?: string[];
    locations?: string[];
    objects?: string[];
  } | null | undefined) ?? null;
  const draftFields: Record<string, unknown> =
    session && isShotDraft(session.draft) ? session.draft.shotFields : {};
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

  const frameItems = useMemo(
    () => findItemsByKey(queues, `frame:scene:${sceneNumber}:shot:${shotInScene}`),
    [queues, sceneNumber, shotInScene],
  );
  const videoItems = useMemo(
    () => findItemsByKey(queues, `video:scene:${sceneNumber}:shot:${shotInScene}`),
    [queues, sceneNumber, shotInScene],
  );

  const downstream = useMemo(
    () => [...frameItems, ...videoItems],
    [frameItems, videoItems],
  );

  const latestFrame = useMemo(() => pickLatest(frameItems), [frameItems]);
  const latestCompletedFrame = useMemo(() => pickLatestCompleted(frameItems), [frameItems]);
  const latestVideo = useMemo(() => pickLatest(videoItems), [videoItems]);
  const latestCompletedVideo = useMemo(() => pickLatestCompleted(videoItems), [videoItems]);

  const toolCalls = useMemo(() => {
    const all = extractToolCalls(messages);
    return all.slice(-10).reverse();
  }, [messages]);

  const resolvedShot = useMemo(() => {
    if (!liveShot) return null;
    return { ...liveShot, ...draftFields };
  }, [liveShot, draftFields]);

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

  const handleCopyJson = () => {
    if (!resolvedShot) return;
    void navigator.clipboard?.writeText(JSON.stringify(resolvedShot, null, 2));
  };

  const renderNamePool = (label: string, names: string[] | undefined) => (
    <div className="shot-inspector-group" key={label}>
      <div className="shot-inspector-group-label">{label} ({names?.length ?? 0})</div>
      <div className="shot-inspector-name-pool">
        {(names ?? []).length === 0
          ? <span className="shot-inspector-empty">none</span>
          : (names ?? []).map((n) => (
              <span className="shot-inspector-name-chip" key={n}>{n}</span>
            ))}
      </div>
    </div>
  );

  const renderCurrentFrame = () => {
    if (!activeRunId) return null;
    const latest = latestFrame;
    const completed = latestCompletedFrame;
    const isInFlight =
      latest != null && (latest.status === "pending" || latest.status === "in_progress");
    const isFailed = latest != null && latest.status === "failed";
    const thumbItem = completed ?? (isInFlight || isFailed ? null : latest);
    const thumbPath = thumbItem?.outputs?.startPath as string | undefined;
    return (
      <div className="shot-inspector-current-output">
        <div className="shot-inspector-current-output-label">First frame</div>
        {thumbPath ? (
          <div className="shot-inspector-current-thumb">
            <img
              src={mediaUrl(activeRunId, thumbPath)}
              alt={`frame v${thumbItem?.version ?? "?"}`}
              className="shot-inspector-current-img"
            />
            {isInFlight && (
              <div className="shot-inspector-current-overlay">
                <span className="badge badge-in_progress">
                  {progressLabel(latest ? itemProgress[latest.id] : undefined)}
                </span>
              </div>
            )}
            {isFailed && (
              <div className="shot-inspector-current-overlay shot-inspector-current-overlay-failed">
                <span className="badge badge-failed">Failed</span>
                {latest?.error && (
                  <div className="shot-inspector-current-error">{latest.error}</div>
                )}
              </div>
            )}
          </div>
        ) : isInFlight ? (
          <div className="shot-inspector-current-placeholder">
            <span className="badge badge-in_progress">
              {progressLabel(latest ? itemProgress[latest.id] : undefined)}
            </span>
            <div className="shot-inspector-current-placeholder-hint">
              Generating first version…
            </div>
          </div>
        ) : isFailed ? (
          <div className="shot-inspector-current-placeholder">
            <span className="badge badge-failed">Failed</span>
            {latest?.error && (
              <div className="shot-inspector-current-error">{latest.error}</div>
            )}
          </div>
        ) : (
          <div className="shot-inspector-empty">No frame yet.</div>
        )}
      </div>
    );
  };

  const renderCurrentVideo = () => {
    if (!activeRunId) return null;
    const latest = latestVideo;
    const completed = latestCompletedVideo;
    const isInFlight =
      latest != null && (latest.status === "pending" || latest.status === "in_progress");
    const isFailed = latest != null && latest.status === "failed";
    const videoItem = completed ?? (isInFlight || isFailed ? null : latest);
    const videoPath = videoItem?.outputs?.path as string | undefined;
    const posterPath = latestCompletedFrame?.outputs?.startPath as string | undefined;
    return (
      <div className="shot-inspector-current-output">
        <div className="shot-inspector-current-output-label">Video</div>
        {videoPath ? (
          <div className="shot-inspector-current-thumb">
            <video
              controls
              className="shot-inspector-current-video"
              poster={posterPath ? mediaUrl(activeRunId, posterPath) : undefined}
            >
              <source src={mediaUrl(activeRunId, videoPath)} />
            </video>
            {isInFlight && (
              <div className="shot-inspector-current-overlay">
                <span className="badge badge-in_progress">
                  {progressLabel(latest ? itemProgress[latest.id] : undefined)}
                </span>
              </div>
            )}
            {isFailed && (
              <div className="shot-inspector-current-overlay shot-inspector-current-overlay-failed">
                <span className="badge badge-failed">Failed</span>
                {latest?.error && (
                  <div className="shot-inspector-current-error">{latest.error}</div>
                )}
              </div>
            )}
          </div>
        ) : isInFlight ? (
          <div className="shot-inspector-current-placeholder">
            <span className="badge badge-in_progress">
              {progressLabel(latest ? itemProgress[latest.id] : undefined)}
            </span>
            <div className="shot-inspector-current-placeholder-hint">
              Generating first version…
            </div>
          </div>
        ) : isFailed ? (
          <div className="shot-inspector-current-placeholder">
            <span className="badge badge-failed">Failed</span>
            {latest?.error && (
              <div className="shot-inspector-current-error">{latest.error}</div>
            )}
          </div>
        ) : (
          <div className="shot-inspector-empty">No video yet.</div>
        )}
      </div>
    );
  };

  const sections: ContextInspectorSection[] = [
    {
      id: "current-outputs",
      title: "Current outputs",
      defaultOpen: true,
      render: () => (
        <div className="shot-inspector-current-outputs">
          {renderCurrentFrame()}
          {renderCurrentVideo()}
        </div>
      ),
    },
    {
      id: "context",
      title: "Context",
      defaultOpen: true,
      render: () => (
        <>
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
        </>
      ),
    },
    {
      id: "story-context",
      title: "Story-wide context",
      render: () => (
        storyContext ? (
          <>
            <div className="shot-inspector-group">
              <div className="shot-inspector-group-label">Title</div>
              <div className="shot-inspector-asset-name">{storyContext.title ?? "—"}</div>
            </div>
            <div className="shot-inspector-group">
              <div className="shot-inspector-group-label">Art Style</div>
              <div className="shot-inspector-asset-desc">{storyContext.artStyle ?? "—"}</div>
            </div>
            {renderNamePool("Characters", storyContext.characters)}
            {renderNamePool("Locations", storyContext.locations)}
            {renderNamePool("Objects", storyContext.objects)}
          </>
        ) : (
          <div className="shot-inspector-empty">Story context not loaded yet.</div>
        )
      ),
    },
    {
      id: "intermediates",
      title: `Intermediates (${intermediates.length})`,
      defaultOpen: intermediates.length > 0,
      render: () => (
        intermediates.length === 0 ? (
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
        )
      ),
    },
  ];

  sections.push({
    id: "downstream",
    title: `Downstream impact (${downstream.length})`,
    defaultOpen: true,
    render: () => (
      downstream.length === 0 ? (
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
      )
    ),
  });

  sections.push({
    id: "tool-timeline",
    title: `Tool calls (${toolCalls.length})`,
    render: () => (
      toolCalls.length === 0 ? (
        <div className="shot-inspector-empty">No tool calls yet.</div>
      ) : (
        <ul className="shot-inspector-toolcalls">
          {toolCalls.map((t) => (
            <li key={t.toolCallId}>
              <span className={`chat-tool-state state-${t.state}`}>{t.state}</span>
              <code>{t.name}</code>
            </li>
          ))}
        </ul>
      )
    ),
  });

  sections.push({
    id: "resolved-json",
    title: "Resolved scope (JSON)",
    render: () => (
      resolvedShot ? (
        <div className="shot-inspector-json-wrap">
          <button
            type="button"
            className="secondary shot-inspector-json-copy"
            onClick={handleCopyJson}
          >
            Copy JSON
          </button>
          <pre className="shot-inspector-json">{JSON.stringify(resolvedShot, null, 2)}</pre>
        </div>
      ) : (
        <div className="shot-inspector-empty">Live shot not loaded yet.</div>
      )
    ),
  });

  return <ContextInspector sections={sections} />;
}

