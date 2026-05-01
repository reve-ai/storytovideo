import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { useActiveChats, type ActiveChat } from "../hooks/use-active-chats";
import { useUIStore } from "../stores/ui-store";

interface Props {
  runId: string;
}

function formatDuration(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m${sec % 60 ? ` ${sec % 60}s` : ""}`;
}

function describe(chat: ActiveChat): string {
  if (chat.scope === "story") return "Story";
  if (chat.scope === "location") return `Location: ${decodeURIComponent(chat.scopeKey)}`;
  // shot: scopeKey is "scene-shot"
  return `Shot ${chat.scopeKey}`;
}

function cancelUrl(runId: string, chat: ActiveChat): string {
  const base = `/api/runs/${encodeURIComponent(runId)}/chat`;
  if (chat.scope === "shot") {
    // server stores scopeKey as `${sceneNumber}-${shotInScene}`
    const [scene, shot] = chat.scopeKey.split("-");
    return `${base}/shot/${encodeURIComponent(scene)}/${encodeURIComponent(shot)}/cancel`;
  }
  return `${base}/${chat.scope}/${encodeURIComponent(chat.scopeKey)}/cancel`;
}

/**
 * TopBar dropdown listing in-flight chat agent runs for the active project.
 * Polls the server every 2s. Clicking an entry opens that scope's chat panel
 * the same way clicking Edit Story / a location chip would.
 */
export default function ActiveChatsIndicator({ runId }: Props) {
  const { chats, refresh } = useActiveChats(runId);
  const [open, setOpen] = useState(false);
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const openLocationChat = useUIStore((s) => s.openLocationChat);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // Force re-render every second so duration labels stay fresh while open.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [open]);

  if (chats.length === 0) return null;

  const handleClick = (chat: ActiveChat) => {
    setOpen(false);
    if (chat.scope === "story") {
      navigate("/script");
      return;
    }
    if (chat.scope === "location") {
      openLocationChat(decodeURIComponent(chat.scopeKey));
      return;
    }
    // shot: navigate to the story view; the user can find the shot row from there
    navigate("/story");
  };

  const handleCancel = async (chat: ActiveChat) => {
    const id = `${chat.scope}::${chat.scopeKey}`;
    setCancelling((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    try {
      await fetch(cancelUrl(runId, chat), { method: "POST" });
    } catch {
      // best-effort; the row will remain until the next poll confirms
    } finally {
      refresh();
      // Clear the cancelling flag after a short delay so the user sees the
      // transient state even if the row disappears immediately on refresh.
      setTimeout(() => {
        setCancelling((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, 1500);
    }
  };

  return (
    <div ref={ref} className="active-chats-indicator">
      <button
        type="button"
        className="active-chats-button"
        onClick={() => setOpen((v) => !v)}
        title={`${chats.length} active chat agent${chats.length === 1 ? "" : "s"}`}
      >
        💬 <span className="active-chats-count">{chats.length}</span>
      </button>
      {open && (
        <div className="active-chats-menu">
          {chats.map((chat) => {
            const id = `${chat.scope}::${chat.scopeKey}`;
            const isCancelling = cancelling.has(id);
            return (
              <div key={id} className="active-chats-item">
                <button
                  type="button"
                  className="active-chats-item-main"
                  onClick={() => handleClick(chat)}
                >
                  <div className="active-chats-item-line">
                    <span className="active-chats-item-label">{describe(chat)}</span>
                    <span className="active-chats-item-time">{formatDuration(chat.startedAt)}</span>
                  </div>
                  {chat.currentToolName && (
                    <div className="active-chats-item-tool">→ {chat.currentToolName}</div>
                  )}
                  {chat.queueDepth > 0 && (
                    <div className="active-chats-item-queue">queued: {chat.queueDepth}</div>
                  )}
                </button>
                <button
                  type="button"
                  className="active-chats-item-cancel"
                  onClick={() => handleCancel(chat)}
                  disabled={isCancelling}
                  title="Cancel this chat agent run"
                >
                  {isCancelling ? "Cancelling…" : "Cancel"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
