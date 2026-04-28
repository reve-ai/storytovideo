import { useEffect } from "react";

import { useUIStore } from "../stores/ui-store";
import { useRunStore } from "../stores/run-store";
import StoryChat from "./chat/StoryChat";

/**
 * Takeover-style panel for the Story-scoped chat. Slides in over the main view
 * when triggered from the TopBar "Edit Story" button.
 */
export default function StoryChatTakeover() {
  const open = useUIStore((s) => s.storyChatOpen);
  const close = useUIStore((s) => s.closeStoryChat);
  const activeRunId = useRunStore((s) => s.activeRunId);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!activeRunId) return null;

  return (
    <div
      className={`story-chat-takeover${open ? " open" : ""}`}
      aria-hidden={!open}
    >
      <div className="story-chat-takeover-header">
        <button
          type="button"
          className="story-chat-takeover-close"
          onClick={close}
          aria-label="Close story chat"
          title="Close (Esc)"
        >
          ✕
        </button>
      </div>
      <div className="story-chat-takeover-body">
        {open && <StoryChat />}
      </div>
    </div>
  );
}
