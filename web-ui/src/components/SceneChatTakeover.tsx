import { useEffect } from "react";

import { useUIStore } from "../stores/ui-store";
import { useRunStore } from "../stores/run-store";
import SceneChat from "./chat/SceneChat";

export default function SceneChatTakeover() {
  const sceneChatNumber = useUIStore((s) => s.sceneChatNumber);
  const close = useUIStore((s) => s.closeSceneChat);
  const activeRunId = useRunStore((s) => s.activeRunId);

  const open = sceneChatNumber !== null;

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
          aria-label="Close scene chat"
          title="Close (Esc)"
        >
          ✕
        </button>
      </div>
      <div className="chat-takeover-body">
        {open && sceneChatNumber !== null && <SceneChat sceneNumber={sceneChatNumber} />}
      </div>
    </div>
  );
}