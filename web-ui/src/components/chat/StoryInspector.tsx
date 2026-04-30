import { useMemo } from "react";
import type { UIMessage } from "ai";

import {
  isStoryDraft,
  selectSession,
  useChatSessionStore,
  type ChatScope,
} from "../../stores/chat-session-store";
import ContextInspector, { type ContextInspectorSection } from "./ContextInspector";

interface Props {
  runId: string;
  scope: ChatScope;
  scopeKey: string;
  messages: UIMessage[];
}

interface ToolCallEntry {
  toolCallId: string;
  toolName: string;
  state: string;
  input?: unknown;
  output?: unknown;
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

const STORY_FIELD_LABELS: Record<string, string> = {
  title: "Title",
  artStyle: "Art style",
};

function getToolCalls(messages: UIMessage[]): ToolCallEntry[] {
  const out: ToolCallEntry[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const parts = (m as unknown as { parts?: unknown[] }).parts ?? [];
    for (const p of parts) {
      const part = p as Record<string, unknown>;
      const type = String(part.type ?? "");
      if (!type.startsWith("tool-")) continue;
      out.push({
        toolCallId: String(part.toolCallId ?? ""),
        toolName: type.slice("tool-".length),
        state: String(part.state ?? ""),
        input: part.input,
        output: part.output,
      });
    }
  }
  return out;
}

export default function StoryInspector({ runId, scope, scopeKey, messages }: Props) {
  const session = useChatSessionStore((s) => selectSession(s, runId, scope, scopeKey));

  const liveStory =
    (session?.scopeContext?.liveStory as { title?: string; artStyle?: string } | null | undefined) ??
    null;
  const stats =
    (session?.scopeContext?.stats as
      | { sceneCount: number; shotCount: number; characterCount: number; locationCount: number; objectCount: number }
      | null
      | undefined) ?? null;
  const draftFields: Record<string, unknown> =
    session && isStoryDraft(session.draft) ? session.draft.storyFields : {};

  const toolCalls = useMemo(() => getToolCalls(messages), [messages]);

  const proposedField = (key: string): unknown | null => {
    if (!(key in draftFields)) return null;
    const proposed = draftFields[key];
    if (shallowEqual(proposed, (liveStory as Record<string, unknown> | null)?.[key])) return null;
    return proposed;
  };
  const proposedTitle = proposedField("title");
  const proposedArtStyle = proposedField("artStyle");

  const pendingScalarFields = (() => {
    const skip = new Set(["title", "artStyle"]);
    const out: { key: string; label: string; canonical: unknown; proposed: unknown }[] = [];
    for (const key of Object.keys(draftFields)) {
      if (skip.has(key)) continue;
      const proposed = draftFields[key];
      const canonical = (liveStory as Record<string, unknown> | null)?.[key];
      if (shallowEqual(proposed, canonical)) continue;
      out.push({
        key,
        label: STORY_FIELD_LABELS[key] ?? key,
        canonical,
        proposed,
      });
    }
    return out;
  })();

  const sections: ContextInspectorSection[] = [
    {
      id: "live-story",
      title: "Live story",
      defaultOpen: true,
      render: () => (
        <>
          <dl className="inspector-dl">
            <dt>Title</dt>
            <dd>{liveStory?.title ?? "—"}</dd>
            {proposedTitle !== null && (
              <dd>
                <div className="shot-inspector-proposed-row">
                  <span className="shot-inspector-proposed-label">Proposed</span>
                  {formatScalar(proposedTitle) || <em className="shot-inspector-pending-canonical-empty">(empty)</em>}
                </div>
              </dd>
            )}
            <dt>Art style</dt>
            <dd style={{ whiteSpace: "pre-wrap" }}>{liveStory?.artStyle ?? "—"}</dd>
            {proposedArtStyle !== null && (
              <dd>
                <div className="shot-inspector-proposed-row">
                  <span className="shot-inspector-proposed-label">Proposed</span>
                  {formatScalar(proposedArtStyle) || <em className="shot-inspector-pending-canonical-empty">(empty)</em>}
                </div>
              </dd>
            )}
            {stats && (
              <>
                <dt>Stats</dt>
                <dd>
                  {stats.sceneCount} scenes · {stats.shotCount} shots · {stats.characterCount}{" "}
                  characters · {stats.locationCount} locations · {stats.objectCount} objects
                </dd>
              </>
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
      title: `Draft (${Object.keys(draftFields).length} field${Object.keys(draftFields).length === 1 ? "" : "s"})`,
      defaultOpen: Object.keys(draftFields).length > 0,
      render: () =>
        Object.keys(draftFields).length === 0 ? (
          <div className="inspector-empty">No staged changes.</div>
        ) : (
          <pre className="inspector-pre">{JSON.stringify(draftFields, null, 2)}</pre>
        ),
    },
    {
      id: "tool-calls",
      title: `Tool calls (${toolCalls.length})`,
      render: () =>
        toolCalls.length === 0 ? (
          <div className="inspector-empty">No tool calls yet.</div>
        ) : (
          <ul className="inspector-tool-list">
            {toolCalls.map((tc) => (
              <li key={tc.toolCallId}>
                <code>{tc.toolName}</code> <span className="muted">[{tc.state}]</span>
              </li>
            ))}
          </ul>
        ),
    },
  ];

  return <ContextInspector sections={sections} />;
}
