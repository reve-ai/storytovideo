import { copyFileSync, existsSync, mkdirSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { randomUUID } from "crypto";

import type { RunManager } from "../../queue/run-manager.js";
import type { QueueManager } from "../../queue/queue-manager.js";
import type { LocationDraft } from "../types.js";
import { locationReferenceInputsHash } from "../preview-hash.js";

interface ApplyLocationDraftResult {
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
 *  `location:NAME:front` output. Returns the new item id on success or null
 *  to fall back to the legacy redo path. Pure optimization — never throws. */
function tryPromoteLocationReference(
  runManager: RunManager,
  qm: QueueManager,
  runId: string,
  locationName: string,
  draft: LocationDraft,
  outputDirAbs: string,
): string | null {
  const previewArt = draft.previewArtifacts?.referenceImage;
  if (!previewArt) return null;

  const analysis = qm.getState().storyAnalysis;
  if (!analysis) return null;
  const location = analysis.locations?.find((l) => l.name === locationName);
  if (!location) return null;

  const expected = locationReferenceInputsHash({ artStyle: analysis.artStyle, location });
  if (expected !== previewArt.inputsHash) return null;

  const sandboxAbs = isAbsolute(previewArt.sandboxPath)
    ? previewArt.sandboxPath
    : join(outputDirAbs, previewArt.sandboxPath);
  if (!existsSync(sandboxAbs)) return null;

  const itemKey = `asset:location:${locationName}`;
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
    console.warn(`[applyLocationDraft] reference promotion copy failed: ${(err as Error).message}`);
    return null;
  }

  qm.setGeneratedOutput(`location:${locationName}:front`, destRel);
  qm.rebuildAssetLibrary();

  const newItem = runManager.promoteCompletedItem({
    runId,
    itemKey,
    supersedeId: activeAsset.id,
    inputsOverride: { description: location.visualDescription },
    outputs: { key: `location:${locationName}:front`, path: destRel },
  });
  return newItem?.id ?? null;
}

/**
 * Apply a Location draft to the canonical document via existing mutators and
 * trigger the existing redo cascade for affected items.
 *
 * - Field updates use queueManager.updateLocation.
 * - Image replacement is copied into the run's uploads/ directory, registered
 *   as the canonical reference image via setGeneratedOutput, then any active
 *   generate_frame items that reference this location are redone (mirrors the
 *   /api/runs/:id/assets/replace endpoint behavior).
 * - For pure visualDescription edits with no image replacement, the active
 *   generate_asset item for this location is redone so the image regenerates
 *   with the new description and the cascade re-queues downstream frames.
 */
export async function applyLocationDraft(
  runManager: RunManager,
  runId: string,
  scopeKey: string,
  draft: LocationDraft,
): Promise<ApplyLocationDraftResult> {
  const qm = runManager.getQueueManager(runId);
  if (!qm) throw new Error(`Run not found: ${runId}`);

  const locationName = decodeURIComponent(scopeKey);
  const analysis = qm.getState().storyAnalysis;
  if (!analysis) throw new Error("No storyAnalysis available");
  const live = analysis.locations?.find((l) => l.name === locationName);
  if (!live) throw new Error(`Location not found: ${locationName}`);

  const regenerated: string[] = [];
  const promoted: Array<"referenceImage"> = [];
  const imageReplacementsApplied: Array<{ which: "start" | "end"; path: string }> = [];

  // 1. Apply Location field updates via canonical mutator.
  const fieldKeys = Object.keys(draft.locationFields);
  if (fieldKeys.length > 0) {
    qm.updateLocation(locationName, draft.locationFields);
  }

  // 2. Apply pending reference image replacement: copy into uploads/, register
  //    as the canonical reference image, then redo every active frame item
  //    that uses this location.
  const state = qm.getState();
  const outputDirAbs = resolveOutputDirAbs(state.outputDir);
  const uploadsDir = join(outputDirAbs, "uploads");

  if (draft.pendingReferenceImage) {
    mkdirSync(uploadsDir, { recursive: true });
    const srcAbs = isAbsolute(draft.pendingReferenceImage.path)
      ? draft.pendingReferenceImage.path
      : join(outputDirAbs, draft.pendingReferenceImage.path);
    if (!existsSync(srcAbs)) {
      console.warn(`[applyLocationDraft] Replacement source missing: ${srcAbs}`);
    } else {
      const ext = srcAbs.match(/\.[a-zA-Z0-9]+$/)?.[0] ?? ".png";
      const destRel = `uploads/${randomUUID()}${ext}`;
      const destAbs = join(outputDirAbs, destRel);
      copyFileSync(srcAbs, destAbs);
      qm.setGeneratedOutput(`location:${locationName}:front`, destRel);
      qm.rebuildAssetLibrary();
      imageReplacementsApplied.push({ which: "start", path: destRel });

      // Redo every active generate_frame item that references this location
      // (mirrors /api/runs/:id/assets/replace cascade).
      const items = qm.getState().workItems;
      for (const item of items) {
        if (item.type !== "generate_frame") continue;
        if (item.status === "superseded" || item.status === "cancelled") continue;
        const shot = item.inputs?.shot as { location?: string } | undefined;
        if (shot?.location !== locationName) continue;
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
    promotedRef = tryPromoteLocationReference(
      runManager, qm, runId, locationName, draft, outputDirAbs,
    );
    if (promotedRef) {
      regenerated.push(promotedRef);
      promoted.push("referenceImage");
    }
  }

  // 4. If we made field updates that affect generation but no image was
  //    staged AND we did not promote a preview, redo the active generate_asset
  //    for this location so a new reference image is produced from the new
  //    description, then the existing cascade re-queues downstream frames.
  if (fieldKeys.length > 0 && !draft.pendingReferenceImage && !promotedRef) {
    const generationAffectingFields = new Set<string>(["visualDescription"]);
    const triggersRegen = fieldKeys.some((k) => generationAffectingFields.has(k));
    if (triggersRegen) {
      const assetKey = `asset:location:${locationName}`;
      const assetItems = qm.getItemsByKey(assetKey);
      const activeAsset = assetItems.find(
        (i) => i.status !== "superseded" && i.status !== "cancelled",
      );
      if (activeAsset) {
        const updatedAnalysis = qm.getState().storyAnalysis;
        const updatedLoc = updatedAnalysis?.locations?.find((l) => l.name === locationName);
        const newInputs = updatedLoc
          ? { ...activeAsset.inputs, description: updatedLoc.visualDescription }
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
