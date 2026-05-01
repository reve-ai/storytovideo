import { copyFileSync, existsSync, mkdirSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { randomUUID } from "crypto";

import type { RunManager } from "../../queue/run-manager.js";
import type { QueueManager } from "../../queue/queue-manager.js";
import type { ObjectDraft } from "../types.js";
import { objectReferenceInputsHash } from "../preview-hash.js";

interface ApplyObjectDraftResult {
  ok: boolean;
  regeneratedItemIds: string[];
  imageReplacementsApplied: Array<{ which: "start" | "end"; path: string }>;
  /** Smart-apply: kinds of preview artifacts promoted instead of regenerated. */
  promoted: Array<"referenceImage">;
}

function resolveOutputDirAbs(outputDir: string): string {
  return isAbsolute(outputDir) ? outputDir : resolve(process.cwd(), outputDir);
}

/** Try to promote a sandbox reference-image preview into the canonical
 *  `object:NAME:front` output. Returns the new item id on success or null
 *  to fall back to the legacy redo path. Pure optimization — never throws. */
function tryPromoteObjectReference(
  runManager: RunManager,
  qm: QueueManager,
  runId: string,
  objectName: string,
  draft: ObjectDraft,
  outputDirAbs: string,
): string | null {
  const previewArt = draft.previewArtifacts?.referenceImage;
  if (!previewArt) return null;

  const analysis = qm.getState().storyAnalysis;
  if (!analysis) return null;
  const object = (analysis.objects ?? []).find((o) => o.name === objectName);
  if (!object) return null;

  const expected = objectReferenceInputsHash({ artStyle: analysis.artStyle, object });
  if (expected !== previewArt.inputsHash) return null;

  const sandboxAbs = isAbsolute(previewArt.sandboxPath)
    ? previewArt.sandboxPath
    : join(outputDirAbs, previewArt.sandboxPath);
  if (!existsSync(sandboxAbs)) return null;

  const itemKey = `asset:object:${objectName}`;
  const items = qm.getItemsByKey(itemKey);
  if (items.length === 0) return null;
  const activeAsset = items.find(
    (i) => i.status !== "superseded" && i.status !== "cancelled",
  );
  if (!activeAsset) return null;

  // Mirror the existing image-replacement convention: copy the file into
  // uploads/ with a unique name, then register the canonical pointer.
  const uploadsDir = join(outputDirAbs, "uploads");
  const ext = sandboxAbs.match(/\.[a-zA-Z0-9]+$/)?.[0] ?? ".png";
  const destRel = `uploads/${randomUUID()}${ext}`;
  const destAbs = join(outputDirAbs, destRel);
  try {
    mkdirSync(uploadsDir, { recursive: true });
    copyFileSync(sandboxAbs, destAbs);
  } catch (err) {
    console.warn(`[applyObjectDraft] reference promotion copy failed: ${(err as Error).message}`);
    return null;
  }

  qm.setGeneratedOutput(`object:${objectName}:front`, destRel);
  qm.rebuildAssetLibrary();

  const newItem = runManager.promoteCompletedItem({
    runId,
    itemKey,
    supersedeId: activeAsset.id,
    inputsOverride: { description: object.visualDescription },
    outputs: { key: `object:${objectName}:front`, path: destRel },
  });
  return newItem?.id ?? null;
}

/**
 * Apply an Object draft to the canonical document via existing mutators and
 * trigger the existing redo cascade for affected items.
 *
 * - Field updates use queueManager.updateObject.
 * - Image replacement is copied into the run's uploads/ directory, registered
 *   as the canonical reference image via setGeneratedOutput, then any active
 *   generate_frame items whose shot.objectsPresent includes this object are
 *   redone (mirrors the /api/runs/:id/assets/replace endpoint behavior).
 * - For pure visualDescription edits with no image replacement, the active
 *   generate_asset item for this object is redone so the image regenerates
 *   with the new description and the cascade re-queues downstream frames.
 */
export async function applyObjectDraft(
  runManager: RunManager,
  runId: string,
  scopeKey: string,
  draft: ObjectDraft,
): Promise<ApplyObjectDraftResult> {
  const qm = runManager.getQueueManager(runId);
  if (!qm) throw new Error(`Run not found: ${runId}`);

  const objectName = decodeURIComponent(scopeKey);
  const analysis = qm.getState().storyAnalysis;
  if (!analysis) throw new Error("No storyAnalysis available");
  const live = (analysis.objects ?? []).find((o) => o.name === objectName);
  if (!live) throw new Error(`Object not found: ${objectName}`);

  const regenerated: string[] = [];
  const promoted: Array<"referenceImage"> = [];
  const imageReplacementsApplied: Array<{ which: "start" | "end"; path: string }> = [];

  // 1. Apply Object field updates via canonical mutator.
  const fieldKeys = Object.keys(draft.objectFields);
  if (fieldKeys.length > 0) {
    qm.updateObject(objectName, draft.objectFields);
  }

  // 2. Apply pending reference image replacement: copy into uploads/, register
  //    as the canonical reference image, then redo every active frame item
  //    that uses this object.
  const state = qm.getState();
  const outputDirAbs = resolveOutputDirAbs(state.outputDir);
  const uploadsDir = join(outputDirAbs, "uploads");

  if (draft.pendingReferenceImage) {
    mkdirSync(uploadsDir, { recursive: true });
    const srcAbs = isAbsolute(draft.pendingReferenceImage.path)
      ? draft.pendingReferenceImage.path
      : join(outputDirAbs, draft.pendingReferenceImage.path);
    if (!existsSync(srcAbs)) {
      console.warn(`[applyObjectDraft] Replacement source missing: ${srcAbs}`);
    } else {
      const ext = srcAbs.match(/\.[a-zA-Z0-9]+$/)?.[0] ?? ".png";
      const destRel = `uploads/${randomUUID()}${ext}`;
      const destAbs = join(outputDirAbs, destRel);
      copyFileSync(srcAbs, destAbs);
      qm.setGeneratedOutput(`object:${objectName}:front`, destRel);
      qm.rebuildAssetLibrary();
      imageReplacementsApplied.push({ which: "start", path: destRel });

      // Redo every active generate_frame item whose shot.objectsPresent
      // includes this object (mirrors /api/runs/:id/assets/replace cascade).
      const items = qm.getState().workItems;
      for (const item of items) {
        if (item.type !== "generate_frame") continue;
        if (item.status === "superseded" || item.status === "cancelled") continue;
        const shot = item.inputs?.shot as { objectsPresent?: string[] } | undefined;
        if (!Array.isArray(shot?.objectsPresent) || !shot.objectsPresent.includes(objectName)) continue;
        try {
          const newItem = runManager.redoItem(runId, item.id);
          if (newItem) regenerated.push(newItem.id);
        } catch {
          // Item may already be superseded by a previous redo in this batch.
        }
      }
    }
  }

  // 3. Smart-apply: if a fresh sandbox reference-image preview exists, promote
  //    it instead of regenerating. Skipped when an upload is pending (the
  //    upload path is the user's explicit choice).
  let promotedRef: string | null = null;
  if (!draft.pendingReferenceImage && draft.previewArtifacts?.referenceImage) {
    promotedRef = tryPromoteObjectReference(
      runManager, qm, runId, objectName, draft, outputDirAbs,
    );
    if (promotedRef) {
      regenerated.push(promotedRef);
      promoted.push("referenceImage");
    }
  }

  // 4. If we made field updates that affect generation but no image was
  //    staged AND we did not promote a preview, redo the active generate_asset
  //    for this object so a new reference image is produced from the new
  //    description, then the existing cascade re-queues downstream frames.
  if (fieldKeys.length > 0 && !draft.pendingReferenceImage && !promotedRef) {
    const generationAffectingFields = new Set<string>(["visualDescription"]);
    const triggersRegen = fieldKeys.some((k) => generationAffectingFields.has(k));
    if (triggersRegen) {
      const assetKey = `asset:object:${objectName}`;
      const assetItems = qm.getItemsByKey(assetKey);
      const activeAsset = assetItems.find(
        (i) => i.status !== "superseded" && i.status !== "cancelled",
      );
      if (activeAsset) {
        const updatedAnalysis = qm.getState().storyAnalysis;
        const updatedObj = (updatedAnalysis?.objects ?? []).find((o) => o.name === objectName);
        const newInputs = updatedObj
          ? { ...activeAsset.inputs, description: updatedObj.visualDescription }
          : { ...activeAsset.inputs };
        const newItem = runManager.redoItem(runId, activeAsset.id, newInputs);
        if (newItem) regenerated.push(newItem.id);
      }
    }
  }

  qm.save();
  await runManager.resumeRun(runId);

  return { ok: true, regeneratedItemIds: regenerated, imageReplacementsApplied, promoted };
}
