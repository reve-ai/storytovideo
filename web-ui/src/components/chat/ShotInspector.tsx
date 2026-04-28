import { useMemo } from "react";
import type { UIMessage } from "ai";

import { useRunStore } from "../../stores/run-store";
import { usePipelineStore, type WorkItem } from "../../stores/pipeline-store";
import {
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
  const session = useChatSessionStore((s) => selectSession(s, runId, scope, scopeKey));

  const liveShot = (session?.scopeContext?.liveShot as Record<string, unknown> | null | undefined) ?? null;
  const storyContext = (session?.scopeContext?.storyContext as {
    title?: string;
    artStyle?: string;
    characters?: string[];
    locations?: string[];
    objects?: string[];
  } | null | undefined) ?? null;
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

  const sections: ContextInspectorSection[] = [
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

