import type { RunManager } from "../../queue/run-manager.js";
import type { StoryDraft } from "../types.js";

interface ApplyStoryDraftResult {
  ok: boolean;
  regeneratedItemIds: string[];
  imageReplacementsApplied: Array<{ which: "start" | "end"; path: string }>;
}

/**
 * Apply a Story draft to the canonical document via queueManager.updateAnalysisMeta.
 *
 * Spec-locked decision: NO automatic project-wide re-frame, even if artStyle
 * changes. If the user wants to redo all frames they re-run them manually via
 * the existing redo machinery. As a result, no items are queued for
 * regeneration here.
 */
export async function applyStoryDraft(
  runManager: RunManager,
  runId: string,
  draft: StoryDraft,
): Promise<ApplyStoryDraftResult> {
  const qm = runManager.getQueueManager(runId);
  if (!qm) throw new Error(`Run not found: ${runId}`);

  const fieldKeys = Object.keys(draft.storyFields);
  if (fieldKeys.length > 0) {
    qm.updateAnalysisMeta(draft.storyFields);
    qm.save();
  }

  return { ok: true, regeneratedItemIds: [], imageReplacementsApplied: [] };
}
