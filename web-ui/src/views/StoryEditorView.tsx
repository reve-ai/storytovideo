import { useMemo, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router";
import { usePipelineStore, WorkItem } from "../stores/pipeline-store";
import { useRunStore } from "../stores/run-store";
import { mediaUrl } from "../utils/media-url";

/* ── Inline SVG icons ──────────────────────────────────────── */

const IconArrowLeft = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </svg>
);
const IconDots = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
  </svg>
);
const IconTrash = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
  </svg>
);
const IconBookmark = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2v16z" />
  </svg>
);
const IconDownload = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);
const IconPlay = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <polygon points="6,3 20,12 6,21" />
  </svg>
);
const IconPlus = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
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
const IconChevronUp = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="18 15 12 9 6 15" />
  </svg>
);
const IconChevronDown = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6 9 12 15 18 9" />
  </svg>
);
const IconPaperclip = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
  </svg>
);
const IconAt = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 006 0v-1a10 10 0 10-3.92 7.94" />
  </svg>
);
const IconClock = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
  </svg>
);
const IconMoon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
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

type SidebarTab = "chat" | "scene" | "assets" | "settings";

export default function StoryEditorView() {
  const navigate = useNavigate();
  const { scenes } = useSceneData();

  const [selectedSceneIdx, setSelectedSceneIdx] = useState(0);
  const [selectedShotIdx, setSelectedShotIdx] = useState(0);
  const [mode, setMode] = useState<"storyboard" | "editor">("editor");
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("scene");
  const [continuity, setContinuity] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [directorsNote, setDirectorsNote] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);

  const currentScene = scenes[selectedSceneIdx] ?? null;
  const currentShot = currentScene?.shots[selectedShotIdx] ?? currentScene?.shots[0] ?? null;
  const previewSrc = currentShot?.videoSrc ?? currentShot?.frameSrc ?? null;
  const isVideo = playing && currentShot?.videoSrc;

  const handleBack = useCallback(() => navigate("/"), [navigate]);

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

  return (
    <div className="story-editor">
      {/* ── Main area ─────────────────────────────────────── */}
      <div className="se-main">
        {/* Top bar */}
        <div className="se-topbar">
          <div className="se-topbar-left">
            <button className="se-back-btn" onClick={handleBack} title="Back">
              <IconArrowLeft />
            </button>
          </div>

          <div className="se-topbar-center">
            <div className="se-mode-toggle">
              <button
                className={`se-mode-btn${mode === "storyboard" ? " active" : ""}`}
                onClick={() => setMode("storyboard")}
              >
                Storyboard
              </button>
              <button
                className={`se-mode-btn${mode === "editor" ? " active" : ""}`}
                onClick={() => setMode("editor")}
              >
                Editor
              </button>
            </div>
            <button className="se-theme-btn" title="Toggle theme">
              <IconMoon />
            </button>
          </div>

          <div className="se-topbar-right">
            <button className="se-icon-btn" title="More options"><IconDots /></button>
            <button className="se-icon-btn" title="Delete"><IconTrash /></button>
            <button className="se-icon-btn" title="Bookmark"><IconBookmark /></button>
            <button className="se-icon-btn" title="Download"><IconDownload /></button>
            <button className="se-share-btn">Share</button>
          </div>
        </div>

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

          <div className="se-filmstrip-actions">
            <button className="se-add-scene-btn">
              <IconPlus /> Add a scene
            </button>
            <button className="se-filmstrip-delete" title="Delete scene">
              <IconTrash />
            </button>
          </div>
        </div>
      </div>

      {/* ── Sidebar ───────────────────────────────────────── */}
      <div className="se-sidebar">
        {/* Tabs */}
        <div className="se-sidebar-tabs">
          {(["chat", "scene", "assets", "settings"] as SidebarTab[]).map((tab) => (
            <button
              key={tab}
              className={`se-sidebar-tab${sidebarTab === tab ? " active" : ""}`}
              onClick={() => setSidebarTab(tab)}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Scene preview with nav arrows */}
        <div className="se-scene-preview-wrap">
          <button
            className="se-scene-nav-btn"
            onClick={handlePrevScene}
            disabled={selectedSceneIdx === 0}
            title="Previous scene"
          >
            <IconChevronLeft />
          </button>

          <div className="se-scene-preview-img">
            {currentScene?.thumbSrc ? (
              <img src={currentScene.thumbSrc} alt={currentScene.title} />
            ) : (
              <div className="se-scene-preview-placeholder">
                {currentScene ? `Scene ${currentScene.sceneNum}` : "No scene"}
              </div>
            )}
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

        {/* Continuity toggle */}
        <div className="se-continuity-row">
          <span className="se-continuity-label">
            <IconClock />
            Continuity
          </span>
          <div className="se-continuity-toggle">
            <button
              className={`se-continuity-opt${!continuity ? " active" : ""}`}
              onClick={() => setContinuity(false)}
            >
              Off
            </button>
            <button
              className={`se-continuity-opt${continuity ? " active" : ""}`}
              onClick={() => setContinuity(true)}
            >
              On
            </button>
          </div>
        </div>

        {/* Shot list + nav arrows row */}
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
                <button className="se-shot-delete" title="Delete shot" onClick={(e) => e.stopPropagation()}>
                  <IconTrash />
                </button>
              </div>
            ))}
            {(!currentScene || currentScene.shots.length === 0) && (
              <div style={{ padding: "24px 16px", color: "#999", fontSize: 13, textAlign: "center" }}>
                No shots in this scene
              </div>
            )}
          </div>
        </div>

        {/* Up/down nav arrows */}
        <div className="se-nav-arrows">
          <button className="se-nav-arrow-btn" title="Move up"><IconChevronUp /></button>
          <button className="se-nav-arrow-btn" title="Move down"><IconChevronDown /></button>
        </div>

        {/* Director's note */}
        <div className="se-directors-note">
          <div className="se-directors-note-content">
            <div className="se-dn-thumb">
              {currentShot?.frameSrc ? (
                <img src={currentShot.frameSrc} alt="Shot thumb" />
              ) : null}
            </div>
            <textarea
              className="se-dn-input"
              placeholder="Add a director's note"
              value={directorsNote}
              onChange={(e) => setDirectorsNote(e.target.value)}
              rows={2}
            />
          </div>
          <div className="se-dn-actions">
            <button className="se-dn-action-btn" title="Attach"><IconPaperclip /></button>
            <button className="se-dn-action-btn" title="Mention"><IconAt /></button>
            <span className="se-dn-actions-right">
              <button className="se-dn-action-btn" title="History"><IconClock /></button>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
