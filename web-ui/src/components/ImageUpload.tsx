import { useCallback, useRef, useState } from "react";
import { usePipelineStore } from "../stores/pipeline-store";
import { useRunStore } from "../stores/run-store";

interface ImageUploadProps {
  itemId: string;
  field: string;
}

export default function ImageUpload({ itemId, field }: ImageUploadProps) {
  const activeRunId = useRunStore((s) => s.activeRunId);
  const uploadImage = usePipelineStore((s) => s.uploadImage);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      inputRef.current?.click();
    },
    [],
  );

  const handleChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !activeRunId) return;
      setUploading(true);
      try {
        await uploadImage(activeRunId, file, itemId, field);
      } finally {
        setUploading(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [activeRunId, uploadImage, itemId, field],
  );

  return (
    <>
      <button
        className="image-upload-btn"
        onClick={handleClick}
        disabled={uploading}
        title="Upload image"
      >
        {uploading ? (
          <span className="image-upload-spinner" />
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={handleChange}
      />
    </>
  );
}

