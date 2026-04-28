import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from "ai";

import { useUIStore } from "../../stores/ui-store";
import {
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
  sceneNumber: number;
  shotInScene: number;
  title: string;
  renderForm: () => ReactNode;
  renderInspector: () => ReactNode;
}

export default function ScopedChatPanel({
  runId,
  scope,
  scopeKey,
  sceneNumber,
  shotInScene,
  title,
  renderForm,
  renderInspector,
}: ScopedChatPanelProps) {
  const showToast = useUIStore((s) => s.showToast);
  const fetchSession = useChatSessionStore((s) => s.fetchSession);
  const applyDraft = useChatSessionStore((s) => s.applyDraft);
  const discardDraft = useChatSessionStore((s) => s.discardDraft);
  const session = useChatSessionStore((s) => selectSession(s, runId, scope, scopeKey));

  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState(false);

  const apiUrl = `/api/runs/${encodeURIComponent(runId)}/chat/${scope}/${sceneNumber}/${shotInScene}`;
  const transport = useMemo(
    () => new DefaultChatTransport<UIMessage>({ api: apiUrl }),
    [apiUrl],
  );

  const { messages, sendMessage, status, setMessages, error, addToolApprovalResponse } = useChat({
    id: `${scope}-${runId}-${scopeKey}`,
    transport,
    sendAutomaticallyWhen: ({ messages: msgs }) =>
      lastAssistantMessageIsCompleteWithToolCalls({ messages: msgs }) ||
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages: msgs }),
  });

  useEffect(() => {
    let cancelled = false;
    setHydrated(false);
    fetchSession(runId, scope, scopeKey).then((data) => {
      if (cancelled) return;
      if (data && Array.isArray(data.messages) && data.messages.length > 0) {
        setMessages(data.messages as UIMessage[]);
      } else {
        setMessages([]);
      }
      setHydrated(true);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, scope, scopeKey]);

  const draft = session?.draft ?? null;
  const draftFieldCount = draft ? Object.keys(draft.shotFields).length : 0;
  const draftImageCount = draft ? draft.pendingImageReplacements.length : 0;
  const hasDraft = draftFieldCount > 0 || draftImageCount > 0;

  const handleSubmit = async (msg: PromptInputMessage) => {
    const text = msg.text?.trim();
    if (!text) return;
    try {
      await sendMessage({ text });
      await fetchSession(runId, scope, scopeKey);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), "error");
    }
  };

  const handleApply = async () => {
    setBusy(true);
    const result = await applyDraft(runId, scope, scopeKey, sceneNumber, shotInScene);
    setBusy(false);
    if (!result.ok) showToast(result.error ?? "Apply failed", "error");
    else showToast("Applied draft to canonical document", "info");
  };

  const handleDiscard = async () => {
    setBusy(true);
    const result = await discardDraft(runId, scope, scopeKey, sceneNumber, shotInScene);
    setBusy(false);
    if (!result.ok) showToast(result.error ?? "Discard failed", "error");
  };

  const inputDisabled = status === "streaming" || status === "submitted";

  return (
    <TooltipProvider>
      <div className="scoped-chat-panel">
        <div className="scoped-chat-form">{renderForm()}</div>
        <div className="scoped-chat-inspector">{renderInspector()}</div>
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
