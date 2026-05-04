import type { RunManager } from "../../queue/run-manager.js";
import type { SceneDraft } from "../types.js";

interface ApplySceneDraftResult {
  ok: boolean;
  regeneratedItemIds: string[];
  imageReplacementsApplied: Array<{ which: "start" | "end"; path: string }>;
}

/**
 * Apply a Scene draft to the canonical storyAnalysis scene record.
 *
 * Spec-locked decision: NO automatic cascade. Re-planning shots, frames, and
 * videos requires the existing Redo Scene button after the metadata is applied.
 */
export async function applySceneDraft(
  runManager: RunManager,
  runId: string,
  scopeKey: string,
  draft: SceneDraft,
): Promise<ApplySceneDraftResult> {
  const qm = runManager.getQueueManager(runId);
  if (!qm) throw new Error(`Run not found: ${runId}`);

  const fieldKeys = Object.keys(draft.sceneFields);
  if (fieldKeys.length > 0) {
    qm.updateScene(Number(scopeKey), draft.sceneFields);
    qm.save();
  }

  return { ok: true, regeneratedItemIds: [], imageReplacementsApplied: [] };
}