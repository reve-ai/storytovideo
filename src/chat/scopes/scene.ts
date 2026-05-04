import { applySceneDraft } from "../apply/scene.js";
import { createSceneEditorAgent } from "../agents/scene-editor.js";
import { registerScope } from "../scope-registry.js";
import { isSceneDraft } from "../types.js";
import type { QueueManager } from "../../queue/queue-manager.js";
import type { Scene } from "../../types.js";

function sceneStats(qm: QueueManager, scene: Scene) {
  const outputs = qm.getState().generatedOutputs;
  let framesGenerated = 0;
  let videosGenerated = 0;
  for (const shot of scene.shots ?? []) {
    const frameKey = `frame:scene:${scene.sceneNumber}:shot:${shot.shotInScene}`;
    if (outputs[`${frameKey}:start`] || outputs[frameKey]) framesGenerated++;
    if (outputs[`video:scene:${scene.sceneNumber}:shot:${shot.shotInScene}`]) videosGenerated++;
  }
  return { shotCount: scene.shots?.length ?? 0, framesGenerated, videosGenerated };
}

registerScope("scene", {
  agentFactory: (ctx) =>
    createSceneEditorAgent({
      runId: ctx.runId,
      scopeKey: ctx.scopeKey,
      store: ctx.store,
      runManager: ctx.runManager,
      queueManager: ctx.queueManager,
    }),
  applyDraft: async (ctx, draft) => {
    if (!isSceneDraft(draft)) throw new Error("scene scope received non-scene draft");
    return applySceneDraft(ctx.runManager, ctx.runId, ctx.scopeKey, draft);
  },
  getScopeContext: (ctx) => {
    const qm = ctx.runManager.getQueueManager(ctx.runId);
    const analysis = qm?.getState().storyAnalysis;
    if (!qm || !analysis) return { liveScene: null, stats: null };
    const liveScene = analysis.scenes.find((s) => String(s.sceneNumber) === ctx.scopeKey) ?? null;
    if (!liveScene) return { liveScene: null, stats: null };
    return { liveScene, stats: sceneStats(qm, liveScene) };
  },
});