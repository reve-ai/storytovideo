import type { Location } from "../../types.js";
import { applyLocationDraft } from "../apply/location.js";
import { createLocationEditorAgent } from "../agents/location-editor.js";
import { registerScope } from "../scope-registry.js";
import { isLocationDraft } from "../types.js";

registerScope("location", {
  agentFactory: (ctx) =>
    createLocationEditorAgent({
      runId: ctx.runId,
      scopeKey: ctx.scopeKey,
      locationName: decodeURIComponent(ctx.scopeKey),
      store: ctx.store,
      runManager: ctx.runManager,
      queueManager: ctx.queueManager,
    }),
  applyDraft: async (ctx, draft) => {
    if (!isLocationDraft(draft)) throw new Error("location scope received non-location draft");
    return applyLocationDraft(ctx.runManager, ctx.runId, ctx.scopeKey, draft);
  },
  getScopeContext: (ctx) => {
    const qm = ctx.runManager.getQueueManager(ctx.runId);
    if (!qm) return { liveLocation: null, storyContext: null, downstream: [] };
    const analysis = qm.getState().storyAnalysis;
    const locationName = decodeURIComponent(ctx.scopeKey);
    const liveLocation: Location | null =
      analysis?.locations?.find((l) => l.name === locationName) ?? null;
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
      if (item.type === "generate_asset" && item.itemKey === `asset:location:${locationName}`) {
        downstream.push({ id: item.id, itemKey: item.itemKey, type: item.type, status: item.status });
        continue;
      }
      if (item.type === "generate_frame") {
        const shot = item.inputs?.shot as { location?: string } | undefined;
        if (shot?.location === locationName) {
          downstream.push({ id: item.id, itemKey: item.itemKey, type: item.type, status: item.status });
        }
      }
    }
    return { liveLocation, storyContext, downstream };
  },
});
