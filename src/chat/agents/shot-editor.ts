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
import {
  shotFrameInputsHash,
  shotVideoInputsHash,
  shotFrameFieldsDiffer,
} from "../preview-hash.js";

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

/** Decision returned by `pickVideoStartFrame`. The previewVideo executor
 *  dispatches on `kind` to decide what to feed into the video backend.
 *  - `fresh-preview`: a sandbox frame in `previewArtifacts.frame` whose
 *    inputs hash matches the current merged-draft shot. Use it directly.
 *  - `dirty-needs-preview`: the merged shot differs from canonical on
 *    frame-affecting fields and no fresh sandbox preview exists. Caller
 *    must auto-generate a frame preview first (via `runFramePreview`) and
 *    then use that sandbox file.
 *  - `canonical`: the merged shot's frame inputs equal the canonical
 *    shot's. Use the canonical generated start frame from `generatedOutputs`.
 *  - `no-frame-available`: nothing to fall back on (shot was never
 *    rendered). Caller surfaces an error. */
export type VideoStartFrameDecision =
  | { kind: "fresh-preview"; sandboxRel: string }
  | { kind: "dirty-needs-preview" }
  | { kind: "canonical"; canonicalRel: string }
  | { kind: "no-frame-available" };

/** Pure decision function: given the current draft + canonical state,
 *  pick which start frame `previewVideo` should feed into the backend.
 *  - Freshness check uses the same hash that `runFramePreview` writes so a
 *    just-generated preview is recognized.
 *  - Dirty check compares only frame-affecting fields against the live
 *    shot, so a draft that edits video-only fields (durationSeconds,
 *    videoPrompt, dialogue, ...) still uses the canonical start frame. */
export function pickVideoStartFrame(opts: {
  artStyle: string;
  mergedShot: Shot;
  liveShot: Shot;
  draft: ShotDraft;
  generatedOutputs: Record<string, string>;
}): VideoStartFrameDecision {
  const mergedHash = shotFrameInputsHash({ artStyle: opts.artStyle, shot: opts.mergedShot });
  const previewArt = opts.draft.previewArtifacts?.frame;
  if (previewArt && previewArt.inputsHash === mergedHash) {
    return { kind: "fresh-preview", sandboxRel: previewArt.sandboxPath };
  }
  if (shotFrameFieldsDiffer(opts.liveShot, opts.mergedShot)) {
    return { kind: "dirty-needs-preview" };
  }
  const canonicalRel = opts.generatedOutputs[
    `frame:scene:${opts.mergedShot.sceneNumber}:shot:${opts.mergedShot.shotInScene}:start`
  ];
  if (canonicalRel) return { kind: "canonical", canonicalRel };
  return { kind: "no-frame-available" };
}

export interface FramePreviewSuccess {
  ok: true;
  sandboxAbs: string;
  sandboxRel: string;
  inputsHash: string;
  url: string;
}
export interface FramePreviewFailure { ok: false; error: string }
export type FramePreviewResult = FramePreviewSuccess | FramePreviewFailure;

/** Generate a frame preview for the current draft shot, persist it as
 *  `previewArtifacts.frame` and append a session intermediate. Used by both
 *  the explicit `previewFrame` tool and `previewVideo`'s auto-refresh path
 *  so the inputs-hash recorded on the artifact is always computed by the
 *  same code (the freshness check on the way back out depends on it).
 *  `generate` is injectable for tests; production callers use the default. */
export async function runFramePreview(
  ctx: ShotEditorContext,
  opts: { note?: string; generate?: typeof generateFrame } = {},
): Promise<FramePreviewResult> {
  const draft = loadDraft(ctx);
  const shot = mergedShot(ctx.queueManager, ctx.sceneNumber, ctx.shotInScene, draft);
  if (!shot) return { ok: false, error: "Shot not found" };
  const state = ctx.queueManager.getState();
  const analysis = state.storyAnalysis;
  if (!analysis) return { ok: false, error: "No storyAnalysis available" };
  const assetLibrary = ctx.queueManager.resolveAssetLibrary();
  if (!assetLibrary) return { ok: false, error: "Asset library not built yet" };

  const runOutputAbs = resolveOutputDirAbs(state.outputDir);
  const sandboxAbs = chatPreviewDir(runOutputAbs, "shot", ctx.scopeKey);
  mkdirSync(sandboxAbs, { recursive: true });

  const version = Date.now();
  const generate = opts.generate ?? generateFrame;
  const result = await generate({
    shot,
    artStyle: analysis.artStyle,
    assetLibrary,
    outputDir: sandboxAbs,
    imageBackend: state.options?.imageBackend ?? "grok",
    aspectRatio: state.options?.aspectRatio,
    version,
    directorsNote: opts.note,
  });
  if (!result.startPath) return { ok: false, error: "Frame generation produced no output" };
  const rel = chatPreviewRelative(
    "shot", ctx.scopeKey, "frames",
    `scene_${shot.sceneNumber}_shot_${shot.shotInScene}_v${version}_start.png`,
  );
  const createdAt = new Date().toISOString();
  ctx.store.appendIntermediate("shot", ctx.scopeKey, ctx.runId, {
    kind: "frame",
    path: rel,
    fromToolCallId: "previewFrame",
    createdAt,
    note: opts.note,
  });
  const inputsHash = shotFrameInputsHash({ artStyle: analysis.artStyle, shot });
  const refreshed = loadDraft(ctx);
  saveDraft(ctx, {
    ...refreshed,
    previewArtifacts: {
      ...(refreshed.previewArtifacts ?? {}),
      frame: { sandboxPath: rel, createdAt, inputsHash },
    },
  });
  return {
    ok: true,
    sandboxAbs: result.startPath,
    sandboxRel: rel,
    inputsHash,
    url: `/api/runs/${ctx.runId}/media/${rel.split("/").map(encodeURIComponent).join("/")}`,
  };
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
        // Aggressive invalidation: any field edit invalidates all previews
        // for this draft so apply.ts cannot promote stale artifacts.
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
        "Register a pending start/end frame image replacement. For 'upload', the client should have already uploaded the image and provide its sandbox path.",
      inputSchema: z.object({
        which: z.enum(["start", "end"]),
        source: z.enum(["upload", "url"]),
        data: z.string().describe("Either the uploaded sandbox path or the URL"),
      }),
      execute: async (input: { which: "start" | "end"; source: "upload" | "url"; data: string }) => {
        const draft = loadDraft(ctx);
        const filtered = draft.pendingImageReplacements.filter((r) => r.which !== input.which);
        // Image replacement also invalidates previews — they were generated
        // against the old start/end frame.
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
        "Generate a frame preview using the current draft Shot. Writes only to the chat sandbox. Expensive — only call when the user explicitly asks.",
      inputSchema: z.object({ note: z.string().optional() }),
      execute: async ({ note }: { note?: string }) => {
        const result = await runFramePreview(ctx, { note });
        if (!result.ok) return { error: result.error };
        return { ok: true, path: result.sandboxRel, url: result.url };
      },
    }),

    previewVideo: ({
      description:
        "Generate a video preview using the current draft Shot. Writes only to the chat sandbox. " +
        "Start-frame handling is automatic: if the draft has frame-affecting edits and no fresh frame preview, " +
        "previewVideo first regenerates the frame preview and uses it. You do NOT need to call previewFrame " +
        "before previewVideo. Use previewFrame only when you want to iterate on framing without burning a video. " +
        "Expensive — only call when the user explicitly asks.",
      inputSchema: z.object({ note: z.string().optional() }),
      execute: async ({ note }: { note?: string }) => {
        const draft = loadDraft(ctx);
        const shot = mergedShot(ctx.queueManager, ctx.sceneNumber, ctx.shotInScene, draft);
        if (!shot) return { error: "Shot not found" };
        const liveShot = getShotFromState(ctx.queueManager, ctx.sceneNumber, ctx.shotInScene);
        if (!liveShot) return { error: "Shot not found" };
        const state = ctx.queueManager.getState();
        const analysis = state.storyAnalysis;
        if (!analysis) return { error: "No storyAnalysis available" };

        const runOutputAbs = resolveOutputDirAbs(state.outputDir);
        const sandboxAbs = chatPreviewDir(runOutputAbs, "shot", ctx.scopeKey);
        mkdirSync(sandboxAbs, { recursive: true });

        // Decide which start frame to feed into the video backend. The
        // sandbox preview is preferred when its inputs hash matches the
        // current merged-draft shot — that guarantees the user sees a video
        // built on the framing they just previewed. When the draft has
        // frame-affecting edits but no fresh preview, auto-regenerate via
        // the same helper that powers `previewFrame` so the artifact
        // persists into the draft and Apply can promote it later.
        const decision = pickVideoStartFrame({
          artStyle: analysis.artStyle,
          mergedShot: shot,
          liveShot,
          draft,
          generatedOutputs: state.generatedOutputs,
        });
        let startFrameAbs: string | null = null;
        if (decision.kind === "fresh-preview") {
          startFrameAbs = join(runOutputAbs, decision.sandboxRel);
        } else if (decision.kind === "dirty-needs-preview") {
          const r = await runFramePreview(ctx, { note });
          if (!r.ok) return { error: `Auto frame preview failed: ${r.error}` };
          startFrameAbs = r.sandboxAbs;
        } else if (decision.kind === "canonical") {
          startFrameAbs = join(runOutputAbs, decision.canonicalRel);
        } else {
          return { error: "No start frame available — call previewFrame first." };
        }

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
        const createdAt = new Date().toISOString();
        ctx.store.appendIntermediate("shot", ctx.scopeKey, ctx.runId, {
          kind: "video",
          path: rel,
          fromToolCallId: "previewVideo",
          createdAt,
          note,
        });
        // Record promotion metadata so apply.ts can copy this preview video
        // into the canonical clip path instead of regenerating.
        const inputsHash = shotVideoInputsHash({ artStyle: analysis.artStyle, shot });
        const refreshed = loadDraft(ctx);
        saveDraft(ctx, {
          ...refreshed,
          previewArtifacts: {
            ...(refreshed.previewArtifacts ?? {}),
            video: { sandboxPath: rel, createdAt, inputsHash },
          },
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
- Stage an image replacement via replaceFrameImage.
- Generate a preview of the new start frame via previewFrame, writing to a sandbox.
- Generate a preview of the new video via previewVideo, writing to a sandbox.

Previews are expensive — only call previewFrame / previewVideo when the user explicitly asks for a regenerated artifact, not as a default.

Tool selection:
- If the user wants to regenerate the frame or video (with or without changes), call previewFrame or previewVideo with an optional \`note\` to bias the prompt. Then call proposeApply. The user can apply the preview if they like it, or discard.
- If the user wants to change Shot fields (composition, prompts, dialogue, location, etc.) without generating a preview, stage edits with updateShotFields and finish with proposeApply. Apply will commit the draft and the existing redo cascade will regenerate downstream items.

Always finish by calling proposeApply with a short summary of the staged changes (or of the previews that are ready to promote).

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
