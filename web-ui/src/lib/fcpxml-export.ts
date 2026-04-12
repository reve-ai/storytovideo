/**
 * FCP 7 XML Export (xmeml version="5")
 *
 * Generates FCP 7 XML format from the editor timeline state.
 * The exported .xml file can be imported natively into Adobe Premiere Pro,
 * preserving clip positions, durations, and track layout.
 *
 * Architecture:
 * - Uses xmeml version="5" root element
 * - All times expressed in frames (integers)
 * - Clips go in <clipitem> inside <track> inside <video>/<audio> inside <media>
 * - File references: first occurrence has full details, subsequent are self-closing
 * - Video clips automatically generate linked audio clipitems
 * - Uses <link> elements to bind video and audio clipitems from the same source
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

// ===================== FCP 7 UTILITIES =====================

/** Check if a frame rate is an NTSC rate (23.976, 29.97, 59.94). */
function isNtsc(fps: number): boolean {
  return (
    Math.abs(fps - 23.976) < 0.01 ||
    Math.abs(fps - 29.97) < 0.01 ||
    Math.abs(fps - 59.94) < 0.01
  );
}

/** Get the integer timebase for a frame rate. NTSC rates round up (29.97→30). */
function getTimebase(fps: number): number {
  if (Math.abs(fps - 23.976) < 0.01) return 24;
  if (Math.abs(fps - 29.97) < 0.01) return 30;
  if (Math.abs(fps - 59.94) < 0.01) return 60;
  return Math.round(fps);
}

/** Get the exact fps value for frame calculations. */
function getExactFps(fps: number): number {
  if (Math.abs(fps - 23.976) < 0.01) return 24000 / 1001;
  if (Math.abs(fps - 29.97) < 0.01) return 30000 / 1001;
  if (Math.abs(fps - 59.94) < 0.01) return 60000 / 1001;
  return Math.round(fps);
}

/** Convert seconds to frames. */
function secondsToFrames(seconds: number, fps: number): number {
  return Math.round(seconds * getExactFps(fps));
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Extract a relative file path from an asset ID / URL.
 * Asset IDs look like: /api/runs/{runId}/media/videos/scene_01_shot_01_v1.mp4
 * We extract the part after /media/ to get: videos/scene_01_shot_01_v1.mp4
 */
function extractRelativePath(assetId: string): string {
  const mediaIdx = assetId.indexOf("/media/");
  if (mediaIdx >= 0) {
    return decodeURIComponent(assetId.slice(mediaIdx + "/media/".length));
  }
  // If no /media/ prefix, use as-is (already a relative path or filename)
  return decodeURIComponent(assetId);
}

/** Get just the filename from an asset path. */
function extractFilename(assetId: string): string {
  const rel = extractRelativePath(assetId);
  const lastSlash = rel.lastIndexOf("/");
  return lastSlash >= 0 ? rel.slice(lastSlash + 1) : rel;
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

// ===================== RATE HELPER =====================

function writeRate(xml: XmlBuilder, fps: number): void {
  xml.open(`<rate>`);
  xml.line(`<timebase>${getTimebase(fps)}</timebase>`);
  xml.line(`<ntsc>${isNtsc(fps) ? "TRUE" : "FALSE"}</ntsc>`);
  xml.close(`</rate>`);
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

  const totalFrames = secondsToFrames(totalDuration, fps);

  // Sort tracks
  const videoTracks = tracks.filter((t) => t.type === "video").sort((a, b) => a.index - b.index);
  const audioTracks = tracks.filter((t) => t.type === "audio").sort((a, b) => a.index - b.index);

  // Group clips by track
  const clipsByTrack = new Map<string, EditorClip[]>();
  for (const clip of clips) {
    const arr = clipsByTrack.get(clip.trackId) ?? [];
    arr.push(clip);
    clipsByTrack.set(clip.trackId, arr);
  }

  // Track which file IDs have been fully written (first occurrence gets full details)
  const writtenFileIds = new Set<string>();
  let clipItemCounter = 0;

  // Pre-assign clipitem IDs for video clips and their linked audio so we can
  // write <link> elements during the first pass.
  // videoItemId → audioItemId mapping
  const videoToLinkedAudioId = new Map<string, string>();
  const clipIdToItemId = new Map<string, string>();

  // First pass: assign IDs
  {
    let counter = 0;
    for (const track of videoTracks) {
      const trackClips = (clipsByTrack.get(track.id) ?? []).filter(
        (c) => c.type === "video" || c.type === "image",
      );
      trackClips.sort((a, b) => a.startTime - b.startTime);
      for (const clip of trackClips) {
        counter++;
        clipIdToItemId.set(clip.id, `clipitem-${counter}`);
      }
    }
    // Linked audio track items (one per video track)
    for (const track of videoTracks) {
      const trackClips = (clipsByTrack.get(track.id) ?? []).filter((c) => c.type === "video");
      trackClips.sort((a, b) => a.startTime - b.startTime);
      for (const clip of trackClips) {
        counter++;
        const audioItemId = `clipitem-${counter}`;
        const videoItemId = clipIdToItemId.get(clip.id)!;
        videoToLinkedAudioId.set(videoItemId, audioItemId);
        // Also map the linked audio clip's id if it exists
        if (clip.type === "video" && clip.linkedClipId) {
          clipIdToItemId.set(clip.linkedClipId, audioItemId);
        }
      }
    }
    // Standalone audio clips
    for (const track of audioTracks) {
      const trackClips = (clipsByTrack.get(track.id) ?? []).filter((c) => c.type === "audio");
      for (const clip of trackClips) {
        if (clip.type === "audio" && clip.linkedClipId) {
          const linkedClip = clips.find((c) => c.id === clip.linkedClipId);
          if (linkedClip && linkedClip.type === "video") continue;
        }
        counter++;
        clipIdToItemId.set(clip.id, `clipitem-${counter}`);
      }
    }
  }

  const xml = new XmlBuilder();

  xml.line(`<?xml version="1.0" encoding="UTF-8"?>`);
  xml.line(`<!DOCTYPE xmeml>`);
  xml.open(`<xmeml version="5">`);
  xml.open(`<sequence>`);
  xml.line(`<name>Timeline</name>`);
  xml.line(`<duration>${totalFrames}</duration>`);
  writeRate(xml, fps);

  // Timecode
  xml.open(`<timecode>`);
  writeRate(xml, fps);
  xml.line(`<frame>0</frame>`);
  xml.line(`<displayformat>NDF</displayformat>`);
  xml.close(`</timecode>`);

  // Media
  xml.open(`<media>`);

  // ---- Video ----
  xml.open(`<video>`);
  xml.open(`<format>`);
  xml.open(`<samplecharacteristics>`);
  xml.line(`<width>${width}</width>`);
  xml.line(`<height>${height}</height>`);
  xml.line(`<pixelaspectratio>square</pixelaspectratio>`);
  xml.close(`</samplecharacteristics>`);
  xml.close(`</format>`);

  for (const track of videoTracks) {
    const trackClips = (clipsByTrack.get(track.id) ?? []).filter(
      (c) => c.type === "video" || c.type === "image",
    );
    trackClips.sort((a, b) => a.startTime - b.startTime);

    xml.open(`<track>`);
    for (const clip of trackClips) {
      if (clip.type !== "video" && clip.type !== "image") continue;
      clipItemCounter++;
      const itemId = `clipitem-${clipItemCounter}`;

      const asset = assetMap.get(clip.assetId);
      const clipName = escapeXml(clip.name || asset?.name || extractFilename(clip.assetId));
      const fileId = `file-${clip.assetId}`;
      const relativePath = extractRelativePath(clip.assetId);

      const inPoint = clip.inPoint || 0;
      const startFrame = secondsToFrames(clip.startTime, fps);
      const endFrame = secondsToFrames(clip.startTime + clip.duration, fps);
      const inFrame = secondsToFrames(inPoint, fps);
      const outFrame = inFrame + (endFrame - startFrame);
      const assetDurFrames = asset?.duration ? secondsToFrames(asset.duration, fps) : outFrame;

      xml.open(`<clipitem id="${itemId}">`);
      xml.line(`<name>${clipName}</name>`);
      xml.line(`<duration>${assetDurFrames}</duration>`);
      writeRate(xml, fps);
      xml.line(`<start>${startFrame}</start>`);
      xml.line(`<end>${endFrame}</end>`);
      xml.line(`<in>${inFrame}</in>`);
      xml.line(`<out>${outFrame}</out>`);

      if (!writtenFileIds.has(fileId)) {
        writtenFileIds.add(fileId);
        xml.open(`<file id="${fileId}">`);
        xml.line(`<name>${escapeXml(extractFilename(clip.assetId))}</name>`);
        xml.line(`<pathurl>file://localhost/${escapeXml(relativePath)}</pathurl>`);
        xml.line(`<duration>${assetDurFrames}</duration>`);
        writeRate(xml, fps);
        xml.open(`<media>`);
        xml.open(`<video>`);
        xml.open(`<samplecharacteristics>`);
        xml.line(`<width>${width}</width>`);
        xml.line(`<height>${height}</height>`);
        xml.close(`</samplecharacteristics>`);
        xml.close(`</video>`);
        if (clip.type === "video") {
          xml.open(`<audio>`);
          xml.open(`<samplecharacteristics>`);
          xml.line(`<depth>16</depth>`);
          xml.line(`<samplerate>48000</samplerate>`);
          xml.close(`</samplecharacteristics>`);
          xml.close(`</audio>`);
        }
        xml.close(`</media>`);
        xml.close(`</file>`);
      } else {
        xml.line(`<file id="${fileId}"/>`);
      }

      // Write link elements to bind this video clipitem with its linked audio
      const linkedAudioItemId = videoToLinkedAudioId.get(itemId);
      if (linkedAudioItemId) {
        xml.open(`<link>`);
        xml.line(`<linkclipref>${itemId}</linkclipref>`);
        xml.line(`<mediatype>video</mediatype>`);
        xml.line(`<trackindex>1</trackindex>`);
        xml.line(`<clipindex>1</clipindex>`);
        xml.close(`</link>`);
        xml.open(`<link>`);
        xml.line(`<linkclipref>${linkedAudioItemId}</linkclipref>`);
        xml.line(`<mediatype>audio</mediatype>`);
        xml.line(`<trackindex>1</trackindex>`);
        xml.line(`<clipindex>1</clipindex>`);
        xml.close(`</link>`);
      }

      xml.close(`</clipitem>`);
    }

    // Skip text clips with a comment
    const textClips = (clipsByTrack.get(track.id) ?? []).filter((c) => c.type === "text");
    for (const clip of textClips) {
      xml.line(`<!-- text clip "${escapeXml(clip.id)}" skipped (not supported in FCP 7 XML) -->`);
    }

    xml.close(`</track>`);
  }
  xml.close(`</video>`);

  // ---- Audio ----
  xml.open(`<audio>`);
  xml.open(`<format>`);
  xml.open(`<samplecharacteristics>`);
  xml.line(`<depth>16</depth>`);
  xml.line(`<samplerate>48000</samplerate>`);
  xml.close(`</samplecharacteristics>`);
  xml.close(`</format>`);

  // Track 1: Linked audio from video clips (embedded audio from video files)
  // For each video track, create a corresponding audio track with linked audio
  for (const track of videoTracks) {
    const trackClips = (clipsByTrack.get(track.id) ?? []).filter((c) => c.type === "video");
    if (trackClips.length === 0) continue;
    trackClips.sort((a, b) => a.startTime - b.startTime);

    xml.open(`<track>`);
    for (const clip of trackClips) {
      if (clip.type !== "video") continue;
      clipItemCounter++;
      const itemId = `clipitem-${clipItemCounter}`;
      const videoItemId = clipIdToItemId.get(clip.id)!;

      const asset = assetMap.get(clip.assetId);
      const clipName = escapeXml(clip.name || asset?.name || extractFilename(clip.assetId));
      const fileId = `file-${clip.assetId}`;

      const inPoint = clip.inPoint || 0;
      const startFrame = secondsToFrames(clip.startTime, fps);
      const endFrame = secondsToFrames(clip.startTime + clip.duration, fps);
      const inFrame = secondsToFrames(inPoint, fps);
      const outFrame = inFrame + (endFrame - startFrame);
      const assetDurFrames = asset?.duration ? secondsToFrames(asset.duration, fps) : outFrame;

      xml.open(`<clipitem id="${itemId}">`);
      xml.line(`<name>${clipName}</name>`);
      xml.line(`<duration>${assetDurFrames}</duration>`);
      writeRate(xml, fps);
      xml.line(`<start>${startFrame}</start>`);
      xml.line(`<end>${endFrame}</end>`);
      xml.line(`<in>${inFrame}</in>`);
      xml.line(`<out>${outFrame}</out>`);
      xml.line(`<file id="${fileId}"/>`);

      // Write matching link elements (same as on the video clipitem)
      xml.open(`<link>`);
      xml.line(`<linkclipref>${videoItemId}</linkclipref>`);
      xml.line(`<mediatype>video</mediatype>`);
      xml.line(`<trackindex>1</trackindex>`);
      xml.line(`<clipindex>1</clipindex>`);
      xml.close(`</link>`);
      xml.open(`<link>`);
      xml.line(`<linkclipref>${itemId}</linkclipref>`);
      xml.line(`<mediatype>audio</mediatype>`);
      xml.line(`<trackindex>1</trackindex>`);
      xml.line(`<clipindex>1</clipindex>`);
      xml.close(`</link>`);

      xml.close(`</clipitem>`);
    }
    xml.close(`</track>`);
  }

  // Remaining audio tracks: standalone audio clips (music, voiceover, etc.)
  for (const track of audioTracks) {
    const trackClips = (clipsByTrack.get(track.id) ?? []).filter((c) => c.type === "audio");
    if (trackClips.length === 0) continue;
    trackClips.sort((a, b) => a.startTime - b.startTime);

    xml.open(`<track>`);
    for (const clip of trackClips) {
      if (clip.type !== "audio") continue;

      // Skip audio clips that are linked to video clips (already handled above)
      if (clip.linkedClipId) {
        const linkedClip = clips.find((c) => c.id === clip.linkedClipId);
        if (linkedClip && linkedClip.type === "video") continue;
      }

      clipItemCounter++;
      const itemId = `clipitem-${clipItemCounter}`;


      const asset = assetMap.get(clip.assetId);
      const clipName = escapeXml(clip.name || asset?.name || extractFilename(clip.assetId));
      const fileId = `file-${clip.assetId}`;
      const relativePath = extractRelativePath(clip.assetId);

      const inPoint = clip.inPoint || 0;
      const startFrame = secondsToFrames(clip.startTime, fps);
      const endFrame = secondsToFrames(clip.startTime + clip.duration, fps);
      const inFrame = secondsToFrames(inPoint, fps);
      const outFrame = inFrame + (endFrame - startFrame);
      const assetDurFrames = asset?.duration ? secondsToFrames(asset.duration, fps) : outFrame;

      xml.open(`<clipitem id="${itemId}">`);
      xml.line(`<name>${clipName}</name>`);
      xml.line(`<duration>${assetDurFrames}</duration>`);
      writeRate(xml, fps);
      xml.line(`<start>${startFrame}</start>`);
      xml.line(`<end>${endFrame}</end>`);
      xml.line(`<in>${inFrame}</in>`);
      xml.line(`<out>${outFrame}</out>`);

      if (!writtenFileIds.has(fileId)) {
        writtenFileIds.add(fileId);
        xml.open(`<file id="${fileId}">`);
        xml.line(`<name>${escapeXml(extractFilename(clip.assetId))}</name>`);
        xml.line(`<pathurl>file://localhost/${escapeXml(relativePath)}</pathurl>`);
        xml.line(`<duration>${assetDurFrames}</duration>`);
        writeRate(xml, fps);
        xml.open(`<media>`);
        xml.open(`<audio>`);
        xml.open(`<samplecharacteristics>`);
        xml.line(`<depth>16</depth>`);
        xml.line(`<samplerate>48000</samplerate>`);
        xml.close(`</samplecharacteristics>`);
        xml.close(`</audio>`);
        xml.close(`</media>`);
        xml.close(`</file>`);
      } else {
        xml.line(`<file id="${fileId}"/>`);
      }

      xml.close(`</clipitem>`);
    }
    xml.close(`</track>`);
  }

  xml.close(`</audio>`);

  xml.close(`</media>`);
  xml.close(`</sequence>`);
  xml.close(`</xmeml>`);

  return xml.toString();
}

// ===================== DOWNLOAD =====================

/** Download an FCP 7 XML string as a .xml file. */
export function downloadFcpxml(xml: string, filename?: string): void {
  const blob = new Blob([xml], { type: "application/xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || `export-${Date.now()}.xml`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
