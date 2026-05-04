import { useMemo, type ReactElement } from "react";
import type { UIMessage } from "ai";

import { useRunStore } from "../../stores/run-store";
import { usePipelineStore, type ItemProgress, type WorkItem } from "../../stores/pipeline-store";
import {
  isCharacterDraft,
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

const CHARACTER_FIELD_LABELS: Record<string, string> = {
  name: "Name",
  physicalDescription: "Physical description",
  personality: "Personality",
  ageRange: "Age range",
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

export default function CharacterInspector({ runId, scope, scopeKey, messages }: Props) {
  const activeRunId = useRunStore((s) => s.activeRunId);
  const assets = usePipelineStore((s) => s.assets);
  const queues = usePipelineStore((s) => s.queues);
  const itemProgress = usePipelineStore((s) => s.itemProgress);
  const session = useChatSessionStore((s) => selectSession(s, runId, scope, scopeKey));

  const liveCharacter =
    (session?.scopeContext?.liveCharacter as Record<string, unknown> | null | undefined) ?? null;
  const storyContext = (session?.scopeContext?.storyContext as {
    title?: string;
    artStyle?: string;
    characters?: string[];
    locations?: string[];
    objects?: string[];
  } | null | undefined) ?? null;
  const downstream = (session?.scopeContext?.downstream as DownstreamItem[] | undefined) ?? [];
  const draftFields: Record<string, unknown> =
    session && isCharacterDraft(session.draft) ? session.draft.characterFields : {};
  const pendingReferenceImage =
    session && isCharacterDraft(session.draft) ? session.draft.pendingReferenceImage : null;
  const previewArtifacts =
    session && isCharacterDraft(session.draft) ? session.draft.previewArtifacts : undefined;
  const intermediates = session?.intermediates ?? [];

  const toolCalls = useMemo(() => {
    const all = extractToolCalls(messages);
    return all.slice(-10).reverse();
  }, [messages]);

  const resolvedCharacter = useMemo(() => {
    if (!liveCharacter) return null;
    return { ...liveCharacter, ...draftFields };
  }, [liveCharacter, draftFields]);

  // Per-field diffs between draft and canonical for inline Proposed rows.
  const proposedField = (key: string): unknown | null => {
    if (!(key in draftFields)) return null;
    const proposed = draftFields[key];
    if (shallowEqual(proposed, liveCharacter?.[key])) return null;
    return proposed;
  };
  const proposedName = proposedField("name");
  const proposedPhysicalDescription = proposedField("physicalDescription");
  const proposedPersonality = proposedField("personality");
  const proposedAgeRange = proposedField("ageRange");

  // Other (non-canonical) draft fields, surfaced as a list.
  const pendingScalarFields = useMemo(() => {
    const skip = new Set(["name", "physicalDescription", "personality", "ageRange"]);
    const out: { key: string; label: string; canonical: unknown; proposed: unknown }[] = [];
    for (const key of Object.keys(draftFields)) {
      if (skip.has(key)) continue;
      const proposed = draftFields[key];
      const canonical = liveCharacter?.[key];
      if (shallowEqual(proposed, canonical)) continue;
      out.push({
        key,
        label: CHARACTER_FIELD_LABELS[key] ?? key,
        canonical,
        proposed,
      });
    }
    return out;
  }, [draftFields, liveCharacter]);

  const characterName = (liveCharacter?.name as string | undefined) ?? scopeKey;
  const characterAsset = useMemo(
    () => assets?.characters.find((c) => c.name === characterName) ?? null,
    [assets, characterName],
  );
  const characterItems = useMemo(
    () => findItemsByKey(queues, `asset:character:${characterName}:front`),
    [queues, characterName],
  );
  const latestCharacterItem = useMemo(() => pickLatest(characterItems), [characterItems]);
  const isCharacterInFlight =
    latestCharacterItem != null &&
    (latestCharacterItem.status === "pending" || latestCharacterItem.status === "in_progress");
  const isCharacterFailed =
    latestCharacterItem != null && latestCharacterItem.status === "failed";

  const handleCopyJson = () => {
    if (!resolvedCharacter) return;
    void navigator.clipboard?.writeText(JSON.stringify(resolvedCharacter, null, 2));
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

  const sections: ContextInspectorSection[] = buildSections({
    activeRunId,
    characterName,
    characterAsset,
    isCharacterInFlight,
    isCharacterFailed,
    latestCharacterItem,
    itemProgress,
    previewArtifacts,
    liveCharacter,
    proposedName,
    proposedPhysicalDescription,
    proposedPersonality,
    proposedAgeRange,
    pendingScalarFields,
    draftFields,
    pendingReferenceImage,
    storyContext,
    downstream,
    intermediates,
    toolCalls,
    resolvedCharacter,
    handleCopyJson,
    renderNamePool,
  });

  return <ContextInspector sections={sections} />;
}


interface BuildSectionsArgs {
  activeRunId: string | null;
  characterName: string;
  characterAsset: { imagePath: string | null } | null;
  isCharacterInFlight: boolean;
  isCharacterFailed: boolean;
  latestCharacterItem: WorkItem | null;
  itemProgress: Record<string, ItemProgress>;
  previewArtifacts:
    | { referenceImage?: { sandboxPath: string; createdAt: string; inputsHash: string } }
    | undefined;
  liveCharacter: Record<string, unknown> | null;
  proposedName: unknown | null;
  proposedPhysicalDescription: unknown | null;
  proposedPersonality: unknown | null;
  proposedAgeRange: unknown | null;
  pendingScalarFields: { key: string; label: string; canonical: unknown; proposed: unknown }[];
  draftFields: Record<string, unknown>;
  pendingReferenceImage: { path: string } | null;
  storyContext: {
    title?: string;
    artStyle?: string;
    characters?: string[];
    locations?: string[];
    objects?: string[];
  } | null;
  downstream: DownstreamItem[];
  intermediates: { kind: string; path: string; createdAt: string }[];
  toolCalls: ToolCallEntry[];
  resolvedCharacter: Record<string, unknown> | null;
  handleCopyJson: () => void;
  renderNamePool: (label: string, names: string[] | undefined) => ReactElement;
}


function buildSections(args: BuildSectionsArgs): ContextInspectorSection[] {
  const {
    activeRunId, characterName, characterAsset,
    isCharacterInFlight, isCharacterFailed, latestCharacterItem, itemProgress,
    previewArtifacts, liveCharacter,
    proposedName, proposedPhysicalDescription, proposedPersonality, proposedAgeRange,
    pendingScalarFields, draftFields, pendingReferenceImage,
    storyContext, downstream, intermediates, toolCalls, resolvedCharacter,
    handleCopyJson, renderNamePool,
  } = args;

  return [
    {
      id: "current-outputs",
      title: "Current outputs",
      defaultOpen: true,
      render: () => (
        <div className="shot-inspector-current-outputs">
          <div className="shot-inspector-current-output">
            <div className="shot-inspector-current-output-label">Reference image</div>
            {characterAsset?.imagePath && activeRunId ? (
              <div className="shot-inspector-current-thumb">
                <img
                  src={mediaUrl(activeRunId, characterAsset.imagePath)}
                  alt={characterName || "character"}
                  className="shot-inspector-current-img"
                />
                {isCharacterInFlight && (
                  <div className="shot-inspector-current-overlay">
                    <span className="badge badge-in_progress">
                      {progressLabel(
                        latestCharacterItem ? itemProgress[latestCharacterItem.id] : undefined,
                      )}
                    </span>
                  </div>
                )}
                {isCharacterFailed && (
                  <div className="shot-inspector-current-overlay shot-inspector-current-overlay-failed">
                    <span className="badge badge-failed">Failed</span>
                    {latestCharacterItem?.error && (
                      <div className="shot-inspector-current-error">
                        {latestCharacterItem.error}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : isCharacterInFlight ? (
              <div className="shot-inspector-current-placeholder">
                <span className="badge badge-in_progress">
                  {progressLabel(
                    latestCharacterItem ? itemProgress[latestCharacterItem.id] : undefined,
                  )}
                </span>
                <div className="shot-inspector-current-placeholder-hint">
                  Generating first version…
                </div>
              </div>
            ) : isCharacterFailed ? (
              <div className="shot-inspector-current-placeholder">
                <span className="badge badge-failed">Failed</span>
                {latestCharacterItem?.error && (
                  <div className="shot-inspector-current-error">
                    {latestCharacterItem.error}
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
      id: "live-character",
      title: "Live character",
      defaultOpen: true,
      render: () => (
        <>
          <dl className="inspector-dl">
            <dt>Name</dt>
            <dd>{(liveCharacter?.name as string | undefined) ?? "—"}</dd>
            {proposedName !== null && (
              <dd>
                <div className="shot-inspector-proposed-row">
                  <span className="shot-inspector-proposed-label">Proposed</span>
                  {formatScalar(proposedName) || <em className="shot-inspector-pending-canonical-empty">(empty)</em>}
                </div>
              </dd>
            )}
            <dt>Physical description</dt>
            <dd style={{ whiteSpace: "pre-wrap" }}>
              {(liveCharacter?.physicalDescription as string | undefined) ?? "—"}
            </dd>
            {proposedPhysicalDescription !== null && (
              <dd>
                <div className="shot-inspector-proposed-row">
                  <span className="shot-inspector-proposed-label">Proposed</span>
                  {formatScalar(proposedPhysicalDescription) || <em className="shot-inspector-pending-canonical-empty">(empty)</em>}
                </div>
              </dd>
            )}
            <dt>Personality</dt>
            <dd style={{ whiteSpace: "pre-wrap" }}>
              {(liveCharacter?.personality as string | undefined) ?? "—"}
            </dd>
            {proposedPersonality !== null && (
              <dd>
                <div className="shot-inspector-proposed-row">
                  <span className="shot-inspector-proposed-label">Proposed</span>
                  {formatScalar(proposedPersonality) || <em className="shot-inspector-pending-canonical-empty">(empty)</em>}
                </div>
              </dd>
            )}
            <dt>Age range</dt>
            <dd>{(liveCharacter?.ageRange as string | undefined) ?? "—"}</dd>
            {proposedAgeRange !== null && (
              <dd>
                <div className="shot-inspector-proposed-row">
                  <span className="shot-inspector-proposed-label">Proposed</span>
                  {formatScalar(proposedAgeRange) || <em className="shot-inspector-pending-canonical-empty">(empty)</em>}
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
            {JSON.stringify({ characterFields: draftFields, pendingReferenceImage }, null, 2)}
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
          <div className="shot-inspector-empty">No active items reference this character.</div>
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
        resolvedCharacter ? (
          <div className="shot-inspector-json-wrap">
            <button
              type="button"
              className="secondary shot-inspector-json-copy"
              onClick={handleCopyJson}
            >
              Copy JSON
            </button>
            <pre className="shot-inspector-json">{JSON.stringify(resolvedCharacter, null, 2)}</pre>
          </div>
        ) : (
          <div className="shot-inspector-empty">Live character not loaded yet.</div>
        )
      ),
    },
  ];
}
