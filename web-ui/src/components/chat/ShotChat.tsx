import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from "ai";

import { useRunStore } from "../../stores/run-store";
import { useUIStore } from "../../stores/ui-store";
import {
  selectSession,
  useChatSessionStore,
  type ShotDraft,
} from "../../stores/chat-session-store";
import ToolPart, { type ToolPartLike } from "./ToolPart";

interface Props {
  sceneNumber: number;
  shotInScene: number;
}

export default function ShotChat({ sceneNumber, shotInScene }: Props) {
  const activeRunId = useRunStore((s) => s.activeRunId);
  const showToast = useUIStore((s) => s.showToast);
  const scopeKey = `${sceneNumber}-${shotInScene}`;
  const fetchSession = useChatSessionStore((s) => s.fetchSession);
  const applyDraft = useChatSessionStore((s) => s.applyDraft);
  const discardDraft = useChatSessionStore((s) => s.discardDraft);
  const session = useChatSessionStore((s) =>
    selectSession(s, activeRunId, "shot", scopeKey),
  );

  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const apiUrl = activeRunId
    ? `/api/runs/${encodeURIComponent(activeRunId)}/chat/shot/${sceneNumber}/${shotInScene}`
    : "";

  const transport = useMemo(
    () => (apiUrl ? new DefaultChatTransport<UIMessage>({ api: apiUrl }) : undefined),
    [apiUrl],
  );

  const { messages, sendMessage, status, setMessages, error } = useChat({
    id: `shot-${activeRunId ?? "no-run"}-${scopeKey}`,
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  });

  useEffect(() => {
    let cancelled = false;
    if (!activeRunId) return;
    setHydrated(false);
    fetchSession(activeRunId, "shot", scopeKey).then((data) => {
      if (cancelled) return;
      if (data && Array.isArray(data.messages) && data.messages.length > 0) {
        setMessages(data.messages as UIMessage[]);
      } else {
        setMessages([]);
      }
      setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunId, scopeKey]);

  const draft: ShotDraft | null = session?.draft ?? null;
  const draftFieldCount = draft ? Object.keys(draft.shotFields).length : 0;
  const draftImageCount = draft ? draft.pendingImageReplacements.length : 0;
  const hasDraft = draftFieldCount > 0 || draftImageCount > 0;

  const handleSend = async () => {
    if (!input.trim() || !apiUrl) return;
    const text = input;
    setInput("");
    try {
      await sendMessage({ text });
      // Re-fetch the session after the response completes to pick up draft updates.
      if (activeRunId) await fetchSession(activeRunId, "shot", scopeKey);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), "error");
    }
  };

  const handleApply = async () => {
    if (!activeRunId) return;
    setBusy(true);
    const result = await applyDraft(activeRunId, "shot", scopeKey, sceneNumber, shotInScene);
    setBusy(false);
    if (!result.ok) {
      showToast(result.error ?? "Apply failed", "error");
    } else {
      showToast("Applied draft to canonical document", "info");
    }
  };

  const handleDiscard = async () => {
    if (!activeRunId) return;
    setBusy(true);
    const result = await discardDraft(activeRunId, "shot", scopeKey, sceneNumber, shotInScene);
    setBusy(false);
    if (!result.ok) {
      showToast(result.error ?? "Discard failed", "error");
    }
  };

  return (
    <div className="shot-chat">
      <div className="shot-chat-header">
        <div className="shot-chat-title">
          Edit shot {sceneNumber}.{shotInScene}
        </div>
        <div className="shot-chat-actions">
          <button
            className="primary"
            disabled={!hasDraft || busy}
            onClick={handleApply}
            title={hasDraft ? "Apply staged changes to the canonical document" : "No staged changes"}
          >
            Apply{hasDraft ? ` (${draftFieldCount + draftImageCount})` : ""}
          </button>
          <button
            className="secondary"
            disabled={!hasDraft || busy}
            onClick={handleDiscard}
          >
            Discard
          </button>
        </div>
      </div>
      <div className="shot-chat-messages">
        {!hydrated && <div className="shot-chat-empty">Loading session…</div>}
        {hydrated && messages.length === 0 && (
          <div className="shot-chat-empty">
            Ask the agent to change a field, regenerate a frame, or stage an image
            replacement. Click Apply when satisfied.
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`shot-chat-msg role-${m.role}`}>
            <div className="shot-chat-msg-role">{m.role}</div>
            <div className="shot-chat-msg-body">
              {m.parts.map((p, i) => {
                if (p.type === "text") return <p key={i}>{p.text}</p>;
                if (p.type === "reasoning") return null;
                if (p.type.startsWith("tool-") || p.type.startsWith("dynamic-tool-")) {
                  return <ToolPart key={i} part={p as unknown as ToolPartLike} />;
                }
                return null;
              })}
            </div>
          </div>
        ))}
        {error && (
          <div className="shot-chat-msg role-error">
            <pre>{error.message}</pre>
          </div>
        )}
      </div>
      <div className="shot-chat-input">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void handleSend();
            }
          }}
          placeholder="Describe the change… (⌘/Ctrl + Enter to send)"
          rows={3}
          disabled={!apiUrl || status === "streaming" || status === "submitted"}
        />
        <button
          className="primary"
          onClick={handleSend}
          disabled={!input.trim() || status === "streaming" || status === "submitted"}
        >
          {status === "streaming" || status === "submitted" ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}
