import { useRef } from "react";

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
  const videoRef = useRef<HTMLVideoElement>(null);

  return (
    <video
      ref={videoRef}
      src={videoSrc}
      poster={thumbnailSrc}
      controls
      preload="auto"
      playsInline
      className={`w-full max-h-[inherit] object-contain rounded ${className}`}
      style={aspectRatio ? { aspectRatio } : undefined}
    />
  );
}

