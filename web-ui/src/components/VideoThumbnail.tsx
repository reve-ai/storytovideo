import { useCallback, useRef, useState } from "react";

interface VideoThumbnailProps {
  videoSrc: string;
  thumbnailSrc?: string;
  className?: string;
  aspectRatio?: string;
}

export default function VideoThumbnail({
  videoSrc,
  thumbnailSrc,
  className = "",
  aspectRatio,
}: VideoThumbnailProps) {
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const handlePlay = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setPlaying(true);
    },
    [],
  );

  const handleEnded = useCallback(() => {
    setPlaying(false);
  }, []);

  if (playing) {
    return (
      <video
        ref={videoRef}
        src={videoSrc}
        controls
        autoPlay
        onEnded={handleEnded}
        className={`w-full max-h-[inherit] object-contain rounded ${className}`}
        style={aspectRatio ? { aspectRatio } : undefined}
      />
    );
  }

  return (
    <div
      className={`relative cursor-pointer overflow-hidden rounded ${className}`}
      style={aspectRatio ? { aspectRatio } : undefined}
      onClick={handlePlay}
    >
      {thumbnailSrc ? (
        <img
          src={thumbnailSrc}
          alt="Video thumbnail"
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-[--surface2]" />
      )}
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="rounded-full bg-black/60 px-3 py-1.5 text-lg text-white">
          ▶
        </span>
      </div>
    </div>
  );
}

