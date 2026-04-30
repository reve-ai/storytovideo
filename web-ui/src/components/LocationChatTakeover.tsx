import { useEffect } from "react";

import { useUIStore } from "../stores/ui-store";
import { useRunStore } from "../stores/run-store";
import LocationChat from "./chat/LocationChat";

/**
 * Takeover-style panel for the Location-scoped chat. Slides in over the main
 * view when triggered from a location chip in StoryView.
 */
export default function LocationChatTakeover() {
  const locationName = useUIStore((s) => s.locationChatName);
  const close = useUIStore((s) => s.closeLocationChat);
  const activeRunId = useRunStore((s) => s.activeRunId);

  const open = !!locationName;

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
          aria-label="Close location chat"
          title="Close (Esc)"
        >
          ✕
        </button>
      </div>
      <div className="story-chat-takeover-body">
        {open && locationName && <LocationChat locationName={locationName} />}
      </div>
    </div>
  );
}
