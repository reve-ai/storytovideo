import { useMemo } from "react";
import type { UIMessage } from "ai";

import { useRunStore } from "../../stores/run-store";
import {
  isLocationDraft,
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
  const intermediates = session?.intermediates ?? [];

  const toolCalls = useMemo(() => {
    const all = extractToolCalls(messages);
    return all.slice(-10).reverse();
  }, [messages]);

  const resolvedLocation = useMemo(() => {
    if (!liveLocation) return null;
    return { ...liveLocation, ...draftFields };
  }, [liveLocation, draftFields]);

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
      id: "live-location",
      title: "Live location",
      defaultOpen: true,
      render: () => (
        <dl className="inspector-dl">
          <dt>Name</dt>
          <dd>{(liveLocation?.name as string | undefined) ?? "—"}</dd>
          <dt>Visual description</dt>
          <dd style={{ whiteSpace: "pre-wrap" }}>
            {(liveLocation?.visualDescription as string | undefined) ?? "—"}
          </dd>
        </dl>
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
