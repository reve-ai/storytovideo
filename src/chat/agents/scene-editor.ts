import { z } from "zod";
import { ToolLoopAgent, hasToolCall, stepCountIs, type Agent, type ToolSet } from "ai";

import { getLlmModel } from "../../llm-provider.js";
import type { RunManager } from "../../queue/run-manager.js";
import type { QueueManager } from "../../queue/queue-manager.js";
import type { Scene } from "../../types.js";
import { ChatSessionStore } from "../session-store.js";
import {
  emptySceneDraft,
  isSceneDraft,
  type SceneDraft,
  type SceneFields,
} from "../types.js";

export interface SceneEditorContext {
  runId: string;
  scopeKey: string;
  store: ChatSessionStore;
  runManager: RunManager;
  queueManager: QueueManager;
}

function getLiveScene(qm: QueueManager, scopeKey: string): Scene | null {
  const analysis = qm.getState().storyAnalysis;
  if (!analysis) return null;
  return analysis.scenes.find((s) => String(s.sceneNumber) === scopeKey) ?? null;
}

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

function mergedSceneFields(liveScene: Scene, draft: SceneDraft): SceneFields {
  return {
    title: draft.sceneFields.title ?? liveScene.title,
    narrativeSummary: draft.sceneFields.narrativeSummary ?? liveScene.narrativeSummary,
    location: draft.sceneFields.location ?? liveScene.location,
    charactersPresent: draft.sceneFields.charactersPresent ?? liveScene.charactersPresent,
    estimatedDurationSeconds: draft.sceneFields.estimatedDurationSeconds ?? liveScene.estimatedDurationSeconds,
  };
}

function loadDraft(ctx: SceneEditorContext): SceneDraft {
  const session = ctx.store.load("scene", ctx.scopeKey, ctx.runId);
  return isSceneDraft(session.draft) ? session.draft : emptySceneDraft();
}

function saveDraft(ctx: SceneEditorContext, draft: SceneDraft): void {
  ctx.store.setDraft("scene", ctx.scopeKey, ctx.runId, draft);
}

const updateSceneFieldsSchema = z.object({
  title: z.string().optional(),
  narrativeSummary: z.string().optional(),
  location: z.string().optional(),
  charactersPresent: z.array(z.string()).optional(),
  estimatedDurationSeconds: z.number().optional(),
});

export function buildSceneEditorTools(ctx: SceneEditorContext): ToolSet {
  const tools = {
    getScene: ({
      description:
        "Returns the merged scene metadata, live Scene record, draft fields, and aggregate counts for this scene.",
      inputSchema: z.object({}),
      execute: async () => {
        const liveScene = getLiveScene(ctx.queueManager, ctx.scopeKey);
        if (!liveScene) return { error: `Scene ${ctx.scopeKey} not found` };
        const draft = loadDraft(ctx);
        return {
          merged: mergedSceneFields(liveScene, draft),
          liveScene,
          draftFields: draft.sceneFields,
          stats: sceneStats(ctx.queueManager, liveScene),
        };
      },
    }),

    getDownstreamImpact: ({
      description:
        "Reports the scene shot/frame/video counts and reminds that Apply only mutates the Scene record.",
      inputSchema: z.object({}),
      execute: async () => {
        const liveScene = getLiveScene(ctx.queueManager, ctx.scopeKey);
        if (!liveScene) return { error: `Scene ${ctx.scopeKey} not found` };
        const stats = sceneStats(ctx.queueManager, liveScene);
        return {
          ...stats,
          message: `Apply changes only the scene record. Click Redo Scene to re-plan and regenerate the ${stats.shotCount} shots.`,
        };
      },
    }),

    updateSceneFields: ({
      description:
        "Stage a partial update to Scene metadata. Goes into the draft, NOT the live document. Apply does NOT cascade; the user must click Redo Scene to re-plan and regenerate shots.",
      inputSchema: updateSceneFieldsSchema,
      execute: async (fields: z.infer<typeof updateSceneFieldsSchema>) => {
        const liveScene = getLiveScene(ctx.queueManager, ctx.scopeKey);
        if (!liveScene) return { error: `Scene ${ctx.scopeKey} not found` };
        const draft = loadDraft(ctx);
        const next: SceneDraft = {
          sceneFields: { ...draft.sceneFields, ...fields },
        };
        saveDraft(ctx, next);
        return { ok: true, draftFields: next.sceneFields };
      },
    }),

    proposeApply: ({
      description:
        "Terminal tool. Call this when the draft is ready and the UI should show Apply / Discard. Always end the conversation by calling this.",
      inputSchema: z.object({
        summary: z.string().describe("A short summary of what the draft will change."),
      }),
      execute: async ({ summary }: { summary: string }) => {
        const draft = loadDraft(ctx);
        return { ok: true, summary, draft };
      },
    }),
  };
  return tools as unknown as ToolSet;
}

const SYSTEM_INSTRUCTIONS = `You are an editor for one Scene's metadata in an AI video pipeline.

The Scene editable fields are title, narrativeSummary, location, charactersPresent, and estimatedDurationSeconds. You can:
- Read the current scene, draft overlay, and counts via getScene.
- Report downstream counts via getDownstreamImpact.
- Stage metadata updates via updateSceneFields. This goes into a draft, not the live document.

IMPORTANT: Apply does NOT cascade. Apply changes only the canonical Scene record and does not re-plan shots, regenerate frames, regenerate videos, seed redo work, or touch the queue. If the user wants changed scene metadata to propagate downstream, they must click Redo Scene after applying.

Always finish your work by calling proposeApply with a short summary of the staged changes. The user will then click Apply (commits the draft) or Discard.`;

export function createSceneEditorAgent(ctx: SceneEditorContext): Agent<never, ToolSet> {
  const tools = buildSceneEditorTools(ctx);
  return new ToolLoopAgent({
    model: getLlmModel("strong"),
    instructions: SYSTEM_INSTRUCTIONS,
    tools,
    stopWhen: [stepCountIs(20), hasToolCall("proposeApply")],
  });
}