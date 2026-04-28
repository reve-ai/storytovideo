import type { Shot } from "../../types.js";
import { applyShotDraft } from "../apply.js";
import { createShotEditorAgent } from "../agents/shot-editor.js";
import { registerScope } from "../scope-registry.js";

function getLiveShot(
  ctx: Parameters<NonNullable<Parameters<typeof registerScope>[1]["getScopeContext"]>>[0],
): Shot | null {
  const qm = ctx.runManager.getQueueManager(ctx.runId);
  if (!qm) return null;
  const analysis = qm.getState().storyAnalysis;
  if (!analysis) return null;
  const scene = analysis.scenes?.find((s) => s.sceneNumber === ctx.sceneNumber);
  if (!scene) return null;
  return scene.shots?.find((s) => s.shotInScene === ctx.shotInScene) ?? null;
}

registerScope("shot", {
  agentFactory: (ctx) =>
    createShotEditorAgent({
      runId: ctx.runId,
      sceneNumber: ctx.sceneNumber,
      shotInScene: ctx.shotInScene,
      scopeKey: ctx.scopeKey,
      store: ctx.store,
      runManager: ctx.runManager,
      queueManager: ctx.queueManager,
    }),
  applyDraft: async (ctx, draft) =>
    applyShotDraft(ctx.runManager, ctx.runId, ctx.sceneNumber, ctx.shotInScene, draft),
  getScopeContext: (ctx) => {
    const liveShot = getLiveShot(ctx);
    const qm = ctx.runManager.getQueueManager(ctx.runId);
    const analysis = qm?.getState().storyAnalysis;
    const storyContext = analysis
      ? {
          title: analysis.title,
          artStyle: analysis.artStyle,
          characters: analysis.characters.map((c) => c.name),
          locations: analysis.locations.map((l) => l.name),
          objects: (analysis.objects ?? []).map((o) => o.name),
        }
      : null;
    return { liveShot, storyContext };
  },
});
