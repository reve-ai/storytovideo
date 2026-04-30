import { z } from "zod";
import { ToolLoopAgent, hasToolCall, stepCountIs, type Agent, type ToolSet } from "ai";

import { getLlmModel } from "../../llm-provider.js";
import type { RunManager } from "../../queue/run-manager.js";
import type { QueueManager } from "../../queue/queue-manager.js";
import { ChatSessionStore } from "../session-store.js";
import {
  emptyStoryDraft,
  isStoryDraft,
  type StoryDraft,
  type StoryFields,
} from "../types.js";

export interface StoryEditorContext {
  runId: string;
  scopeKey: string;
  store: ChatSessionStore;
  runManager: RunManager;
  queueManager: QueueManager;
}

function loadDraft(ctx: StoryEditorContext): StoryDraft {
  const session = ctx.store.load("story", ctx.scopeKey, ctx.runId);
  return isStoryDraft(session.draft) ? session.draft : emptyStoryDraft();
}

function saveDraft(ctx: StoryEditorContext, draft: StoryDraft): void {
  ctx.store.setDraft("story", ctx.scopeKey, ctx.runId, draft);
}

const updateStoryMetaSchema = z.object({
  title: z.string().optional(),
  artStyle: z.string().optional(),
});

export function buildStoryEditorTools(ctx: StoryEditorContext): ToolSet {
  const tools = {
    getStorySummary: ({
      description:
        "Returns the merged story metadata (title, artStyle) plus aggregate stats: scene/shot counts and the names of available characters/locations/objects.",
      inputSchema: z.object({}),
      execute: async () => {
        const analysis = ctx.queueManager.getState().storyAnalysis;
        if (!analysis) return { error: "No storyAnalysis available" };
        const draft = loadDraft(ctx);
        const merged: StoryFields = {
          title: draft.storyFields.title ?? analysis.title,
          artStyle: draft.storyFields.artStyle ?? analysis.artStyle,
        };
        const sceneCount = analysis.scenes?.length ?? 0;
        const shotCount = (analysis.scenes ?? []).reduce(
          (n, s) => n + (s.shots?.length ?? 0),
          0,
        );
        return {
          merged,
          live: { title: analysis.title, artStyle: analysis.artStyle },
          draftFields: draft.storyFields,
          stats: {
            sceneCount,
            shotCount,
            characterCount: analysis.characters?.length ?? 0,
            locationCount: analysis.locations?.length ?? 0,
            objectCount: (analysis.objects ?? []).length,
          },
          characters: analysis.characters.map((c) => c.name),
          locations: analysis.locations.map((l) => l.name),
          objects: (analysis.objects ?? []).map((o) => o.name),
        };
      },
    }),

    updateStoryMeta: ({
      description:
        "Stage a partial update to the top-level story metadata (title, artStyle). Goes into the draft, NOT the live document. Apply does NOT trigger a project-wide re-frame even if artStyle changes — the user must re-run frames manually if they want.",
      inputSchema: updateStoryMetaSchema,
      execute: async (fields: z.infer<typeof updateStoryMetaSchema>) => {
        const analysis = ctx.queueManager.getState().storyAnalysis;
        if (!analysis) return { error: "No storyAnalysis available" };
        const draft = loadDraft(ctx);
        const next: StoryDraft = {
          storyFields: { ...draft.storyFields, ...fields },
        };
        saveDraft(ctx, next);
        return { ok: true, draftFields: next.storyFields };
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

const SYSTEM_INSTRUCTIONS = `You are an editor for the top-level Story metadata in an AI video pipeline.

The Story has only two editable top-level fields: title and artStyle. You can:
- Read the current values and project stats via getStorySummary.
- Stage an update to title and/or artStyle via updateStoryMeta. This goes into a draft, not the live document.

IMPORTANT: Apply does NOT trigger a project-wide re-frame, even when artStyle changes. If the user wants to redo all frames after an artStyle change, they will run that manually. Do not promise automatic regeneration.

Always finish your work by calling proposeApply with a short summary of the staged changes. The user will then click Apply (commits the draft) or Discard.`;

export function createStoryEditorAgent(ctx: StoryEditorContext): Agent<never, ToolSet> {
  const tools = buildStoryEditorTools(ctx);
  return new ToolLoopAgent({
    model: getLlmModel("strong"),
    instructions: SYSTEM_INSTRUCTIONS,
    tools,
    stopWhen: [stepCountIs(20), hasToolCall("proposeApply")],
  });
}
