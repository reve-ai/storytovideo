import { useMemo } from "react";
import type { UIMessage } from "ai";

import {
  isSceneDraft,
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

const SCENE_FIELD_LABELS: Record<string, string> = {
  title: "Title",
  narrativeSummary: "Narrative summary",
  location: "Location",
  charactersPresent: "Characters present",
  estimatedDurationSeconds: "Estimated duration seconds",
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
      });
    }
  }
  return out;
}

export default function SceneInspector({ runId, scope, scopeKey, messages }: Props) {
  const session = useChatSessionStore((s) => selectSession(s, runId, scope, scopeKey));

  const liveScene =
    (session?.scopeContext?.liveScene as Record<string, unknown> | null | undefined) ?? null;
  const stats =
    (session?.scopeContext?.stats as
      | { shotCount: number; framesGenerated: number; videosGenerated: number }
      | null
      | undefined) ?? null;
  const draftFields: Record<string, unknown> =
    session && isSceneDraft(session.draft) ? session.draft.sceneFields : {};

  const toolCalls = useMemo(() => getToolCalls(messages), [messages]);

  const pendingFields = useMemo(() => {
    return Object.keys(SCENE_FIELD_LABELS).flatMap((key) => {
      if (!(key in draftFields)) return [];
      const proposed = draftFields[key];
      const canonical = liveScene?.[key];
      if (shallowEqual(proposed, canonical)) return [];
      return [{ key, label: SCENE_FIELD_LABELS[key], canonical, proposed }];
    });
  }, [draftFields, liveScene]);

  const renderField = (key: string, multiline = false) => {
    const value = formatScalar(liveScene?.[key]);
    const pending = pendingFields.find((f) => f.key === key);
    return (
      <>
        <dt>{SCENE_FIELD_LABELS[key]}</dt>
        <dd style={multiline ? { whiteSpace: "pre-wrap" } : undefined}>{value || "—"}</dd>
        {pending && (
          <dd>
            <div className="shot-inspector-proposed-row">
              <span className="shot-inspector-proposed-label">Proposed</span>
              {formatScalar(pending.proposed) || <em className="shot-inspector-pending-canonical-empty">(empty)</em>}
            </div>
          </dd>
        )}
      </>
    );
  };

  const sections: ContextInspectorSection[] = [
    {
      id: "live-scene",
      title: "Live scene",
      defaultOpen: true,
      render: () => (
        <>
          {stats && (
            <div className="shot-inspector-chip" style={{ marginBottom: 8 }}>
              {stats.shotCount} shots · {stats.framesGenerated} frames · {stats.videosGenerated} videos
            </div>
          )}
          <dl className="inspector-dl">
            {renderField("title")}
            {renderField("narrativeSummary", true)}
            {renderField("location")}
            {renderField("charactersPresent")}
            {renderField("estimatedDurationSeconds")}
          </dl>
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