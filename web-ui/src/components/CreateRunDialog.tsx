import { useState, useCallback, useRef, useEffect } from "react";
import { useNavigate } from "react-router";
import { useRunStore, type ImageBackend, type VideoBackend } from "../stores/run-store";

interface CreateRunDialogProps {
  open: boolean;
  onClose: () => void;
}

const ASPECT_RATIOS = [
  { value: "16:9", label: "16:9 (landscape)" },
  { value: "9:16", label: "9:16 (portrait)" },
  { value: "1:1", label: "1:1 (square)" },
] as const;

const IMAGE_BACKENDS = [
  { value: "grok", label: "Grok" },
  { value: "reve", label: "Reve" },
  { value: "nano-banana", label: "Nano Banana" },
] as const;

const VIDEO_BACKENDS = [
  { value: "grok", label: "Grok" },
  { value: "veo", label: "Veo" },
  { value: "ltx-distilled", label: "LTX Distilled" },
  { value: "ltx-full", label: "LTX Full" },
] as const;

export default function CreateRunDialog({
  open,
  onClose,
}: CreateRunDialogProps) {
  const [storyText, setStoryText] = useState("");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [needsConversion, setNeedsConversion] = useState(true);
  const [imageBackend, setImageBackend] = useState<ImageBackend>("grok");
  const [videoBackend, setVideoBackend] = useState<VideoBackend>("grok");
  const [submitting, setSubmitting] = useState(false);
  const createRun = useRunStore((s) => s.createRun);
  const navigate = useNavigate();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus textarea when dialog opens
  useEffect(() => {
    if (open) {
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [open]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const text = storyText.trim();
      if (!text || submitting) return;

      setSubmitting(true);
      try {
        await createRun(text, { aspectRatio, imageBackend, videoBackend, needsConversion });
        navigate("/");
        setStoryText("");
        setAspectRatio("16:9");
        setNeedsConversion(true);
        setImageBackend("grok");
        setVideoBackend("grok");
        onClose();
      } catch (err) {
        console.error("Failed to create run:", err);
      } finally {
        setSubmitting(false);
      }
    },
    [storyText, aspectRatio, needsConversion, imageBackend, videoBackend, submitting, createRun, navigate, onClose],
  );

  if (!open) return null;

  return (
    <div className="create-dialog-overlay" onClick={onClose}>
      <div
        className="create-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={handleSubmit}>
          <h2>New Run</h2>

          <label htmlFor="story-input">Story text</label>
          <textarea
            ref={textareaRef}
            id="story-input"
            rows={10}
            placeholder="Paste a short story here…"
            required
            value={storyText}
            onChange={(e) => setStoryText(e.target.value)}
          />

          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={needsConversion}
              onChange={(e) => setNeedsConversion(e.target.checked)}
            />
            Convert to visual script first
          </label>

          <label htmlFor="aspect-ratio-select">Aspect ratio</label>
          <select
            id="aspect-ratio-select"
            value={aspectRatio}
            onChange={(e) => setAspectRatio(e.target.value)}
          >
            {ASPECT_RATIOS.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>

          <label htmlFor="image-backend-select">Image generator</label>
          <select
            id="image-backend-select"
            value={imageBackend}
            onChange={(e) => setImageBackend(e.target.value as ImageBackend)}
          >
            {IMAGE_BACKENDS.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>

          <label htmlFor="video-backend-select">Video generator</label>
          <select
            id="video-backend-select"
            value={videoBackend}
            onChange={(e) => setVideoBackend(e.target.value as VideoBackend)}
          >
            {VIDEO_BACKENDS.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>

          <div className="dialog-actions">
            <button type="button" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={submitting}>
              {submitting ? "Creating…" : "Create Run"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

