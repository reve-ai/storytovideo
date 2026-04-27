import { copyFileSync, existsSync, mkdirSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { randomUUID } from "crypto";

import type { RunManager } from "../queue/run-manager.js";
import type { Shot } from "../types.js";
import type { ShotDraft } from "./types.js";

interface ApplyShotDraftResult {
  ok: boolean;
  regeneratedItemIds: string[];
  imageReplacementsApplied: Array<{ which: "start" | "end"; path: string }>;
}

function resolveOutputDirAbs(outputDir: string): string {
  return isAbsolute(outputDir) ? outputDir : resolve(process.cwd(), outputDir);
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

  // 3. If we made field updates that affect generation, redo the active frame
  //    item(s) for this shot so the cascade re-queues downstream items.
  if (fieldKeys.length > 0 && draft.pendingImageReplacements.length === 0) {
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

  return { ok: true, regeneratedItemIds: regenerated, imageReplacementsApplied };
}
