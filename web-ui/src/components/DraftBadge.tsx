import type { CSSProperties } from "react";

interface DraftBadgeProps {
  /** Optional positioning override; defaults to absolute top-right when `absolute` is true. */
  absolute?: boolean;
  style?: CSSProperties;
  title?: string;
}

/**
 * Small accent dot used to flag a chat scope with unapplied changes.
 * Visual: 10px circle in --accent with a soft glow, tooltip on hover.
 * Click handling is intentionally absent — the surrounding control already
 * navigates the user to the relevant chat panel.
 */
export default function DraftBadge({ absolute = false, style, title }: DraftBadgeProps) {
  const baseStyle: CSSProperties = {
    display: "inline-block",
    width: 10,
    height: 10,
    borderRadius: "50%",
    background: "var(--accent)",
    boxShadow: "0 0 0 2px var(--surface), 0 0 6px rgba(79, 143, 247, 0.7)",
    pointerEvents: "auto",
  };
  const positioned: CSSProperties = absolute
    ? { position: "absolute", top: 6, right: 6, zIndex: 2 }
    : { marginLeft: 6, verticalAlign: "middle" };
  return (
    <span
      aria-label="Unapplied chat changes"
      title={title ?? "Unapplied chat changes — click to return"}
      style={{ ...baseStyle, ...positioned, ...style }}
    />
  );
}
