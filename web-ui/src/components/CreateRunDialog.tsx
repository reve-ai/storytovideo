import { useState, useCallback, useRef, useEffect } from "react";
import { useRunStore } from "../stores/run-store";

interface CreateRunDialogProps {
  open: boolean;
  onClose: () => void;
}

const ASPECT_RATIOS = [
  { value: "16:9", label: "16:9 (landscape)" },
  { value: "9:16", label: "9:16 (portrait)" },
  { value: "1:1", label: "1:1 (square)" },
] as const;

export default function CreateRunDialog({
  open,
  onClose,
}: CreateRunDialogProps) {
  const [storyText, setStoryText] = useState("");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [submitting, setSubmitting] = useState(false);
  const createRun = useRunStore((s) => s.createRun);
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
        await createRun(text, { aspectRatio });
        setStoryText("");
        setAspectRatio("16:9");
        onClose();
      } catch (err) {
        console.error("Failed to create run:", err);
      } finally {
        setSubmitting(false);
      }
    },
    [storyText, aspectRatio, submitting, createRun, onClose],
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

