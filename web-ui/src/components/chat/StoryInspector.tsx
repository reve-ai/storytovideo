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

  const sections: ContextInspectorSection[] = [
    {
      id: "live-story",
      title: "Live story",
      defaultOpen: true,
      render: () => (
        <dl className="inspector-dl">
          <dt>Title</dt>
          <dd>{liveStory?.title ?? "—"}</dd>
          <dt>Art style</dt>
          <dd style={{ whiteSpace: "pre-wrap" }}>{liveStory?.artStyle ?? "—"}</dd>
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
