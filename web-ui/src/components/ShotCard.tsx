import { useCallback, useRef, useState } from "react";
import { WorkItem } from "../stores/pipeline-store";
import { useRunStore } from "../stores/run-store";
import { useUIStore } from "../stores/ui-store";

interface ShotCardProps {
  shotNum: number;
  frameItem: WorkItem | undefined;
  videoItem: WorkItem | undefined;
  aspectRatio: string;
}

export default function ShotCard({
  shotNum,
  frameItem,
  videoItem,
  aspectRatio,
}: ShotCardProps) {
  const activeRunId = useRunStore((s) => s.activeRunId);
  const openDetail = useUIStore((s) => s.openDetail);
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const shot: Record<string, unknown> =
    (frameItem?.inputs?.shot as Record<string, unknown>) ??
    (videoItem?.inputs?.shot as Record<string, unknown>) ??
    {};

  const clickId = videoItem?.id ?? frameItem?.id;

  const frameCompleted = frameItem?.status === "completed";
  const videoCompleted = videoItem?.status === "completed";
  const startPath = frameItem?.outputs?.startPath as string | undefined;
  const videoPath = videoItem?.outputs?.path as string | undefined;

  const frameSrc =
    frameCompleted && startPath
      ? `/api/runs/${activeRunId}/media/${startPath}`
      : null;
  const videoSrc =
    videoCompleted && videoPath
      ? `/api/runs/${activeRunId}/media/${videoPath}`
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

  const status =
    videoItem?.status ?? frameItem?.status ?? ("pending" as string);
  const composition = shot.composition as string | undefined;
  const durationSeconds = shot.durationSeconds as number | undefined;
  const actionPrompt = shot.actionPrompt as string | undefined;
  const truncatedAction =
    actionPrompt && actionPrompt.length > 100
      ? actionPrompt.slice(0, 100) + "…"
      : actionPrompt;

  return (
    <div className="story-shot-card" onClick={handleCardClick}>
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
          <img src={frameSrc} alt={`Shot ${shotNum}`} />
          {videoSrc && <div className="play-overlay">▶</div>}
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
          <span className="story-shot-number">Shot {shotNum}</span>
          {composition && (
            <span className="story-shot-comp">{composition}</span>
          )}
          {durationSeconds != null && (
            <span className="story-shot-duration">{durationSeconds}s</span>
          )}
        </div>
        {truncatedAction && (
          <div className="story-shot-action">{truncatedAction}</div>
        )}
      </div>
    </div>
  );
}

