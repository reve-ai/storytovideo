import { useEffect, useRef, useCallback } from "react";
import { useVideoEditorStore, type VideoClip, type EditorClip } from "../../stores/video-editor-store";
import { useTimelineStore, type TimelineClipMeta } from "../../stores/timeline-store";

/**
 * Find the video clip under the playhead at the given timeline time.
 */
function findClipAtTime(clips: EditorClip[], time: number): VideoClip | null {
  for (const clip of clips) {
    if (clip.type !== "video") continue;
    if (time >= clip.startTime && time < clip.startTime + clip.duration) {
      return clip as VideoClip;
    }
  }
  return null;
}

export function VideoPreview() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef<number>(0);
  const lastClipIdRef = useRef<string | null>(null);
  const lastSrcRef = useRef<string>("");

  const currentTime = useVideoEditorStore((s) => s.currentTime);
  const clips = useVideoEditorStore((s) => s.clips);
  const isPlaying = useVideoEditorStore((s) => s.isPlaying);
  const clipMeta = useTimelineStore((s) => s.clipMeta);

  const activeClip = findClipAtTime(clips, currentTime);
  const meta: TimelineClipMeta | undefined = activeClip ? clipMeta[activeClip.id] : undefined;
  const isReady = meta?.status === "ready" && !!activeClip?.assetId;

  // Seek video to correct offset within the clip
  const seekToOffset = useCallback(
    (clip: VideoClip, timelineTime: number) => {
      const video = videoRef.current;
      if (!video || !clip.assetId) return;
      const offset = timelineTime - clip.startTime + clip.inPoint;
      // Only seek if the difference is significant to avoid jitter
      if (Math.abs(video.currentTime - offset) > 0.05) {
        video.currentTime = offset;
      }
    },
    [],
  );

  // Handle clip switching — load new src when clip changes
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!activeClip || !isReady) {
      // No clip or pending — clear src
      if (lastSrcRef.current) {
        video.pause();
        video.removeAttribute("src");
        video.load();
        lastSrcRef.current = "";
        lastClipIdRef.current = null;
      }
      return;
    }

    const newSrc = activeClip.assetId;
    if (newSrc !== lastSrcRef.current) {
      video.src = newSrc;
      lastSrcRef.current = newSrc;
      lastClipIdRef.current = activeClip.id;
      video.load();
      video.addEventListener(
        "loadeddata",
        () => {
          seekToOffset(activeClip, currentTime);
          if (isPlaying) video.play().catch(() => {});
        },
        { once: true },
      );
    } else {
      seekToOffset(activeClip, currentTime);
    }
  }, [activeClip?.id, activeClip?.assetId, isReady, currentTime, seekToOffset]);

  // Play/pause sync + rAF playback loop
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying && isReady) {
      video.play().catch(() => {});
      let lastFrameTime = performance.now();

      const tick = (now: number) => {
        const dt = (now - lastFrameTime) / 1000;
        lastFrameTime = now;

        const store = useVideoEditorStore.getState();
        const newTime = store.currentTime + dt;
        const nextClip = findClipAtTime(store.clips, newTime);

        if (newTime >= store.duration) {
          // Reached end — stop
          useVideoEditorStore.getState().setIsPlaying(false);
          return;
        }

        useVideoEditorStore.getState().setCurrentTime(newTime);

        // If we crossed into a new clip, the effect above will handle src switch
        if (nextClip && nextClip.id !== lastClipIdRef.current) {
          // Will be handled by the clip-switch effect
        }

        rafRef.current = requestAnimationFrame(tick);
      };

      rafRef.current = requestAnimationFrame(tick);

      return () => {
        cancelAnimationFrame(rafRef.current);
      };
    } else {
      video.pause();
    }
  }, [isPlaying, isReady]);

  // Label text
  const label = meta
    ? `S${meta.sceneNumber} Shot ${meta.shotInScene}`
    : null;
  const statusLabel = meta?.status === "pending" ? "Pending" : null;

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        maxHeight: 360,
        aspectRatio: "16 / 9",
        background: "#000",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      <video
        ref={videoRef}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
          display: isReady ? "block" : "none",
        }}
        muted
        playsInline
        preload="auto"
      />
      {!isReady && (
        <div
          style={{
            color: "#666",
            fontSize: 14,
            textAlign: "center",
            userSelect: "none",
          }}
        >
          {statusLabel ?? (activeClip ? "No video" : "No clip at playhead")}
        </div>
      )}
      {label && (
        <div
          style={{
            position: "absolute",
            top: 8,
            left: 8,
            background: "rgba(0,0,0,0.6)",
            color: "#fff",
            fontSize: 12,
            padding: "2px 8px",
            borderRadius: 4,
            pointerEvents: "none",
          }}
        >
          {label}
          {meta?.dialogue && (
            <span style={{ marginLeft: 8, opacity: 0.7 }}>
              {meta.speaker ? `${meta.speaker}: ` : ""}
              {meta.dialogue.length > 40 ? meta.dialogue.slice(0, 40) + "…" : meta.dialogue}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
