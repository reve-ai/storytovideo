import { copyFileSync, existsSync, mkdirSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { randomUUID } from "crypto";

import type { RunManager } from "../../queue/run-manager.js";
import type { QueueManager } from "../../queue/queue-manager.js";
import type { CharacterDraft } from "../types.js";
import { characterReferenceInputsHash } from "../preview-hash.js";

interface ApplyCharacterDraftResult {
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
 *  `character:NAME:front` output. Returns the new item id on success or
 *  null to fall back to the legacy redo path. Pure optimization — never
 *  throws. */
function tryPromoteCharacterReference(
  runManager: RunManager,
  qm: QueueManager,
  runId: string,
  characterName: string,
  draft: CharacterDraft,
  outputDirAbs: string,
): string | null {
  const previewArt = draft.previewArtifacts?.referenceImage;
  if (!previewArt) return null;

  const analysis = qm.getState().storyAnalysis;
  if (!analysis) return null;
  const character = analysis.characters.find((c) => c.name === characterName);
  if (!character) return null;

  const expected = characterReferenceInputsHash({ artStyle: analysis.artStyle, character });
  if (expected !== previewArt.inputsHash) return null;

  const sandboxAbs = isAbsolute(previewArt.sandboxPath)
    ? previewArt.sandboxPath
    : join(outputDirAbs, previewArt.sandboxPath);
  if (!existsSync(sandboxAbs)) return null;

  const itemKey = `asset:character:${characterName}:front`;
  const items = qm.getItemsByKey(itemKey);
  if (items.length === 0) return null;
  const activeAsset = items.find(
    (i) => i.status !== "superseded" && i.status !== "cancelled",
  );
  if (!activeAsset) return null;

  const uploadsDir = join(outputDirAbs, "uploads");
  const ext = sandboxAbs.match(/\.[a-zA-Z0-9]+$/)?.[0] ?? ".png";
  const destRel = `uploads/${randomUUID()}${ext}`;
  const destAbs = join(outputDirAbs, destRel);
  try {
    mkdirSync(uploadsDir, { recursive: true });
    copyFileSync(sandboxAbs, destAbs);
  } catch (err) {
    console.warn(`[applyCharacterDraft] reference promotion copy failed: ${(err as Error).message}`);
    return null;
  }

  qm.setGeneratedOutput(`character:${characterName}:front`, destRel);
  qm.rebuildAssetLibrary();

  const newItem = runManager.promoteCompletedItem({
    runId,
    itemKey,
    supersedeId: activeAsset.id,
    inputsOverride: { description: character.physicalDescription },
    outputs: { key: `character:${characterName}:front`, path: destRel },
  });
  return newItem?.id ?? null;
}

/**
 * Apply a Character draft to the canonical document via existing mutators
 * and trigger the existing redo cascade for affected items.
 *
 * - Field updates use queueManager.updateCharacter.
 * - Image replacement is copied into the run's uploads/ directory, registered
 *   as the canonical reference image via setGeneratedOutput, then any active
 *   generate_frame items whose shot.charactersPresent includes this character
 *   are redone (mirrors the /api/runs/:id/assets/replace endpoint behavior).
 * - For pure physicalDescription edits with no image replacement, the active
 *   generate_asset for this character is redone so the image regenerates with
 *   the new description and the cascade re-queues downstream frames.
 * - personality / ageRange changes update the canonical record only; no asset
 *   or frame regeneration.
 */
export async function applyCharacterDraft(
  runManager: RunManager,
  runId: string,
  scopeKey: string,
  draft: CharacterDraft,
): Promise<ApplyCharacterDraftResult> {
  const qm = runManager.getQueueManager(runId);
  if (!qm) throw new Error(`Run not found: ${runId}`);

  const characterName = decodeURIComponent(scopeKey);
  const analysis = qm.getState().storyAnalysis;
  if (!analysis) throw new Error("No storyAnalysis available");
  const live = analysis.characters.find((c) => c.name === characterName);
  if (!live) throw new Error(`Character not found: ${characterName}`);

  const regenerated: string[] = [];
  const promoted: Array<"referenceImage"> = [];
  const imageReplacementsApplied: Array<{ which: "start" | "end"; path: string }> = [];

  // 1. Apply Character field updates via canonical mutator.
  const fieldKeys = Object.keys(draft.characterFields);
  if (fieldKeys.length > 0) {
    qm.updateCharacter(characterName, draft.characterFields);
  }

  // 2. Apply pending reference image replacement.
  const state = qm.getState();
  const outputDirAbs = resolveOutputDirAbs(state.outputDir);
  const uploadsDir = join(outputDirAbs, "uploads");

  if (draft.pendingReferenceImage) {
    mkdirSync(uploadsDir, { recursive: true });
    const srcAbs = isAbsolute(draft.pendingReferenceImage.path)
      ? draft.pendingReferenceImage.path
      : join(outputDirAbs, draft.pendingReferenceImage.path);
    if (!existsSync(srcAbs)) {
      console.warn(`[applyCharacterDraft] Replacement source missing: ${srcAbs}`);
    } else {
      const ext = srcAbs.match(/\.[a-zA-Z0-9]+$/)?.[0] ?? ".png";
      const destRel = `uploads/${randomUUID()}${ext}`;
      const destAbs = join(outputDirAbs, destRel);
      copyFileSync(srcAbs, destAbs);
      qm.setGeneratedOutput(`character:${characterName}:front`, destRel);
      qm.rebuildAssetLibrary();
      imageReplacementsApplied.push({ which: "start", path: destRel });

      const items = qm.getState().workItems;
      for (const item of items) {
        if (item.type !== "generate_frame") continue;
        if (item.status === "superseded" || item.status === "cancelled") continue;
        const shot = item.inputs?.shot as { charactersPresent?: string[] } | undefined;
        if (!Array.isArray(shot?.charactersPresent) || !shot.charactersPresent.includes(characterName)) continue;
        try {
          const newItem = runManager.redoItem(runId, item.id);
          if (newItem) regenerated.push(newItem.id);
        } catch {
          // Item may already be superseded by a previous redo in this batch.
        }
      }
    }
  }

  // 3. Smart-apply: promote a fresh sandbox preview if available.
  let promotedRef: string | null = null;
  if (!draft.pendingReferenceImage && draft.previewArtifacts?.referenceImage) {
    promotedRef = tryPromoteCharacterReference(
      runManager, qm, runId, characterName, draft, outputDirAbs,
    );
    if (promotedRef) {
      regenerated.push(promotedRef);
      promoted.push("referenceImage");
    }
  }

  // 4. If we made generation-affecting field updates with no image staged
  //    and no preview promoted, redo the active generate_asset for this
  //    character. Only physicalDescription drives generation — personality
  //    and ageRange are metadata-only and trigger no cascade.
  if (fieldKeys.length > 0 && !draft.pendingReferenceImage && !promotedRef) {
    const generationAffectingFields = new Set<string>(["physicalDescription"]);
    const triggersRegen = fieldKeys.some((k) => generationAffectingFields.has(k));
    if (triggersRegen) {
      const assetKey = `asset:character:${characterName}:front`;
      const assetItems = qm.getItemsByKey(assetKey);
      const activeAsset = assetItems.find(
        (i) => i.status !== "superseded" && i.status !== "cancelled",
      );
      if (activeAsset) {
        const updatedAnalysis = qm.getState().storyAnalysis;
        const updatedChar = updatedAnalysis?.characters.find((c) => c.name === characterName);
        const newInputs = updatedChar
          ? { ...activeAsset.inputs, description: updatedChar.physicalDescription }
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
