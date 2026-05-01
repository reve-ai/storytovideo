import { useEffect } from "react";

import { useUIStore } from "../stores/ui-store";
import { useRunStore } from "../stores/run-store";
import ObjectChat from "./chat/ObjectChat";

/**
 * Takeover-style panel for the Object-scoped chat. Slides in over the main
 * view when triggered from an object asset card in AssetsView.
 */
export default function ObjectChatTakeover() {
  const objectName = useUIStore((s) => s.objectChatName);
  const close = useUIStore((s) => s.closeObjectChat);
  const activeRunId = useRunStore((s) => s.activeRunId);

  const open = !!objectName;

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
          aria-label="Close object chat"
          title="Close (Esc)"
        >
          ✕
        </button>
      </div>
      <div className="chat-takeover-body">
        {open && objectName && <ObjectChat objectName={objectName} />}
      </div>
    </div>
  );
}
