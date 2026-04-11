/**
 * Final Cut Pro XML (FCPXML) Export
 *
 * Generates FCPXML 1.11 format from the editor timeline state.
 * The exported file can be imported into Final Cut Pro, preserving
 * clip positions, durations, transforms, text elements, and audio levels.
 *
 * Architecture:
 * - Uses a single gap element as the spine, with all clips as connected clips
 * - Video tracks map to positive lane numbers, audio tracks to negative lanes
 * - Text clips export as FCPXML title elements with styling
 * - Speed changes are expressed via timeMap elements
 */

import type { EditorClip, ProjectSettings } from "../stores/video-editor-store";
import type { EditableTrack } from "./render-engine";

// ===================== TYPES =====================

export interface FcpxmlExportInput {
  clips: EditorClip[];
  tracks: EditableTrack[];
  settings: ProjectSettings;
  /** Asset metadata for resolving names and durations */
  assets: Array<{ id: string; name: string; type: string; duration: number }>;
}

// ===================== MATH UTILITIES =====================

function gcd(a: number, b: number): number {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) {
    [a, b] = [b, a % b];
  }
  return a || 1;
}

interface RationalRate {
  num: number;
  den: number;
}

/**
 * Get the exact rational representation of a frame rate.
 * Handles common NTSC drop-frame rates (23.976, 29.97, 59.94).
 */
function getFpsRational(fps: number): RationalRate {
  if (Math.abs(fps - 23.976) < 0.01) return { num: 24000, den: 1001 };
  if (Math.abs(fps - 29.97) < 0.01) return { num: 30000, den: 1001 };
  if (Math.abs(fps - 59.94) < 0.01) return { num: 60000, den: 1001 };
  return { num: Math.round(fps), den: 1 };
}

/**
 * Convert seconds to FCPXML rational time format (e.g., "5/1s", "1001/200s").
 * Frame-accurate using the timeline's frame rate.
 */
function toRationalTime(seconds: number, fps: number): string {
  if (Math.abs(seconds) < 1e-6) return "0/1s";
  const rate = getFpsRational(fps);
  const frames = Math.round((seconds * rate.num) / rate.den);
  const num = frames * rate.den;
  const den = rate.num;
  const g = gcd(num, den);
  return `${num / g}/${den / g}s`;
}

/**
 * Get the FCPXML frameDuration string for the format resource.
 */
function getFrameDuration(fps: number): string {
  const rate = getFpsRational(fps);
  const g = gcd(rate.den, rate.num);
  return `${rate.den / g}/${rate.num / g}s`;
}

// ===================== XML UTILITIES =====================

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Convert linear volume (0-1) to decibels string. */
function volumeToDb(volume: number): string {
  if (volume <= 0) return "-96.00";
  return (20 * Math.log10(volume)).toFixed(2);
}

/** Convert RGBA color [0-1] to FCPXML color string. */
function toFcpColor(color: [number, number, number, number]): string {
  return `${color[0].toFixed(4)} ${color[1].toFixed(4)} ${color[2].toFixed(4)} ${color[3].toFixed(4)}`;
}

// ===================== XML BUILDER =====================

class XmlBuilder {
  private lines: string[] = [];
  private indent = 0;

  line(content: string): void {
    this.lines.push("  ".repeat(this.indent) + content);
  }

  open(tag: string): void {
    this.line(tag);
    this.indent++;
  }

  close(tag: string): void {
    this.indent--;
    this.line(tag);
  }

  toString(): string {
    return this.lines.join("\n");
  }
}

// ===================== TRANSFORM HELPER =====================

function addTransformElement(
  xml: XmlBuilder,
  transform:
    | Partial<{
        x: number;
        y: number;
        scale_x: number;
        scale_y: number;
        rotation: number;
      }>
    | undefined,
): void {
  if (!transform) return;

  const x = transform.x ?? 0;
  const y = transform.y ?? 0;
  const scaleX = (transform.scale_x ?? 1) * 100;
  const scaleY = (transform.scale_y ?? 1) * 100;
  const rotation = transform.rotation ?? 0;

  const hasPosition = Math.abs(x) > 0.01 || Math.abs(y) > 0.01;
  const hasScale = Math.abs(scaleX - 100) > 0.01 || Math.abs(scaleY - 100) > 0.01;
  const hasRotation = Math.abs(rotation) > 0.01;

  if (hasPosition || hasScale || hasRotation) {
    // FCP uses center-origin, Y-up; editor uses Y-down
    xml.line(
      `<adjust-transform position="${x.toFixed(2)} ${(-y).toFixed(2)}" scale="${scaleX.toFixed(2)} ${scaleY.toFixed(2)}" rotation="${rotation.toFixed(2)}"/>`,
    );
  }
}

// ===================== MAIN EXPORT =====================

export function generateFcpxml(input: FcpxmlExportInput): string {
  const { clips, tracks, settings, assets } = input;
  const { width, height, fps } = settings;

  // Build asset lookup
  const assetMap = new Map(assets.map((a) => [a.id, a]));

  // Calculate total duration from clips
  const totalDuration =
    clips.length > 0 ? Math.max(...clips.map((c) => c.startTime + c.duration)) : 0;

  if (totalDuration <= 0) {
    throw new Error("No content to export");
  }

  // Assign resource IDs
  let nextId = 1;
  const formatId = `r${nextId++}`;

  // Register all assets as resources (including those not on the timeline)
  const assetResourceIds = new Map<string, string>();
  for (const asset of assets) {
    if (!assetResourceIds.has(asset.id)) {
      assetResourceIds.set(asset.id, `r${nextId++}`);
    }
  }

  // Title effect resource (if any text clips exist)
  const hasTitles = clips.some((c) => c.type === "text");
  const titleEffectId = hasTitles ? `r${nextId++}` : "";

  // Build track -> lane mapping
  // Video tracks: positive lanes (sorted by index ascending)
  // Audio tracks: negative lanes
  const videoTracks = tracks.filter((t) => t.type === "video").sort((a, b) => a.index - b.index);
  const audioTracks = tracks.filter((t) => t.type === "audio").sort((a, b) => a.index - b.index);

  const trackLaneMap = new Map<string, number>();
  videoTracks.forEach((t, i) => trackLaneMap.set(t.id, i + 1));
  audioTracks.forEach((t, i) => trackLaneMap.set(t.id, -(i + 1)));

  const xml = new XmlBuilder();

  xml.line(`<?xml version="1.0" encoding="UTF-8"?>`);
  xml.line(`<!DOCTYPE fcpxml>`);
  xml.open(`<fcpxml version="1.11">`);

  // ---- Resources ----
  xml.open(`<resources>`);
  xml.line(
    `<format id="${formatId}" name="FFVideoFormat_${width}x${height}p${Math.round(fps)}" frameDuration="${getFrameDuration(fps)}" width="${width}" height="${height}"/>`,
  );

  for (const [assetId, resId] of assetResourceIds) {
    const asset = assetMap.get(assetId);
    const name = escapeXml(asset?.name || assetId);
    const assetType = asset?.type || "video";
    const hasVideo = assetType === "video" || assetType === "image" ? "1" : "0";
    const hasAudio = assetType === "audio" || assetType === "video" ? "1" : "0";
    const assetDur = asset?.duration ? toRationalTime(asset.duration, fps) : "0/1s";

    xml.open(
      `<asset id="${resId}" name="${name}" start="0/1s" duration="${assetDur}" hasVideo="${hasVideo}" hasAudio="${hasAudio}" format="${formatId}">`,
    );
    xml.line(`<media-rep kind="original-media" src="${escapeXml(name)}"/>`);
    xml.close(`</asset>`);
  }

  if (hasTitles) {
    xml.line(
      `<effect id="${titleEffectId}" name="Basic Title" uid=".../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti"/>`,
    );
  }

  xml.close(`</resources>`);

  // ---- Library > Event > Project > Sequence ----
  xml.open(`<library>`);
  xml.open(`<event name="Exported Timeline">`);
  xml.open(`<project name="Untitled Project">`);
  xml.open(
    `<sequence format="${formatId}" duration="${toRationalTime(totalDuration, fps)}" tcStart="0/1s" tcFormat="NDF">`,
  );
  xml.open(`<spine>`);

  // Single gap as the spine backbone — all clips are connected to it
  xml.open(
    `<gap name="Gap" offset="0/1s" start="0/1s" duration="${toRationalTime(totalDuration, fps)}">`,
  );

  for (const clip of clips) {
    const lane = trackLaneMap.get(clip.trackId) ?? 1;
    const offset = toRationalTime(clip.startTime, fps);
    const duration = toRationalTime(clip.duration, fps);

    switch (clip.type) {
      case "video":
      case "image": {
        const resId = assetResourceIds.get(clip.assetId) ?? "";
        const asset = assetMap.get(clip.assetId);
        const clipName = escapeXml(clip.name || asset?.name || clip.assetId);
        const inPoint = clip.inPoint || 0;
        const speed = clip.speed || 1;
        const start = toRationalTime(inPoint, fps);

        xml.open(
          `<asset-clip ref="${resId}" lane="${lane}" offset="${offset}" name="${clipName}" duration="${duration}" start="${start}" tcFormat="NDF">`,
        );

        // Speed change via timeMap
        if (Math.abs(speed - 1) > 0.001) {
          const sourceEnd = toRationalTime(inPoint + clip.duration * speed, fps);
          const clipDur = toRationalTime(clip.duration, fps);
          xml.open(`<timeMap>`);
          xml.line(`<timept time="0/1s" value="${start}" interp="linear"/>`);
          xml.line(`<timept time="${clipDur}" value="${sourceEnd}" interp="linear"/>`);
          xml.close(`</timeMap>`);
        }

        addTransformElement(xml, clip.transform);

        if (clip.effects?.opacity !== undefined && Math.abs(clip.effects.opacity - 1) > 0.001) {
          xml.line(`<adjust-blend amount="${(clip.effects.opacity * 100).toFixed(2)}"/>`);
        }

        if (
          clip.type === "video" &&
          clip.volume !== undefined &&
          Math.abs(clip.volume - 1) > 0.001
        ) {
          xml.line(`<adjust-volume amount="${volumeToDb(clip.volume)}dB"/>`);
        }

        xml.close(`</asset-clip>`);
        break;
      }

      case "audio": {
        const resId = assetResourceIds.get(clip.assetId) ?? "";
        const asset = assetMap.get(clip.assetId);
        const clipName = escapeXml(clip.name || asset?.name || clip.assetId);
        const inPoint = clip.inPoint || 0;
        const speed = clip.speed || 1;
        const start = toRationalTime(inPoint, fps);

        xml.open(
          `<asset-clip ref="${resId}" lane="${lane}" offset="${offset}" name="${clipName}" duration="${duration}" start="${start}" tcFormat="NDF">`,
        );

        if (Math.abs(speed - 1) > 0.001) {
          const sourceEnd = toRationalTime(inPoint + clip.duration * speed, fps);
          const clipDur = toRationalTime(clip.duration, fps);
          xml.open(`<timeMap>`);
          xml.line(`<timept time="0/1s" value="${start}" interp="linear"/>`);
          xml.line(`<timept time="${clipDur}" value="${sourceEnd}" interp="linear"/>`);
          xml.close(`</timeMap>`);
        }

        if (clip.volume !== undefined && Math.abs(clip.volume - 1) > 0.001) {
          xml.line(`<adjust-volume amount="${volumeToDb(clip.volume)}dB"/>`);
        }

        xml.close(`</asset-clip>`);
        break;
      }

      case "text": {
        const clipName = escapeXml(clip.name || clip.text.substring(0, 30));
        const textContent = escapeXml(clip.text);
        const style = clip.textStyle;
        const tsId = `ts_${clip.id.replace(/[^a-zA-Z0-9]/g, "_")}`;

        const refAttr = titleEffectId ? `ref="${titleEffectId}" ` : "";
        xml.open(
          `<title ${refAttr}lane="${lane}" offset="${offset}" name="${clipName}" duration="${duration}" start="0/1s">`,
        );

        addTransformElement(xml, clip.transform);

        if (clip.effects?.opacity !== undefined && Math.abs(clip.effects.opacity - 1) > 0.001) {
          xml.line(`<adjust-blend amount="${(clip.effects.opacity * 100).toFixed(2)}"/>`);
        }

        xml.open(`<text>`);
        xml.line(`<text-style ref="${tsId}">${textContent}</text-style>`);
        xml.close(`</text>`);

        const fontSize = style.font_size || 48;
        const fontFamily = escapeXml(style.font_family || "Helvetica");
        const fontFace =
          (style.font_weight || 400) >= 700
            ? style.italic
              ? "Bold Italic"
              : "Bold"
            : style.italic
              ? "Italic"
              : "Regular";
        const fontColor = style.color
          ? toFcpColor(style.color)
          : "1.0000 1.0000 1.0000 1.0000";
        const alignment =
          style.text_align === "Left"
            ? "left"
            : style.text_align === "Right"
              ? "right"
              : "center";

        xml.open(`<text-style-def id="${tsId}">`);
        xml.line(
          `<text-style font="${fontFamily}" fontSize="${fontSize}" fontFace="${fontFace}" fontColor="${fontColor}" alignment="${alignment}"/>`,
        );
        xml.close(`</text-style-def>`);

        xml.close(`</title>`);
        break;
      }

      case "shape":
      case "line":
        // No direct FCPXML equivalent for shapes and lines
        xml.line(
          `<!-- ${clip.type} clip "${escapeXml(clip.id)}" skipped (no FCPXML equivalent) -->`,
        );
        break;
    }
  }

  xml.close(`</gap>`);
  xml.close(`</spine>`);
  xml.close(`</sequence>`);
  xml.close(`</project>`);
  xml.close(`</event>`);
  xml.close(`</library>`);
  xml.close(`</fcpxml>`);

  return xml.toString();
}

// ===================== DOWNLOAD =====================

/** Download an FCPXML string as a .fcpxml file. */
export function downloadFcpxml(xml: string, filename?: string): void {
  const blob = new Blob([xml], { type: "application/xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || `export-${Date.now()}.fcpxml`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
