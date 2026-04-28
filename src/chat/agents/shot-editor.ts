import { mkdirSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { z } from "zod";
import { ToolLoopAgent, hasToolCall, stepCountIs, type Agent, type ToolSet } from "ai";

import { getLlmModel } from "../../llm-provider.js";
import { generateFrame } from "../../tools/generate-frame.js";
import { generateVideo } from "../../tools/generate-video.js";
import type { Shot } from "../../types.js";
import type { RunManager } from "../../queue/run-manager.js";
import type { QueueManager } from "../../queue/queue-manager.js";
import {
  ChatSessionStore,
  chatPreviewDir,
  chatPreviewRelative,
} from "../session-store.js";
import { emptyShotDraft, isShotDraft, type ShotDraft } from "../types.js";

export interface ShotEditorContext {
  runId: string;
  sceneNumber: number;
  shotInScene: number;
  scopeKey: string;
  store: ChatSessionStore;
  runManager: RunManager;
  queueManager: QueueManager;
}

function resolveOutputDirAbs(outputDir: string): string {
  return isAbsolute(outputDir) ? outputDir : resolve(process.cwd(), outputDir);
}

function getShotFromState(qm: QueueManager, sceneNumber: number, shotInScene: number): Shot | null {
  const analysis = qm.getState().storyAnalysis;
  if (!analysis) return null;
  const scene = analysis.scenes?.find((s) => s.sceneNumber === sceneNumber);
  if (!scene) return null;
  return scene.shots?.find((s) => s.shotInScene === shotInScene) ?? null;
}

function mergedShot(qm: QueueManager, sceneNumber: number, shotInScene: number, draft: ShotDraft | null): Shot | null {
  const live = getShotFromState(qm, sceneNumber, shotInScene);
  if (!live) return null;
  if (!draft || Object.keys(draft.shotFields).length === 0) return live;
  return { ...live, ...(draft.shotFields as Partial<Shot>) } as Shot;
}

function loadDraft(ctx: ShotEditorContext): ShotDraft {
  const session = ctx.store.load("shot", ctx.scopeKey, ctx.runId);
  return isShotDraft(session.draft) ? session.draft : emptyShotDraft();
}

function saveDraft(ctx: ShotEditorContext, draft: ShotDraft): void {
  ctx.store.setDraft("shot", ctx.scopeKey, ctx.runId, draft);
}

const updateShotFieldsSchema = z.object({
  durationSeconds: z.number().optional(),
  composition: z.string().optional(),
  startFramePrompt: z.string().optional(),
  endFramePrompt: z.string().optional(),
  videoPrompt: z.string().optional(),
  actionPrompt: z.string().optional(),
  dialogue: z.string().optional(),
  speaker: z.string().optional(),
  soundEffects: z.string().optional(),
  cameraDirection: z.string().optional(),
  charactersPresent: z.array(z.string()).optional(),
  objectsPresent: z.array(z.string()).optional(),
  location: z.string().optional(),
  continuousFromPrevious: z.boolean().optional(),
  skipped: z.boolean().optional(),
});

export function buildShotEditorTools(ctx: ShotEditorContext): ToolSet {
  const tools = {
    getShot: ({
      description: "Get the current Shot fields. Returns the merged value (live document with draft overrides applied).",
      inputSchema: z.object({}),
      execute: async () => {
        const draft = loadDraft(ctx);
        const shot = mergedShot(ctx.queueManager, ctx.sceneNumber, ctx.shotInScene, draft);
        if (!shot) return { error: `Shot ${ctx.sceneNumber}.${ctx.shotInScene} not found` };
        return { shot, draftFields: draft.shotFields, pendingImageReplacements: draft.pendingImageReplacements };
      },
    }),

    getStoryContext: ({
      description: "Returns title, artStyle, and the names of available characters/locations/objects.",
      inputSchema: z.object({}),
      execute: async () => {
        const analysis = ctx.queueManager.getState().storyAnalysis;
        if (!analysis) return { error: "No storyAnalysis available" };
        return {
          title: analysis.title,
          artStyle: analysis.artStyle,
          characters: analysis.characters.map((c) => c.name),
          locations: analysis.locations.map((l) => l.name),
          objects: (analysis.objects ?? []).map((o) => o.name),
        };
      },
    }),

    getDownstreamImpact: ({
      description: "Reports which queue items would be invalidated by the current draft.",
      inputSchema: z.object({}),
      execute: async () => {
        const draft = loadDraft(ctx);
        if (!draft.shotFields || Object.keys(draft.shotFields).length === 0) {
          return { affected: [], note: "Draft is empty — nothing would be regenerated." };
        }
        const items = ctx.queueManager.getState().workItems;
        const affected: Array<{ id: string; itemKey: string; type: string; status: string }> = [];
        for (const item of items) {
          if (item.status === "superseded" || item.status === "cancelled") continue;
          const shot = item.inputs?.shot as Shot | undefined;
          if (!shot) continue;
          if (shot.sceneNumber === ctx.sceneNumber && shot.shotInScene === ctx.shotInScene) {
            affected.push({ id: item.id, itemKey: item.itemKey, type: item.type, status: item.status });
          }
        }
        return { affected };
      },
    }),

    listIntermediates: ({
      description: "List preview frames/videos already generated in this session.",
      inputSchema: z.object({}),
      execute: async () => {
        const session = ctx.store.load("shot", ctx.scopeKey, ctx.runId);
        return { intermediates: session.intermediates };
      },
    }),

    updateShotFields: ({
      description:
        "Stage a partial Shot update to the draft (does NOT mutate the live document). Validates that referenced characters/locations/objects exist in the story.",
      inputSchema: updateShotFieldsSchema,
      execute: async (fields: z.infer<typeof updateShotFieldsSchema>) => {
        const analysis = ctx.queueManager.getState().storyAnalysis;
        if (!analysis) return { error: "No storyAnalysis available" };

        // Validation: characters/locations/objects must already exist
        const knownChars = new Set(analysis.characters.map((c) => c.name));
        const knownLocs = new Set(analysis.locations.map((l) => l.name));
        const knownObjs = new Set((analysis.objects ?? []).map((o) => o.name));

        if (fields.charactersPresent) {
          const unknown = fields.charactersPresent.filter((n: string) => !knownChars.has(n));
          if (unknown.length) return { error: `Unknown characters: ${unknown.join(", ")}` };
        }
        if (fields.objectsPresent) {
          const unknown = fields.objectsPresent.filter((n: string) => !knownObjs.has(n));
          if (unknown.length) return { error: `Unknown objects: ${unknown.join(", ")}` };
        }
        if (fields.location !== undefined && fields.location !== "" && !knownLocs.has(fields.location)) {
          return { error: `Unknown location: ${fields.location}` };
        }

        const draft = loadDraft(ctx);
        const next: ShotDraft = {
          shotFields: { ...draft.shotFields, ...fields } as Partial<Shot>,
          pendingImageReplacements: draft.pendingImageReplacements,
        };
        saveDraft(ctx, next);
        return { ok: true, draftFields: next.shotFields };
      },
    }),

    replaceFrameImage: ({
      description:
        "Register a pending start/end frame image replacement. The user must approve. For 'upload', the client should have already uploaded the image and provide its sandbox path.",
      inputSchema: z.object({
        which: z.enum(["start", "end"]),
        source: z.enum(["upload", "url"]),
        data: z.string().describe("Either the uploaded sandbox path or the URL"),
      }),
      needsApproval: true,
      execute: async (input: { which: "start" | "end"; source: "upload" | "url"; data: string }) => {
        const draft = loadDraft(ctx);
        const filtered = draft.pendingImageReplacements.filter((r) => r.which !== input.which);
        const next: ShotDraft = {
          shotFields: draft.shotFields,
          pendingImageReplacements: [...filtered, { which: input.which, path: input.data }],
        };
        saveDraft(ctx, next);
        return { ok: true, pendingImageReplacements: next.pendingImageReplacements };
      },
    }),

    previewFrame: ({
      description:
        "Generate a frame preview using the current draft Shot. Writes only to the chat sandbox. Approval required.",
      inputSchema: z.object({ note: z.string().optional() }),
      needsApproval: true,
      execute: async ({ note }: { note?: string }) => {
        const draft = loadDraft(ctx);
        const shot = mergedShot(ctx.queueManager, ctx.sceneNumber, ctx.shotInScene, draft);
        if (!shot) return { error: "Shot not found" };
        const state = ctx.queueManager.getState();
        const analysis = state.storyAnalysis;
        if (!analysis) return { error: "No storyAnalysis available" };
        const assetLibrary = ctx.queueManager.resolveAssetLibrary();
        if (!assetLibrary) return { error: "Asset library not built yet" };

        const runOutputAbs = resolveOutputDirAbs(state.outputDir);
        const sandboxAbs = chatPreviewDir(runOutputAbs, "shot", ctx.scopeKey);
        mkdirSync(sandboxAbs, { recursive: true });

        const version = Date.now();
        const result = await generateFrame({
          shot,
          artStyle: analysis.artStyle,
          assetLibrary,
          outputDir: sandboxAbs,
          imageBackend: state.options?.imageBackend ?? "grok",
          aspectRatio: state.options?.aspectRatio,
          version,
          directorsNote: note,
        });
        if (!result.startPath) return { error: "Frame generation produced no output" };
        const rel = chatPreviewRelative("shot", ctx.scopeKey, "frames", `scene_${shot.sceneNumber}_shot_${shot.shotInScene}_v${version}_start.png`);
        ctx.store.appendIntermediate("shot", ctx.scopeKey, ctx.runId, {
          kind: "frame",
          path: rel,
          fromToolCallId: "previewFrame",
          createdAt: new Date().toISOString(),
          note,
        });
        return {
          ok: true,
          path: rel,
          url: `/api/runs/${ctx.runId}/media/${rel.split("/").map(encodeURIComponent).join("/")}`,
        };
      },
    }),

    previewVideo: ({
      description:
        "Generate a video preview using the current draft Shot and the latest frame preview (or canonical start frame). Writes only to the chat sandbox. Approval required.",
      inputSchema: z.object({ note: z.string().optional() }),
      needsApproval: true,
      execute: async ({ note }: { note?: string }) => {
        const draft = loadDraft(ctx);
        const shot = mergedShot(ctx.queueManager, ctx.sceneNumber, ctx.shotInScene, draft);
        if (!shot) return { error: "Shot not found" };
        const state = ctx.queueManager.getState();

        const runOutputAbs = resolveOutputDirAbs(state.outputDir);
        const sandboxAbs = chatPreviewDir(runOutputAbs, "shot", ctx.scopeKey);
        mkdirSync(sandboxAbs, { recursive: true });

        // Pick a start frame: latest preview frame > canonical start frame
        const session = ctx.store.load("shot", ctx.scopeKey, ctx.runId);
        const lastFrame = [...session.intermediates].reverse().find((i) => i.kind === "frame");
        let startFrameAbs: string | null = null;
        if (lastFrame) {
          startFrameAbs = join(runOutputAbs, lastFrame.path);
        } else {
          const canonicalRel = state.generatedOutputs[`frame:scene:${shot.sceneNumber}:shot:${shot.shotInScene}:start`];
          if (canonicalRel) startFrameAbs = join(runOutputAbs, canonicalRel);
        }
        if (!startFrameAbs) return { error: "No start frame available — call previewFrame first." };

        const version = Date.now();
        const result = await generateVideo({
          shotNumber: shot.shotNumber,
          sceneNumber: shot.sceneNumber,
          shotInScene: shot.shotInScene,
          shotType: "first_last_frame",
          dialogue: shot.dialogue,
          speaker: shot.speaker,
          charactersPresent: shot.charactersPresent,
          soundEffects: shot.soundEffects,
          cameraDirection: shot.cameraDirection,
          videoPrompt: shot.videoPrompt,
          durationSeconds: shot.durationSeconds,
          startFramePath: startFrameAbs,
          outputDir: sandboxAbs,
          videoBackend: state.options?.videoBackend ?? "grok",
          aspectRatio: state.options?.aspectRatio,
          version,
          directorsNote: note,
        });

        const fileName = result.path.split("/").pop()!;
        const rel = chatPreviewRelative("shot", ctx.scopeKey, fileName);
        ctx.store.appendIntermediate("shot", ctx.scopeKey, ctx.runId, {
          kind: "video",
          path: rel,
          fromToolCallId: "previewVideo",
          createdAt: new Date().toISOString(),
          note,
        });
        return {
          ok: true,
          path: rel,
          url: `/api/runs/${ctx.runId}/media/${rel.split("/").map(encodeURIComponent).join("/")}`,
          duration: result.duration,
        };
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

const SYSTEM_INSTRUCTIONS = `You are an editor for a single Shot in an AI video pipeline.

The Shot is part of a larger story analysis document. You can:
- Read the current Shot via getShot.
- See available characters/locations/objects via getStoryContext.
- See which downstream queue items would be regenerated via getDownstreamImpact.
- Stage a partial update to the Shot via updateShotFields. This goes into a draft, not the live document.
- Stage an image replacement via replaceFrameImage (requires user approval).
- Generate a preview of the new start frame via previewFrame (requires approval). This writes to a sandbox.
- Generate a preview of the new video via previewVideo (requires approval). Costly — only do this if the user explicitly asks.

Always finish your work by calling proposeApply with a short summary of the staged changes. The user will then click Apply (commits the draft) or Discard.

Never invent character/location/object names — only use those returned by getStoryContext. Validate before staging.`;

export function createShotEditorAgent(ctx: ShotEditorContext): Agent<never, ToolSet> {
  const tools = buildShotEditorTools(ctx);
  return new ToolLoopAgent({
    model: getLlmModel("strong"),
    instructions: SYSTEM_INSTRUCTIONS,
    tools,
    stopWhen: [stepCountIs(30), hasToolCall("proposeApply")],
  });
}
