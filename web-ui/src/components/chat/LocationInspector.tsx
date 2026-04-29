import { useMemo } from "react";
import type { UIMessage } from "ai";

import { useRunStore } from "../../stores/run-store";
import { usePipelineStore, type ItemProgress, type WorkItem } from "../../stores/pipeline-store";
import {
  isLocationDraft,
  selectSession,
  useChatSessionStore,
  type ChatScope,
} from "../../stores/chat-session-store";
import { mediaUrl } from "../../utils/media-url";
import ContextInspector, { type ContextInspectorSection } from "./ContextInspector";

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

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  return false;
}

function formatScalar(v: unknown): string {
  if (v === undefined || v === null || v === "") return "";
  if (Array.isArray(v)) return (v as unknown[]).map(String).join(", ");
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

const LOCATION_FIELD_LABELS: Record<string, string> = {
  name: "Name",
  visualDescription: "Visual description",
};

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

interface Props {
  runId: string;
  scope: ChatScope;
  scopeKey: string;
  messages: UIMessage[];
}

interface ToolCallEntry {
  toolCallId: string;
  name: string;
  state: string;
}

interface DownstreamItem {
  id: string;
  itemKey: string;
  type: string;
  status: string;
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

export default function LocationInspector({ runId, scope, scopeKey, messages }: Props) {
  const activeRunId = useRunStore((s) => s.activeRunId);
  const assets = usePipelineStore((s) => s.assets);
  const queues = usePipelineStore((s) => s.queues);
  const itemProgress = usePipelineStore((s) => s.itemProgress);
  const session = useChatSessionStore((s) => selectSession(s, runId, scope, scopeKey));

  const liveLocation =
    (session?.scopeContext?.liveLocation as Record<string, unknown> | null | undefined) ?? null;
  const storyContext = (session?.scopeContext?.storyContext as {
    title?: string;
    artStyle?: string;
    characters?: string[];
    locations?: string[];
    objects?: string[];
  } | null | undefined) ?? null;
  const downstream = (session?.scopeContext?.downstream as DownstreamItem[] | undefined) ?? [];
  const draftFields: Record<string, unknown> =
    session && isLocationDraft(session.draft) ? session.draft.locationFields : {};
  const pendingReferenceImage =
    session && isLocationDraft(session.draft) ? session.draft.pendingReferenceImage : null;
  const previewArtifacts =
    session && isLocationDraft(session.draft) ? session.draft.previewArtifacts : undefined;
  const intermediates = session?.intermediates ?? [];

  const toolCalls = useMemo(() => {
    const all = extractToolCalls(messages);
    return all.slice(-10).reverse();
  }, [messages]);

  const resolvedLocation = useMemo(() => {
    if (!liveLocation) return null;
    return { ...liveLocation, ...draftFields };
  }, [liveLocation, draftFields]);

  // Per-field diffs between draft and canonical for inline Proposed rows.
  const proposedField = (key: string): unknown | null => {
    if (!(key in draftFields)) return null;
    const proposed = draftFields[key];
    if (shallowEqual(proposed, liveLocation?.[key])) return null;
    return proposed;
  };
  const proposedName = proposedField("name");
  const proposedVisualDescription = proposedField("visualDescription");

  // Other (non-name/visualDescription) draft fields, surfaced as a list.
  const pendingScalarFields = useMemo(() => {
    const skip = new Set(["name", "visualDescription"]);
    const out: { key: string; label: string; canonical: unknown; proposed: unknown }[] = [];
    for (const key of Object.keys(draftFields)) {
      if (skip.has(key)) continue;
      const proposed = draftFields[key];
      const canonical = liveLocation?.[key];
      if (shallowEqual(proposed, canonical)) continue;
      out.push({
        key,
        label: LOCATION_FIELD_LABELS[key] ?? key,
        canonical,
        proposed,
      });
    }
    return out;
  }, [draftFields, liveLocation]);

  const locationName = (liveLocation?.name as string | undefined) ?? scopeKey;
  const locationAsset = useMemo(
    () => assets?.locations.find((l) => l.name === locationName) ?? null,
    [assets, locationName],
  );
  const locationItems = useMemo(
    () => findItemsByKey(queues, `asset:location:${locationName}`),
    [queues, locationName],
  );
  const latestLocationItem = useMemo(() => pickLatest(locationItems), [locationItems]);
  const isLocationInFlight =
    latestLocationItem != null &&
    (latestLocationItem.status === "pending" || latestLocationItem.status === "in_progress");
  const isLocationFailed =
    latestLocationItem != null && latestLocationItem.status === "failed";

  const handleCopyJson = () => {
    if (!resolvedLocation) return;
    void navigator.clipboard?.writeText(JSON.stringify(resolvedLocation, null, 2));
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
      id: "current-outputs",
      title: "Current outputs",
      defaultOpen: true,
      render: () => (
        <div className="shot-inspector-current-outputs">
          <div className="shot-inspector-current-output">
            <div className="shot-inspector-current-output-label">Reference image</div>
            {locationAsset?.imagePath && activeRunId ? (
              <div className="shot-inspector-current-thumb">
                <img
                  src={mediaUrl(activeRunId, locationAsset.imagePath)}
                  alt={locationName || "location"}
                  className="shot-inspector-current-img"
                />
                {isLocationInFlight && (
                  <div className="shot-inspector-current-overlay">
                    <span className="badge badge-in_progress">
                      {progressLabel(
                        latestLocationItem ? itemProgress[latestLocationItem.id] : undefined,
                      )}
                    </span>
                  </div>
                )}
                {isLocationFailed && (
                  <div className="shot-inspector-current-overlay shot-inspector-current-overlay-failed">
                    <span className="badge badge-failed">Failed</span>
                    {latestLocationItem?.error && (
                      <div className="shot-inspector-current-error">
                        {latestLocationItem.error}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : isLocationInFlight ? (
              <div className="shot-inspector-current-placeholder">
                <span className="badge badge-in_progress">
                  {progressLabel(
                    latestLocationItem ? itemProgress[latestLocationItem.id] : undefined,
                  )}
                </span>
                <div className="shot-inspector-current-placeholder-hint">
                  Generating first version…
                </div>
              </div>
            ) : isLocationFailed ? (
              <div className="shot-inspector-current-placeholder">
                <span className="badge badge-failed">Failed</span>
                {latestLocationItem?.error && (
                  <div className="shot-inspector-current-error">
                    {latestLocationItem.error}
                  </div>
                )}
              </div>
            ) : (
              <div className="shot-inspector-empty">No reference image yet.</div>
            )}
          </div>
          {previewArtifacts?.referenceImage && activeRunId && (
            <div className="shot-inspector-current-output">
              <div className="shot-inspector-current-output-label">Proposed reference image</div>
              <div className="shot-inspector-current-thumb">
                <span className="shot-inspector-proposed-badge">Proposed</span>
                <img
                  src={mediaUrl(activeRunId, previewArtifacts.referenceImage.sandboxPath)}
                  alt="proposed reference image"
                  className="shot-inspector-current-img"
                />
              </div>
            </div>
          )}
        </div>
      ),
    },
    {
      id: "live-location",
      title: "Live location",
      defaultOpen: true,
      render: () => (
        <>
          <dl className="inspector-dl">
            <dt>Name</dt>
            <dd>{(liveLocation?.name as string | undefined) ?? "—"}</dd>
            {proposedName !== null && (
              <dd>
                <div className="shot-inspector-proposed-row">
                  <span className="shot-inspector-proposed-label">Proposed</span>
                  {formatScalar(proposedName) || <em className="shot-inspector-pending-canonical-empty">(empty)</em>}
                </div>
              </dd>
            )}
            <dt>Visual description</dt>
            <dd style={{ whiteSpace: "pre-wrap" }}>
              {(liveLocation?.visualDescription as string | undefined) ?? "—"}
            </dd>
            {proposedVisualDescription !== null && (
              <dd>
                <div className="shot-inspector-proposed-row">
                  <span className="shot-inspector-proposed-label">Proposed</span>
                  {formatScalar(proposedVisualDescription) || <em className="shot-inspector-pending-canonical-empty">(empty)</em>}
                </div>
              </dd>
            )}
          </dl>
          {pendingScalarFields.map((f) => {
            const canonicalText = formatScalar(f.canonical);
            const proposedText = formatScalar(f.proposed);
            return (
              <div className="shot-inspector-pending-field" key={f.key}>
                <div className="shot-inspector-group-label">{f.label}</div>
                {canonicalText
                  ? <div className="shot-inspector-pending-canonical">{canonicalText}</div>
                  : <div className="shot-inspector-pending-canonical-empty">(empty)</div>}
                <div className="shot-inspector-proposed-row">
                  <span className="shot-inspector-proposed-label">Proposed</span>
                  {proposedText || <em className="shot-inspector-pending-canonical-empty">(empty)</em>}
                </div>
              </div>
            );
          })}
        </>
      ),
    },
    {
      id: "draft",
      title: `Draft (${Object.keys(draftFields).length + (pendingReferenceImage ? 1 : 0)})`,
      defaultOpen: Object.keys(draftFields).length > 0 || !!pendingReferenceImage,
      render: () => {
        const empty = Object.keys(draftFields).length === 0 && !pendingReferenceImage;
        return empty ? (
          <div className="inspector-empty">No staged changes.</div>
        ) : (
          <pre className="inspector-pre">
            {JSON.stringify({ locationFields: draftFields, pendingReferenceImage }, null, 2)}
          </pre>
        );
      },
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
      id: "downstream",
      title: `Downstream impact (${downstream.length})`,
      defaultOpen: downstream.length > 0,
      render: () => (
        downstream.length === 0 ? (
          <div className="shot-inspector-empty">No active items reference this location.</div>
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
    },
    {
      id: "intermediates",
      title: `Intermediates (${intermediates.length})`,
      defaultOpen: intermediates.length > 0,
      render: () => (
        intermediates.length === 0 ? (
          <div className="shot-inspector-empty">
            Reference images generated in this chat session will appear here.
          </div>
        ) : (
          <div className="shot-inspector-intermediates">
            {intermediates.map((it, i) => (
              <div className="shot-inspector-intermediate" key={`${it.path}-${i}`}>
                {activeRunId && (it.kind === "asset" || it.kind === "frame") && (
                  <img src={mediaUrl(activeRunId, it.path)} alt={it.kind} />
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
    {
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
    },
    {
      id: "resolved-json",
      title: "Resolved scope (JSON)",
      render: () => (
        resolvedLocation ? (
          <div className="shot-inspector-json-wrap">
            <button
              type="button"
              className="secondary shot-inspector-json-copy"
              onClick={handleCopyJson}
            >
              Copy JSON
            </button>
            <pre className="shot-inspector-json">{JSON.stringify(resolvedLocation, null, 2)}</pre>
          </div>
        ) : (
          <div className="shot-inspector-empty">Live location not loaded yet.</div>
        )
      ),
    },
  ];

  return <ContextInspector sections={sections} />;
}
