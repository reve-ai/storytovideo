import { useEffect, useMemo, useState } from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
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

  const apiUrl = activeRunId
    ? `/api/runs/${encodeURIComponent(activeRunId)}/chat/shot/${sceneNumber}/${shotInScene}`
    : "";

  const transport = useMemo(
    () => (apiUrl ? new DefaultChatTransport<UIMessage>({ api: apiUrl }) : undefined),
    [apiUrl],
  );

  const { messages, sendMessage, status, setMessages, error, addToolApprovalResponse } = useChat({
    id: `shot-${activeRunId ?? "no-run"}-${scopeKey}`,
    transport,
    sendAutomaticallyWhen: ({ messages: msgs }) =>
      lastAssistantMessageIsCompleteWithToolCalls({ messages: msgs }) ||
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages: msgs }),
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

  const handleSubmit = async (msg: PromptInputMessage) => {
    const text = msg.text?.trim();
    if (!text || !apiUrl) return;
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

  const inputDisabled = !apiUrl || status === "streaming" || status === "submitted";

  return (
    <TooltipProvider>
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

        <Conversation className="shot-chat-conversation">
          <ConversationContent>
            {!hydrated && (
              <ConversationEmptyState
                title="Loading session…"
                description="Restoring your previous chat for this shot."
              />
            )}
            {hydrated && messages.length === 0 && (
              <ConversationEmptyState
                title="Edit this shot"
                description="Ask the agent to change a field, regenerate a frame, or stage an image replacement. Click Apply when satisfied."
              />
            )}
            {messages.map((m) => (
              <Message from={m.role} key={m.id}>
                <MessageContent>
                  {m.parts.map((p, i) => {
                    if (p.type === "text") {
                      return (
                        <p key={i} className="whitespace-pre-wrap">
                          {p.text}
                        </p>
                      );
                    }
                    if (p.type === "reasoning") return null;
                    if (
                      p.type.startsWith("tool-") ||
                      p.type.startsWith("dynamic-tool-")
                    ) {
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
    </TooltipProvider>
  );
}
