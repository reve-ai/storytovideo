import { useEffect } from "react";

import { useUIStore } from "../stores/ui-store";
import { useRunStore } from "../stores/run-store";
import CharacterChat from "./chat/CharacterChat";

/**
 * Takeover-style panel for the Character-scoped chat. Slides in over the main
 * view when triggered from a character asset card in AssetsView.
 */
export default function CharacterChatTakeover() {
  const characterName = useUIStore((s) => s.characterChatName);
  const close = useUIStore((s) => s.closeCharacterChat);
  const activeRunId = useRunStore((s) => s.activeRunId);

  const open = !!characterName;

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
      className={`chat-takeover${open ? " open" : ""}`}
      aria-hidden={!open}
    >
      <div className="chat-takeover-header">
        <button
          type="button"
          className="chat-takeover-close"
          onClick={close}
          aria-label="Close character chat"
          title="Close (Esc)"
        >
          ✕
        </button>
      </div>
      <div className="chat-takeover-body">
        {open && characterName && <CharacterChat characterName={characterName} />}
      </div>
    </div>
  );
}
