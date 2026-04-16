import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import { usePipelineStore, WorkItem } from "../stores/pipeline-store";
import { useRunStore } from "../stores/run-store";
import { mediaUrl } from "../utils/media-url";

/* ── Chat types ───────────────────────────────────────────── */

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  appliedRedo?: boolean;
}

/* ── Inline SVG icons ──────────────────────────────────────── */
const IconPlay = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <polygon points="6,3 20,12 6,21" />
  </svg>
);
const IconChevronLeft = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6" />
  </svg>
);
const IconChevronRight = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

/* ── Data helpers ──────────────────────────────────────────── */

interface ProcessedShot {
  shotNum: number;
  frameSrc: string | null;
  videoSrc: string | null;
  status: string;
  shot: Record<string, unknown>;
}

interface ProcessedScene {
  sceneNum: number;
  title: string;
  location: string;
  shots: ProcessedShot[];
  thumbSrc: string | null;
}

function getAllItems(queues: ReturnType<typeof usePipelineStore.getState>["queues"]): WorkItem[] {
  const items: WorkItem[] = [];
  for (const qName of ["llm", "image", "video"] as const) {
    const q = queues[qName];
    if (!q) continue;
    for (const group of [q.inProgress, q.pending, q.completed, q.failed, q.superseded, q.cancelled]) {
      if (group) items.push(...group);
    }
  }
  return items;
}

function useSceneData() {
  const queues = usePipelineStore((s) => s.queues);
  const runs = useRunStore((s) => s.runs);
  const activeRunId = useRunStore((s) => s.activeRunId);
  const existingShots = usePipelineStore((s) => s.existingShots);
  const hasExistingShots = Object.keys(existingShots).length > 0;

  return useMemo(() => {
    const allItems = getAllItems(queues);
    const frameItems = allItems.filter(
      (i) => i.type === "generate_frame" && i.status !== "superseded" && i.status !== "cancelled",
    );
    const videoItems = allItems.filter(
      (i) => i.type === "generate_video" && i.status !== "superseded" && i.status !== "cancelled",
    );
    const planItems = allItems.filter(
      (i) => i.type === "plan_shots" && i.status === "completed",
    );

    const sceneMap = new Map<number, { frames: Map<number, WorkItem>; videos: Map<number, WorkItem>; location: string | null }>();

    for (const item of frameItems) {
      const shot = item.inputs?.shot as Record<string, unknown> | undefined;
      const sceneNum = shot?.sceneNumber as number | undefined;
      if (sceneNum == null) continue;
      if (!sceneMap.has(sceneNum)) sceneMap.set(sceneNum, { frames: new Map(), videos: new Map(), location: null });
      const scene = sceneMap.get(sceneNum)!;
      const shotNum = shot?.shotInScene as number | undefined;
      if (shotNum != null) {
        const existing = scene.frames.get(shotNum);
        if (!existing || item.version > existing.version) scene.frames.set(shotNum, item);
      }
      if (!scene.location && shot?.location) scene.location = shot.location as string;
    }

    for (const item of videoItems) {
      const shot = item.inputs?.shot as Record<string, unknown> | undefined;
      const sceneNum = shot?.sceneNumber as number | undefined;
      if (sceneNum == null) continue;
      if (!sceneMap.has(sceneNum)) sceneMap.set(sceneNum, { frames: new Map(), videos: new Map(), location: null });
      const scene = sceneMap.get(sceneNum)!;
      const shotNum = shot?.shotInScene as number | undefined;
      if (shotNum != null) {
        const existing = scene.videos.get(shotNum);
        if (!existing || item.version > existing.version) scene.videos.set(shotNum, item);
      }
      if (!scene.location && shot?.location) scene.location = shot.location as string;
    }

    const planByScene = new Map<number, WorkItem>();
    for (const item of planItems) {
      const sceneNum = (item.outputs?.sceneNumber as number) ?? (item.inputs?.sceneNumber as number);
      if (sceneNum != null) planByScene.set(sceneNum, item);
    }

    const run = runs.find((r) => r.id === activeRunId);
    const aspectRatio = (run?.options?.aspectRatio ?? "16:9").replace(":", "/");

    const scenes: ProcessedScene[] = [...sceneMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([sceneNum, data]) => {
        const plan = planByScene.get(sceneNum);
        const title = (plan?.outputs?.title as string) ?? `Scene ${sceneNum}`;
        const location = data.location ?? (plan?.outputs?.location as string) ?? "";

        const shotNums = new Set([...data.frames.keys(), ...data.videos.keys()]);
        const sortedShotNums = [...shotNums]
          .filter((sn) => !hasExistingShots || existingShots[`${sceneNum}:${sn}`])
          .sort((a, b) => a - b);

        const shots: ProcessedShot[] = sortedShotNums.map((shotNum) => {
          const frameItem = data.frames.get(shotNum);
          const videoItem = data.videos.get(shotNum);
          const startPath = frameItem?.outputs?.startPath as string | undefined;
          const videoPath = videoItem?.outputs?.path as string | undefined;
          const frameSrc = frameItem?.status === "completed" && startPath && activeRunId ? mediaUrl(activeRunId, startPath) : null;
          const videoSrc = videoItem?.status === "completed" && videoPath && activeRunId ? mediaUrl(activeRunId, videoPath) : null;
          const status = videoItem?.status ?? (frameItem?.status === "completed" && !videoItem ? "generating_video" : frameItem?.status) ?? "pending";
          const shot = (frameItem?.inputs?.shot ?? videoItem?.inputs?.shot ?? {}) as Record<string, unknown>;
          return { shotNum, frameSrc, videoSrc, status, shot };
        });

        const firstShot = shots[0];
        const thumbSrc = firstShot?.frameSrc ?? null;

        return { sceneNum, title, location, shots, thumbSrc };
      });

    return { scenes, aspectRatio };
  }, [queues, runs, activeRunId, existingShots, hasExistingShots]);
}

/* ── Main component ────────────────────────────────────────── */

export default function StoryEditorView() {
  const { scenes } = useSceneData();

  const [selectedSceneIdx, setSelectedSceneIdx] = useState(0);
  const [selectedShotIdx, setSelectedShotIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [shotDetailsExpanded, setShotDetailsExpanded] = useState(true);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<Map<string, ChatMessage[]>>(new Map());
  const [chatLoading, setChatLoading] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  const activeRunId = useRunStore((s) => s.activeRunId);
  const chatWithShot = usePipelineStore((s) => s.chatWithShot);

  const currentScene = scenes[selectedSceneIdx] ?? null;
  const currentShot = currentScene?.shots[selectedShotIdx] ?? currentScene?.shots[0] ?? null;
  const previewSrc = currentShot?.videoSrc ?? currentShot?.frameSrc ?? null;
  const isVideo = playing && currentShot?.videoSrc;

  // Extract shot details for the details panel
  const shotData = currentShot?.shot ?? {};
  const composition = shotData.composition as string | undefined;
  const cameraDirection = shotData.cameraDirection as string | undefined;
  const dialogue = shotData.dialogue as string | undefined;
  const speaker = shotData.speaker as string | undefined;
  const videoPrompt = shotData.videoPrompt as string | undefined;
  const durationSeconds = shotData.durationSeconds as number | undefined;
  const soundEffects = shotData.soundEffects as string | undefined;
  const shotLocation = shotData.location as string | undefined;

  const handleSelectScene = useCallback((idx: number) => {
    setSelectedSceneIdx(idx);
    setSelectedShotIdx(0);
    setPlaying(false);
  }, []);

  const handleSelectShot = useCallback((idx: number) => {
    setSelectedShotIdx(idx);
    setPlaying(false);
  }, []);

  const handlePrevScene = useCallback(() => {
    if (selectedSceneIdx > 0) handleSelectScene(selectedSceneIdx - 1);
  }, [selectedSceneIdx, handleSelectScene]);

  const handleNextScene = useCallback(() => {
    if (selectedSceneIdx < scenes.length - 1) handleSelectScene(selectedSceneIdx + 1);
  }, [selectedSceneIdx, scenes.length, handleSelectScene]);

  const handlePlay = useCallback(() => {
    if (currentShot?.videoSrc) {
      setPlaying(true);
    }
  }, [currentShot?.videoSrc]);

  const handleVideoEnded = useCallback(() => setPlaying(false), []);

  // Chat helpers
  const chatKey = currentShot
    ? `${currentScene?.sceneNum}:${currentShot.shotNum}`
    : null;
  const currentChatMessages = chatKey ? chatMessages.get(chatKey) ?? [] : [];

  const handleSendMessage = useCallback(async () => {
    if (!chatInput.trim() || !currentShot || !currentScene || !activeRunId || chatLoading) return;

    const key = `${currentScene.sceneNum}:${currentShot.shotNum}`;
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: chatInput.trim(),
    };

    // Add user message to history
    setChatMessages((prev) => {
      const next = new Map(prev);
      next.set(key, [...(prev.get(key) ?? []), msg]);
      return next;
    });
    const input = chatInput.trim();
    setChatInput("");
    setChatLoading(true);

    // Build history for the API (exclude the message we just added)
    const existingMessages = chatMessages.get(key) ?? [];
    const history = existingMessages.map((m) => ({ role: m.role, content: m.content }));

    const result = await chatWithShot(
      activeRunId,
      currentScene.sceneNum,
      currentShot.shotNum,
      input,
      history,
    );

    if (result) {
      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: result.reply,
        appliedRedo: result.appliedRedo,
      };
      setChatMessages((prev) => {
        const next = new Map(prev);
        next.set(key, [...(prev.get(key) ?? []), assistantMsg]);
        return next;
      });
    } else {
      const errorMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "Something went wrong. Please try again.",
      };
      setChatMessages((prev) => {
        const next = new Map(prev);
        next.set(key, [...(prev.get(key) ?? []), errorMsg]);
        return next;
      });
    }

    setChatLoading(false);
  }, [chatInput, currentShot, currentScene, activeRunId, chatLoading, chatMessages, chatWithShot]);

  // Auto-scroll chat to bottom
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [currentChatMessages, chatLoading]);

  return (
    <div className="story-editor">
      {/* ── Main area ─────────────────────────────────────── */}
      <div className="se-main">
        {/* Preview */}
        <div className="se-preview">
          {isVideo && currentShot?.videoSrc ? (
            <video
              ref={videoRef}
              className="se-preview-video"
              src={currentShot.videoSrc}
              autoPlay
              controls
              onEnded={handleVideoEnded}
            />
          ) : previewSrc ? (
            <img className="se-preview-img" src={previewSrc} alt="Preview" />
          ) : (
            <div className="se-preview-empty">
              {scenes.length === 0
                ? "No shots yet. Waiting for generation to begin."
                : "Select a shot to preview"}
            </div>
          )}
        </div>

        {/* Filmstrip */}
        <div className="se-filmstrip">
          <button className="se-play-btn" onClick={handlePlay} title="Play">
            <IconPlay />
          </button>

          <div className="se-scene-thumbs">
            {scenes.map((scene, idx) => (
              <div
                key={scene.sceneNum}
                className={`se-scene-thumb${idx === selectedSceneIdx ? " selected" : ""}`}
                onClick={() => handleSelectScene(idx)}
              >
                {scene.thumbSrc ? (
                  <img src={scene.thumbSrc} alt={scene.title} />
                ) : (
                  <div className="se-scene-thumb-placeholder">S{scene.sceneNum}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Sidebar ───────────────────────────────────────── */}
      <div className="se-sidebar">
        {/* Scene header */}
        <div className="se-scene-header">
          <button
            className="se-scene-nav-btn"
            onClick={handlePrevScene}
            disabled={selectedSceneIdx === 0}
            title="Previous scene"
          >
            <IconChevronLeft />
          </button>

          <div className="se-scene-header-info">
            {currentScene?.thumbSrc && (
              <img className="se-scene-header-thumb" src={currentScene.thumbSrc} alt="" />
            )}
            <div className="se-scene-header-text">
              <div className="se-scene-header-title">
                {currentScene?.title ?? "No scene"}
              </div>
              {currentScene?.location && (
                <div className="se-scene-header-location">{currentScene.location}</div>
              )}
            </div>
          </div>

          <button
            className="se-scene-nav-btn"
            onClick={handleNextScene}
            disabled={selectedSceneIdx >= scenes.length - 1}
            title="Next scene"
          >
            <IconChevronRight />
          </button>
        </div>

        {/* Shot list */}
        <div className="se-shot-list-wrap">
          <div className="se-shot-list">
            {currentScene?.shots.map((shot, idx) => (
              <div
                key={shot.shotNum}
                className={`se-shot-item${idx === selectedShotIdx ? " selected" : ""}`}
                onClick={() => handleSelectShot(idx)}
              >
                <div className="se-shot-thumb">
                  {shot.frameSrc ? (
                    <img src={shot.frameSrc} alt={`Shot ${shot.shotNum}`} />
                  ) : (
                    <div className="se-shot-thumb-empty">{shot.status}</div>
                  )}
                </div>
                <span className="se-shot-name">Shot {shot.shotNum}</span>
              </div>
            ))}
            {(!currentScene || currentScene.shots.length === 0) && (
              <div className="se-shot-list-empty">No shots in this scene</div>
            )}
          </div>
        </div>

        {/* Shot details (collapsible) */}
        {currentShot && (
          <div className="se-shot-details">
            <button
              className="se-shot-details-toggle"
              onClick={() => setShotDetailsExpanded((v) => !v)}
            >
              Shot Details
              <span className={`se-shot-details-chevron${shotDetailsExpanded ? " expanded" : ""}`}>
                &#9662;
              </span>
            </button>
            {shotDetailsExpanded && (
              <div className="se-shot-details-body">
                {composition && (
                  <div className="se-detail-row">
                    <span className="se-detail-label">Composition</span>
                    <span className="se-detail-value">{composition}</span>
                  </div>
                )}
                {cameraDirection && (
                  <div className="se-detail-row">
                    <span className="se-detail-label">Camera</span>
                    <span className="se-detail-value">{cameraDirection}</span>
                  </div>
                )}
                {dialogue && (
                  <div className="se-detail-row">
                    <span className="se-detail-label">Dialogue</span>
                    <span className="se-detail-value">
                      {speaker ? `${speaker}: ` : ""}{dialogue}
                    </span>
                  </div>
                )}
                {videoPrompt && (
                  <div className="se-detail-row">
                    <span className="se-detail-label">Action</span>
                    <span className="se-detail-value">{videoPrompt}</span>
                  </div>
                )}
                {durationSeconds != null && (
                  <div className="se-detail-row">
                    <span className="se-detail-label">Duration</span>
                    <span className="se-detail-value">{durationSeconds}s</span>
                  </div>
                )}
                {soundEffects && (
                  <div className="se-detail-row">
                    <span className="se-detail-label">SFX</span>
                    <span className="se-detail-value">{soundEffects}</span>
                  </div>
                )}
                {shotLocation && (
                  <div className="se-detail-row">
                    <span className="se-detail-label">Location</span>
                    <span className="se-detail-value">{shotLocation}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Shot chat */}
        <div className="se-shot-chat">
          <div className="se-chat-messages" ref={chatScrollRef}>
            {currentChatMessages.length === 0 && (
              <div className="se-chat-empty">
                Describe changes you want for this shot...
              </div>
            )}
            {currentChatMessages.map((msg) => (
              <div key={msg.id} className={`se-chat-msg se-chat-msg-${msg.role}`}>
                <div className="se-chat-msg-content">{msg.content}</div>
                {msg.appliedRedo && (
                  <div className="se-chat-msg-badge">Changes applied</div>
                )}
              </div>
            ))}
            {chatLoading && (
              <div className="se-chat-msg se-chat-msg-assistant se-chat-loading">
                <div className="se-chat-msg-content">Thinking...</div>
              </div>
            )}
          </div>
          <div className="se-chat-input-row">
            <textarea
              className="se-chat-input"
              placeholder="Describe changes to this shot..."
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
              rows={2}
              disabled={chatLoading || !currentShot}
            />
            <button
              className="se-chat-send-btn"
              onClick={handleSendMessage}
              disabled={chatLoading || !chatInput.trim() || !currentShot}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
