import { applyStoryDraft } from "../apply/story.js";
import { createStoryEditorAgent } from "../agents/story-editor.js";
import { registerScope } from "../scope-registry.js";
import { isStoryDraft } from "../types.js";

registerScope("story", {
  agentFactory: (ctx) =>
    createStoryEditorAgent({
      runId: ctx.runId,
      scopeKey: ctx.scopeKey,
      store: ctx.store,
      runManager: ctx.runManager,
      queueManager: ctx.queueManager,
    }),
  applyDraft: async (ctx, draft) => {
    if (!isStoryDraft(draft)) throw new Error("story scope received non-story draft");
    return applyStoryDraft(ctx.runManager, ctx.runId, draft);
  },
  getScopeContext: (ctx) => {
    const qm = ctx.runManager.getQueueManager(ctx.runId);
    const analysis = qm?.getState().storyAnalysis;
    if (!analysis) return { liveStory: null, stats: null };
    const sceneCount = analysis.scenes?.length ?? 0;
    const shotCount = (analysis.scenes ?? []).reduce(
      (n, s) => n + (s.shots?.length ?? 0),
      0,
    );
    return {
      liveStory: { title: analysis.title, artStyle: analysis.artStyle },
      stats: {
        sceneCount,
        shotCount,
        characterCount: analysis.characters?.length ?? 0,
        locationCount: analysis.locations?.length ?? 0,
        objectCount: (analysis.objects ?? []).length,
      },
    };
  },
});
