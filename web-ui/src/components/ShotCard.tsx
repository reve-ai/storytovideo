import { useCallback, useRef, useState } from "react";
import { usePipelineStore, WorkItem } from "../stores/pipeline-store";
import { useRunStore } from "../stores/run-store";
import { useUIStore } from "../stores/ui-store";
import { useHasDraft } from "../stores/chat-drafts-store";
import ImageUpload from "./ImageUpload";
import DraftBadge from "./DraftBadge";
import { mediaUrl } from "../utils/media-url";

interface ShotCardProps {
  shotNum: number;
  frameItem: WorkItem | undefined;
  videoItem: WorkItem | undefined;
  aspectRatio: string;
  showSkip?: boolean;
  isSkipped?: boolean;
  onSkipToggle?: () => void;
}

export default function ShotCard({
  shotNum,
  frameItem,
  videoItem,
  aspectRatio,
  showSkip,
  isSkipped,
  onSkipToggle,
}: ShotCardProps) {
  const activeRunId = useRunStore((s) => s.activeRunId);
  const fetchQueues = usePipelineStore((s) => s.fetchQueues);
  const fetchGraph = usePipelineStore((s) => s.fetchGraph);
  const openDetail = useUIStore((s) => s.openDetail);
  const showToast = useUIStore((s) => s.showToast);
  const [playing, setPlaying] = useState(false);
  const [continuityBusy, setContinuityBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const shot: Record<string, unknown> =
    (frameItem?.inputs?.shot as Record<string, unknown>) ??
    (videoItem?.inputs?.shot as Record<string, unknown>) ??
    {};

  const clickId = videoItem?.id ?? frameItem?.id;
  const targetItemId = frameItem?.id ?? videoItem?.id;

  const frameCompleted = frameItem?.status === "completed";
  const videoCompleted = videoItem?.status === "completed";
  const startPath = frameItem?.outputs?.startPath as string | undefined;
  const videoPath = videoItem?.outputs?.path as string | undefined;

  const frameSrc =
    frameCompleted && startPath && activeRunId
      ? mediaUrl(activeRunId, startPath)
      : null;
  const videoSrc =
    videoCompleted && videoPath && activeRunId
      ? mediaUrl(activeRunId, videoPath)
      : null;

  const handleCardClick = useCallback(() => {
    if (clickId) openDetail(clickId);
  }, [clickId, openDetail]);

  const handlePlay = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!videoSrc) return;
      setPlaying(true);
    },
    [videoSrc],
  );

  const handleVideoEnded = useCallback(() => {
    setPlaying(false);
  }, []);

  const status = videoItem?.status
    ?? (frameItem?.status === "completed" && !videoItem ? "generating_video" : frameItem?.status)
    ?? ("pending" as string);
  const composition = shot.composition as string | undefined;
  const durationSeconds = shot.durationSeconds as number | undefined;
  const videoPrompt = (shot.videoPrompt ?? shot.actionPrompt) as string | undefined;
  const sceneNumber = shot.sceneNumber as number | undefined;
  const shotInScene = shot.shotInScene as number | undefined;
  const continuityEnabled = Boolean(shot.continuousFromPrevious);

  const shotLabel = `S${String(sceneNumber ?? "?")}.${shotNum}`;
  const draftScopeKey =
    typeof sceneNumber === "number" && typeof shotInScene === "number"
      ? `${sceneNumber}-${shotInScene}`
      : null;
  const hasDraft = useHasDraft("shot", draftScopeKey);
  const canToggleContinuity =
    Boolean(activeRunId) &&
    Boolean(targetItemId) &&
    typeof shotInScene === "number" &&
    shotInScene > 1;
  const continuityDisabled = !canToggleContinuity || continuityBusy;
  const truncatedAction =
    videoPrompt && videoPrompt.length > 100
      ? videoPrompt.slice(0, 100) + "…"
      : videoPrompt;

  const handleToggleContinuity = useCallback(
    async (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      if (!activeRunId || !targetItemId || !canToggleContinuity || continuityBusy) {
        return;
      }

      const nextEnabled = !continuityEnabled;
      setContinuityBusy(true);
      try {
        const res = await fetch(
          `/api/runs/${activeRunId}/items/${targetItemId}/continuity`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: nextEnabled }),
          },
        );

        if (!res.ok) {
          const errorText = await res.text();
          showToast(errorText || "Failed to update continuity", "error");
          return;
        }

        await Promise.all([fetchQueues(activeRunId), fetchGraph(activeRunId)]);
        showToast(
          nextEnabled
            ? `Enabled continuity for ${shotLabel}`
            : `Disabled continuity for ${shotLabel}`,
        );
      } catch (error) {
        console.error("toggle continuity failed:", error);
        showToast("Failed to update continuity", "error");
      } finally {
        setContinuityBusy(false);
      }
    },
    [
      activeRunId,
      canToggleContinuity,
      continuityBusy,
      continuityEnabled,
      fetchGraph,
      fetchQueues,
      showToast,
      shotLabel,
      targetItemId,
    ],
  );

  return (
    <div
      className="story-shot-card"
      data-opens-detail
      onClick={handleCardClick}
      style={{ position: "relative" }}
    >
      {hasDraft && <DraftBadge absolute />}
      {/* Media area */}
      {playing && videoSrc ? (
        <div className="story-shot-media" style={{ aspectRatio }}>
          <video
            ref={videoRef}
            src={videoSrc}
            autoPlay
            controls
            className="story-video"
            onEnded={handleVideoEnded}
          />
        </div>
      ) : frameSrc ? (
        <div
          className={`story-shot-media${videoSrc ? " video-thumbnail" : ""}`}
          style={{ aspectRatio }}
          onClick={videoSrc ? handlePlay : undefined}
        >
          <img src={frameSrc} alt={shotLabel} />
          {videoSrc && <div className="play-overlay">▶</div>}
          {frameItem && (
            <ImageUpload itemId={frameItem.id} field="startPath" />
          )}
        </div>
      ) : (
        <div
          className="story-shot-media story-shot-placeholder"
          style={{ aspectRatio }}
        >
          <span className={`badge badge-${status}`}>
            {status.replace("_", " ")}
          </span>
        </div>
      )}

      {/* Info area */}
      <div className="story-shot-info">
        <div className="story-shot-meta">
          <span className="story-shot-number">{shotLabel}</span>
          {composition && (
            <span className="story-shot-comp">{composition}</span>
          )}
          {durationSeconds != null && (
            <span className="story-shot-duration">{durationSeconds}s</span>
          )}
          {continuityEnabled && (
            <span
              className="story-shot-continuity-indicator"
              title="Uses the previous shot for continuity"
            >
              ↔ continuity
            </span>
          )}
        </div>
        {truncatedAction && (
          <div className="story-shot-action">{truncatedAction}</div>
        )}
        <div className="story-shot-controls">
          {canToggleContinuity && (
            <button
              type="button"
              className={`story-shot-toggle${continuityEnabled ? " enabled" : ""}`}
              onClick={handleToggleContinuity}
              disabled={continuityDisabled}
            >
              {continuityBusy
                ? "Updating..."
                : continuityEnabled
                  ? "Continuity on"
                  : "Continuity off"}
            </button>
          )}
        </div>
        {showSkip && onSkipToggle && (
          <button
            type="button"
            className={`skip-shot-btn${isSkipped ? " active" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              onSkipToggle();
            }}
          >
            {isSkipped ? "Unskip" : "Skip"}
          </button>
        )}
      </div>
    </div>
  );
}

