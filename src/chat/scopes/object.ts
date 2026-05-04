import type { StoryObject } from "../../types.js";
import { applyObjectDraft } from "../apply/object.js";
import { createObjectEditorAgent } from "../agents/object-editor.js";
import { registerScope } from "../scope-registry.js";
import { isObjectDraft } from "../types.js";

registerScope("object", {
  agentFactory: (ctx) =>
    createObjectEditorAgent({
      runId: ctx.runId,
      scopeKey: ctx.scopeKey,
      objectName: decodeURIComponent(ctx.scopeKey),
      store: ctx.store,
      runManager: ctx.runManager,
      queueManager: ctx.queueManager,
    }),
  applyDraft: async (ctx, draft) => {
    if (!isObjectDraft(draft)) throw new Error("object scope received non-object draft");
    return applyObjectDraft(ctx.runManager, ctx.runId, ctx.scopeKey, draft);
  },
  getScopeContext: (ctx) => {
    const qm = ctx.runManager.getQueueManager(ctx.runId);
    if (!qm) return { liveObject: null, storyContext: null, downstream: [] };
    const analysis = qm.getState().storyAnalysis;
    const objectName = decodeURIComponent(ctx.scopeKey);
    const liveObject: StoryObject | null =
      (analysis?.objects ?? []).find((o) => o.name === objectName) ?? null;
    const storyContext = analysis
      ? {
          title: analysis.title,
          artStyle: analysis.artStyle,
          characters: analysis.characters.map((c) => c.name),
          locations: analysis.locations.map((l) => l.name),
          objects: (analysis.objects ?? []).map((o) => o.name),
        }
      : null;

    const downstream: Array<{ id: string; itemKey: string; type: string; status: string }> = [];
    const items = qm.getState().workItems;
    for (const item of items) {
      if (item.status === "superseded" || item.status === "cancelled") continue;
      if (item.type === "generate_asset" && item.itemKey === `asset:object:${objectName}`) {
        downstream.push({ id: item.id, itemKey: item.itemKey, type: item.type, status: item.status });
        continue;
      }
      if (item.type === "generate_frame") {
        const shot = item.inputs?.shot as { objectsPresent?: string[] } | undefined;
        if (Array.isArray(shot?.objectsPresent) && shot.objectsPresent.includes(objectName)) {
          downstream.push({ id: item.id, itemKey: item.itemKey, type: item.type, status: item.status });
        }
      }
    }
    return { liveObject, storyContext, downstream };
  },
});
