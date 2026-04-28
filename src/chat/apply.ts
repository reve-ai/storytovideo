import { copyFileSync, existsSync, mkdirSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { randomUUID } from "crypto";

import type { RunManager } from "../queue/run-manager.js";
import type { QueueManager } from "../queue/queue-manager.js";
import type { Shot } from "../types.js";
import type { ShotDraft } from "./types.js";
import { shotFrameInputsHash, shotVideoInputsHash } from "./preview-hash.js";
import { buildStartFramePath } from "../tools/generate-frame.js";
import { buildVideoOutputPath } from "../tools/generate-video.js";

interface ApplyShotDraftResult {
  ok: boolean;
  regeneratedItemIds: string[];
  imageReplacementsApplied: Array<{ which: "start" | "end"; path: string }>;
  /** Kinds of preview artifacts that were promoted instead of regenerated.
   *  Empty for legacy (non-smart) applies. Useful for tests/telemetry/UI. */
  promoted: Array<"frame" | "video">;
}

function resolveOutputDirAbs(outputDir: string): string {
  return isAbsolute(outputDir) ? outputDir : resolve(process.cwd(), outputDir);
}

function nextItemVersion(qm: QueueManager, itemKey: string): number {
  const items = qm.getItemsByKey(itemKey);
  if (items.length === 0) return 1;
  return Math.max(...items.map((i) => i.version)) + 1;
}

/** Try to promote a sandbox frame preview into the canonical start-frame
 *  output. Returns the new item id on success, or null if anything is
 *  ambiguous — caller falls back to redoItem. Promotion is a pure
 *  optimization: any failure here must be silently skipped. */
function tryPromoteShotFrame(
  runManager: RunManager,
  qm: QueueManager,
  runId: string,
  sceneNumber: number,
  shotInScene: number,
  draft: ShotDraft,
  outputDirAbs: string,
): string | null {
  const previewArt = draft.previewArtifacts?.frame;
  if (!previewArt) return null;

  const analysis = qm.getState().storyAnalysis;
  if (!analysis) return null;
  const shot = analysis.scenes
    .find((s) => s.sceneNumber === sceneNumber)
    ?.shots.find((s) => s.shotInScene === shotInScene);
  if (!shot) return null;

  // Stale-check: hash the post-mutation shot and compare to what was hashed
  // when the preview was generated. Mismatch = preview is no longer valid.
  const expected = shotFrameInputsHash({ artStyle: analysis.artStyle, shot });
  if (expected !== previewArt.inputsHash) return null;

  const sandboxAbs = isAbsolute(previewArt.sandboxPath)
    ? previewArt.sandboxPath
    : join(outputDirAbs, previewArt.sandboxPath);
  if (!existsSync(sandboxAbs)) return null;

  const itemKey = `frame:scene:${sceneNumber}:shot:${shotInScene}`;
  const items = qm.getItemsByKey(itemKey);
  if (items.length === 0) return null;
  const activeFrame = items.find(
    (i) => i.status !== "superseded" && i.status !== "cancelled",
  );
  if (!activeFrame) return null;

  const version = nextItemVersion(qm, itemKey);
  const canonicalAbs = buildStartFramePath({
    outputDir: outputDirAbs,
    sceneNumber,
    shotInScene,
    version,
  });
  const canonicalRel = relative(outputDirAbs, canonicalAbs);

  try {
    mkdirSync(dirname(canonicalAbs), { recursive: true });
    copyFileSync(sandboxAbs, canonicalAbs);
  } catch (err) {
    console.warn(`[applyShotDraft] frame promotion copy failed: ${(err as Error).message}`);
    return null;
  }

  qm.setGeneratedOutput(
    `frame:scene:${sceneNumber}:shot:${shotInScene}:start`,
    canonicalRel,
  );

  const newItem = runManager.promoteCompletedItem({
    runId,
    itemKey,
    supersedeId: activeFrame.id,
    inputsOverride: { shot },
    outputs: { shotNumber: shot.shotNumber, startPath: canonicalRel },
  });
  return newItem?.id ?? null;
}

/** Try to promote a sandbox video preview into the canonical clip output.
 *  Returns the new item id on success, or null. Must be called AFTER any
 *  frame promotion so it picks up the freshly-seeded pending video item as
 *  its supersede target. */
function tryPromoteShotVideo(
  runManager: RunManager,
  qm: QueueManager,
  runId: string,
  sceneNumber: number,
  shotInScene: number,
  draft: ShotDraft,
  outputDirAbs: string,
): string | null {
  const previewArt = draft.previewArtifacts?.video;
  if (!previewArt) return null;

  const analysis = qm.getState().storyAnalysis;
  if (!analysis) return null;
  const shot = analysis.scenes
    .find((s) => s.sceneNumber === sceneNumber)
    ?.shots.find((s) => s.shotInScene === shotInScene);
  if (!shot) return null;

  const expected = shotVideoInputsHash({ artStyle: analysis.artStyle, shot });
  if (expected !== previewArt.inputsHash) return null;

  const sandboxAbs = isAbsolute(previewArt.sandboxPath)
    ? previewArt.sandboxPath
    : join(outputDirAbs, previewArt.sandboxPath);
  if (!existsSync(sandboxAbs)) return null;

  const itemKey = `video:scene:${sceneNumber}:shot:${shotInScene}`;
  const items = qm.getItemsByKey(itemKey);
  if (items.length === 0) return null;
  const activeVideo = items.find(
    (i) => i.status !== "superseded" && i.status !== "cancelled",
  );
  if (!activeVideo) return null;

  const version = nextItemVersion(qm, itemKey);
  const canonicalAbs = buildVideoOutputPath({
    outputDir: join(outputDirAbs, "videos"),
    sceneNumber,
    shotInScene,
    version,
  });
  const canonicalRel = relative(outputDirAbs, canonicalAbs);

  try {
    mkdirSync(dirname(canonicalAbs), { recursive: true });
    copyFileSync(sandboxAbs, canonicalAbs);
  } catch (err) {
    console.warn(`[applyShotDraft] video promotion copy failed: ${(err as Error).message}`);
    return null;
  }

  qm.setGeneratedOutput(
    `video:scene:${sceneNumber}:shot:${shotInScene}`,
    canonicalRel,
  );

  const newItem = runManager.promoteCompletedItem({
    runId,
    itemKey,
    supersedeId: activeVideo.id,
    inputsOverride: { shot },
    outputs: { shotNumber: shot.shotNumber, path: canonicalRel, duration: shot.durationSeconds },
  });
  return newItem?.id ?? null;
}

/**
 * Apply a Shot draft to the canonical document via existing mutators and trigger
 * the existing redo cascade for affected items.
 *
 * - Field updates use queueManager.updateShotFields (covers all listed fields).
 * - Image replacements are copied into the run's uploads/ directory and registered
 *   on the appropriate generate_frame item input, then the item is redone (matches
 *   the existing /upload route behavior).
 * - For other Shot field changes that affect generation, all active generate_frame
 *   items for this shot are redone so the cascade re-queues downstream video.
 */
export async function applyShotDraft(
  runManager: RunManager,
  runId: string,
  sceneNumber: number,
  shotInScene: number,
  draft: ShotDraft,
): Promise<ApplyShotDraftResult> {
  const qm = runManager.getQueueManager(runId);
  if (!qm) throw new Error(`Run not found: ${runId}`);

  const regenerated: string[] = [];
  const promoted: Array<"frame" | "video"> = [];
  const imageReplacementsApplied: Array<{ which: "start" | "end"; path: string }> = [];

  // 1. Apply Shot field updates via canonical mutator.
  const fieldKeys = Object.keys(draft.shotFields);
  if (fieldKeys.length > 0) {
    qm.updateShotFields(sceneNumber, shotInScene, draft.shotFields as Record<string, unknown>);
  }

  // 2. Apply image replacements: copy into uploads/, then redo the corresponding
  //    generate_frame item with the new path as input (matches /upload route).
  const state = qm.getState();
  const outputDirAbs = resolveOutputDirAbs(state.outputDir);
  const uploadsDir = join(outputDirAbs, "uploads");

  if (draft.pendingImageReplacements.length > 0) {
    mkdirSync(uploadsDir, { recursive: true });
  }

  for (const replacement of draft.pendingImageReplacements) {
    // Source path may be absolute or run-relative.
    const srcAbs = isAbsolute(replacement.path)
      ? replacement.path
      : join(outputDirAbs, replacement.path);
    if (!existsSync(srcAbs)) {
      console.warn(`[applyShotDraft] Replacement source missing: ${srcAbs}`);
      continue;
    }
    const ext = srcAbs.match(/\.[a-zA-Z0-9]+$/)?.[0] ?? ".png";
    const destRel = `uploads/${randomUUID()}${ext}`;
    const destAbs = join(outputDirAbs, destRel);
    copyFileSync(srcAbs, destAbs);
    imageReplacementsApplied.push({ which: replacement.which, path: destRel });

    // Find the active generate_frame item for this shot and redo with the new path.
    const frameKey = `frame:scene:${sceneNumber}:shot:${shotInScene}`;
    const frameItems = qm.getItemsByKey(frameKey);
    const activeFrame = frameItems.find((i) => i.status !== "superseded" && i.status !== "cancelled");
    if (activeFrame) {
      const inputField = replacement.which === "start" ? "startPath" : "endPath";
      const newItem = runManager.redoItem(runId, activeFrame.id, {
        ...activeFrame.inputs,
        [inputField]: destRel,
      });
      if (newItem) regenerated.push(newItem.id);
    }
  }

  // 3. Smart-apply: if a fresh sandbox preview exists, promote it instead of
  //    regenerating. Promotion is a pure optimization — any failure (missing
  //    file, stale hash, no active item) returns null and we fall through to
  //    the legacy redoItem path. Skipped entirely when image replacements are
  //    pending, since those invalidate previews.
  let promotedFrame: string | null = null;
  let promotedVideo: string | null = null;
  if (draft.pendingImageReplacements.length === 0 && draft.previewArtifacts) {
    promotedFrame = tryPromoteShotFrame(
      runManager, qm, runId, sceneNumber, shotInScene, draft, outputDirAbs,
    );
    if (promotedFrame) {
      regenerated.push(promotedFrame);
      promoted.push("frame");
    }
    // Video promotion runs after frame promotion so it supersedes the
    // pending video item that was just seeded by the frame promotion (or
    // the original active video, if no frame preview was promoted).
    promotedVideo = tryPromoteShotVideo(
      runManager, qm, runId, sceneNumber, shotInScene, draft, outputDirAbs,
    );
    if (promotedVideo) {
      regenerated.push(promotedVideo);
      promoted.push("video");
    }
  }

  // 4. If we made field updates that affect generation AND we did not already
  //    promote a frame preview, redo the active frame item so the cascade
  //    re-queues downstream items.
  if (
    fieldKeys.length > 0 &&
    draft.pendingImageReplacements.length === 0 &&
    !promotedFrame
  ) {
    const generationAffectingFields = new Set<keyof Shot>([
      "durationSeconds", "composition", "startFramePrompt", "endFramePrompt",
      "videoPrompt", "actionPrompt", "dialogue", "speaker", "soundEffects",
      "cameraDirection", "charactersPresent", "objectsPresent", "location",
      "continuousFromPrevious", "skipped",
    ]);
    const triggersRegen = fieldKeys.some((k) => generationAffectingFields.has(k as keyof Shot));
    if (triggersRegen) {
      const frameKey = `frame:scene:${sceneNumber}:shot:${shotInScene}`;
      const frameItems = qm.getItemsByKey(frameKey);
      const activeFrame = frameItems.find((i) => i.status !== "superseded" && i.status !== "cancelled");
      if (activeFrame) {
        // Refresh inputs with the updated shot from storyAnalysis.
        const updatedAnalysis = qm.getState().storyAnalysis;
        const updatedShot = updatedAnalysis?.scenes.find((s) => s.sceneNumber === sceneNumber)
          ?.shots.find((s) => s.shotInScene === shotInScene);
        const newInputs = updatedShot
          ? { ...activeFrame.inputs, shot: updatedShot }
          : { ...activeFrame.inputs };
        const newItem = runManager.redoItem(runId, activeFrame.id, newInputs);
        if (newItem) regenerated.push(newItem.id);
      } else {
        // Pending shot — no frame item yet. Look for a pending generate_video item
        // and update its shot input so the regeneration uses the new fields.
        const videoKey = `video:scene:${sceneNumber}:shot:${shotInScene}`;
        const videoItems = qm.getItemsByKey(videoKey);
        const activeVideo = videoItems.find((i) => i.status === "pending");
        if (activeVideo) {
          const updatedAnalysis = qm.getState().storyAnalysis;
          const updatedShot = updatedAnalysis?.scenes.find((s) => s.sceneNumber === sceneNumber)
            ?.shots.find((s) => s.shotInScene === shotInScene);
          if (updatedShot) {
            activeVideo.inputs = { ...activeVideo.inputs, shot: updatedShot };
          }
        }
      }
    }
  }

  qm.save();
  await runManager.resumeRun(runId);

  return { ok: true, regeneratedItemIds: regenerated, imageReplacementsApplied, promoted };
}
