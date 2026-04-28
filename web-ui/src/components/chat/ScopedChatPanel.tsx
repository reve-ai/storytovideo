import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from "ai";

import { useUIStore } from "../../stores/ui-store";
import {
  chatBaseUrl,
  draftFieldCount as countDraftFields,
  selectSession,
  useChatSessionStore,
  type ChatScope,
} from "../../stores/chat-session-store";
import ToolPart, { type ToolPartLike } from "./ToolPart";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "../ai-elements/conversation";
import { Message, MessageContent } from "../ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputMessage,
} from "../ai-elements/prompt-input";
import { TooltipProvider } from "../ui/tooltip";

interface ScopedChatPanelProps {
  runId: string;
  scope: ChatScope;
  scopeKey: string;
  title: string;
  renderForm: () => ReactNode;
  renderInspector: (ctx: { messages: UIMessage[] }) => ReactNode;
}

export default function ScopedChatPanel({
  runId,
  scope,
  scopeKey,
  title,
  renderForm,
  renderInspector,
}: ScopedChatPanelProps) {
  const showToast = useUIStore((s) => s.showToast);
  const fetchSession = useChatSessionStore((s) => s.fetchSession);
  const applyDraft = useChatSessionStore((s) => s.applyDraft);
  const discardDraft = useChatSessionStore((s) => s.discardDraft);
  const resetSession = useChatSessionStore((s) => s.resetSession);
  const session = useChatSessionStore((s) => selectSession(s, runId, scope, scopeKey));

  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState(false);

  const apiUrl = chatBaseUrl(runId, scope, scopeKey);
  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: apiUrl,
        // Reconnect to the runner's stream endpoint instead of the default
        // `${api}/${chatId}/stream` (we don't put chatId in the URL).
        prepareReconnectToStreamRequest: ({ api }) => ({ api: `${api}/stream` }),
      }),
    [apiUrl],
  );

  const { messages, sendMessage, status, setMessages, error, addToolApprovalResponse, resumeStream } = useChat({
    id: `${scope}-${runId}-${scopeKey}`,
    transport,
    sendAutomaticallyWhen: ({ messages: msgs }) =>
      lastAssistantMessageIsCompleteWithToolCalls({ messages: msgs }) ||
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages: msgs }),
  });

  const [interrupted, setInterrupted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setHydrated(false);
    setInterrupted(false);
    fetchSession(runId, scope, scopeKey).then((data) => {
      if (cancelled) return;
      if (data && Array.isArray(data.messages) && data.messages.length > 0) {
        setMessages(data.messages as UIMessage[]);
      } else {
        setMessages([]);
      }
      setHydrated(true);
      if (!data) return;
      if (data.runStatus === "running") {
        // Reattach to the live stream; chunks emitted before this client
        // connected are replayed by the server, then live ones tail.
        void resumeStream();
      } else if (data.runStatus === "interrupted") {
        setInterrupted(true);
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, scope, scopeKey]);

  // Per-tool-result live refresh: refetch session whenever a new completed
  // tool call appears in the chat stream, not just at end-of-stream. The
  // form's per-field focus tracking preserves in-progress edits.
  const refreshedToolCallIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    refreshedToolCallIds.current = new Set();
  }, [runId, scope, scopeKey]);
  useEffect(() => {
    let needsFetch = false;
    for (const m of messages) {
      for (const p of m.parts as Array<{ type?: string; state?: string; toolCallId?: string }>) {
        const type = p.type ?? "";
        if (!type.startsWith("tool-") && !type.startsWith("dynamic-tool-")) continue;
        const state = p.state ?? "";
        const id = p.toolCallId;
        if (!id) continue;
        const isTerminal =
          state === "output-available" ||
          state === "output-error" ||
          state === "output-denied";
        if (isTerminal && !refreshedToolCallIds.current.has(id)) {
          refreshedToolCallIds.current.add(id);
          needsFetch = true;
        }
      }
    }
    if (needsFetch) {
      void fetchSession(runId, scope, scopeKey);
    }
  }, [messages, runId, scope, scopeKey, fetchSession]);

  const draft = session?.draft ?? null;
  const draftCount = countDraftFields(draft);
  const hasDraft = draftCount > 0;

  const handleSubmit = async (msg: PromptInputMessage) => {
    const text = msg.text?.trim();
    if (!text) return;
    try {
      setInterrupted(false);
      await sendMessage({ text });
      await fetchSession(runId, scope, scopeKey);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), "error");
    }
  };

  const handleApply = async () => {
    setBusy(true);
    const result = await applyDraft(runId, scope, scopeKey);
    setBusy(false);
    if (!result.ok) showToast(result.error ?? "Apply failed", "error");
    else showToast("Applied draft to canonical document", "info");
  };

  const handleDiscard = async () => {
    setBusy(true);
    const result = await discardDraft(runId, scope, scopeKey);
    setBusy(false);
    if (!result.ok) showToast(result.error ?? "Discard failed", "error");
  };

  const handleReset = async () => {
    if (!window.confirm(
      "Reset this chat? Messages and draft will be cleared. The canonical document is unaffected.",
    )) return;
    setBusy(true);
    const result = await resetSession(runId, scope, scopeKey);
    setBusy(false);
    if (!result.ok) {
      showToast(result.error ?? "Reset failed", "error");
      return;
    }
    setMessages([]);
    setInterrupted(false);
    showToast("Chat reset", "info");
  };

  const inputDisabled = status === "streaming" || status === "submitted";

  return (
    <TooltipProvider>
      <div className="scoped-chat-panel">
        <div className="scoped-chat-form">{renderForm()}</div>
        <div className="scoped-chat-inspector">{renderInspector({ messages })}</div>
        <div className="scoped-chat-chat">
          <div className="shot-chat-header">
            <div className="shot-chat-title">{title}</div>
            <div className="shot-chat-actions">
              <button
                className="primary"
                disabled={!hasDraft || busy}
                onClick={handleApply}
                title={hasDraft ? "Apply staged changes to the canonical document" : "No staged changes"}
              >
                Apply{hasDraft ? ` (${draftCount})` : ""}
              </button>
              <button
                className="secondary"
                disabled={!hasDraft || busy}
                onClick={handleDiscard}
              >
                Discard
              </button>
              <button
                className="secondary"
                disabled={busy || inputDisabled}
                onClick={handleReset}
                title="Wipe this chat's messages and draft. The canonical document is unaffected."
              >
                Reset
              </button>
            </div>
          </div>
          {interrupted && (
            <div className="shot-chat-interrupted">
              The previous run was interrupted (server restart or crash). The
              last assistant turn may be incomplete. Send a new message to
              continue.
            </div>
          )}
          <Conversation className="shot-chat-conversation">
            <ConversationContent>
              {!hydrated && (
                <ConversationEmptyState
                  title="Loading session…"
                  description="Restoring your previous chat for this scope."
                />
              )}
              {hydrated && messages.length === 0 && (
                <ConversationEmptyState
                  title={title}
                  description="Edit the form on the left, or ask the agent to change a field, regenerate a frame, or stage an image replacement. Click Apply when satisfied."
                />
              )}
              {messages.map((m) => (
                <Message from={m.role} key={m.id}>
                  <MessageContent>
                    {m.parts.map((p, i) => {
                      if (p.type === "text") {
                        return (<p key={i} className="whitespace-pre-wrap">{p.text}</p>);
                      }
                      if (p.type === "reasoning") return null;
                      if (p.type.startsWith("tool-") || p.type.startsWith("dynamic-tool-")) {
                        return (
                          <ToolPart
                            key={i}
                            part={p as unknown as ToolPartLike}
                            onApprovalResponse={(id, approved) =>
                              addToolApprovalResponse({ id, approved })
                            }
                          />
                        );
                      }
                      return null;
                    })}
                  </MessageContent>
                </Message>
              ))}
              {error && (
                <Message from="system">
                  <MessageContent>
                    <pre className="chat-tool-error">{error.message}</pre>
                  </MessageContent>
                </Message>
              )}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
          <PromptInput onSubmit={handleSubmit} className="shot-chat-prompt">
            <PromptInputBody>
              <PromptInputTextarea
                placeholder="Describe the change…"
                disabled={inputDisabled}
              />
            </PromptInputBody>
            <PromptInputFooter>
              <span />
              <PromptInputSubmit status={status} disabled={inputDisabled} />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </TooltipProvider>
  );
}
