import { mkdirSync } from "fs";
import { isAbsolute, resolve } from "path";
import { z } from "zod";
import { ToolLoopAgent, hasToolCall, stepCountIs, type Agent, type ToolSet } from "ai";

import { getLlmModel } from "../../llm-provider.js";
import { generateAsset } from "../../tools/generate-asset.js";
import type { StoryObject } from "../../types.js";
import type { RunManager } from "../../queue/run-manager.js";
import type { QueueManager } from "../../queue/queue-manager.js";
import {
  ChatSessionStore,
  chatPreviewDir,
  chatPreviewRelative,
} from "../session-store.js";
import {
  emptyObjectDraft,
  isObjectDraft,
  type ObjectDraft,
  type ObjectFields,
} from "../types.js";
import { objectReferenceInputsHash } from "../preview-hash.js";
import { recordPreviewImageCost } from "../preview-cost.js";

export interface ObjectEditorContext {
  runId: string;
  scopeKey: string;
  objectName: string;
  store: ChatSessionStore;
  runManager: RunManager;
  queueManager: QueueManager;
}

function resolveOutputDirAbs(outputDir: string): string {
  return isAbsolute(outputDir) ? outputDir : resolve(process.cwd(), outputDir);
}

function getLiveObject(qm: QueueManager, name: string): StoryObject | null {
  const analysis = qm.getState().storyAnalysis;
  if (!analysis) return null;
  return (analysis.objects ?? []).find((o) => o.name === name) ?? null;
}

function mergedObject(qm: QueueManager, name: string, draft: ObjectDraft | null): StoryObject | null {
  const live = getLiveObject(qm, name);
  if (!live) return null;
  if (!draft || Object.keys(draft.objectFields).length === 0) return live;
  return { ...live, ...draft.objectFields } as StoryObject;
}

function loadDraft(ctx: ObjectEditorContext): ObjectDraft {
  const session = ctx.store.load("object", ctx.scopeKey, ctx.runId);
  return isObjectDraft(session.draft) ? session.draft : emptyObjectDraft();
}

function saveDraft(ctx: ObjectEditorContext, draft: ObjectDraft): void {
  ctx.store.setDraft("object", ctx.scopeKey, ctx.runId, draft);
}

const updateObjectFieldsSchema = z.object({
  visualDescription: z.string().optional(),
});

export function buildObjectEditorTools(ctx: ObjectEditorContext): ToolSet {
  const tools = {
    getObject: ({
      description: "Get the current Object fields. Returns the merged value (live document with draft overrides applied).",
      inputSchema: z.object({}),
      execute: async () => {
        const draft = loadDraft(ctx);
        const object = mergedObject(ctx.queueManager, ctx.objectName, draft);
        if (!object) return { error: `Object ${ctx.objectName} not found` };
        return { object, draftFields: draft.objectFields, pendingReferenceImage: draft.pendingReferenceImage };
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
      description: "Reports which active queue items reference this object and would be regenerated when the draft is applied.",
      inputSchema: z.object({}),
      execute: async () => {
        const items = ctx.queueManager.getState().workItems;
        const affected: Array<{ id: string; itemKey: string; type: string; status: string }> = [];
        for (const item of items) {
          if (item.status === "superseded" || item.status === "cancelled") continue;
          // The object's own asset item.
          if (item.type === "generate_asset" && item.itemKey === `asset:object:${ctx.objectName}`) {
            affected.push({ id: item.id, itemKey: item.itemKey, type: item.type, status: item.status });
            continue;
          }
          // Frame items whose shot uses this object.
          if (item.type === "generate_frame") {
            const shot = item.inputs?.shot as { objectsPresent?: string[] } | undefined;
            if (Array.isArray(shot?.objectsPresent) && shot.objectsPresent.includes(ctx.objectName)) {
              affected.push({ id: item.id, itemKey: item.itemKey, type: item.type, status: item.status });
            }
          }
        }
        return { affected };
      },
    }),

    listIntermediates: ({
      description: "List preview reference images already generated in this session.",
      inputSchema: z.object({}),
      execute: async () => {
        const session = ctx.store.load("object", ctx.scopeKey, ctx.runId);
        return { intermediates: session.intermediates };
      },
    }),

    updateObjectFields: ({
      description:
        "Stage a partial Object update to the draft (does NOT mutate the live document). Currently supports visualDescription.",
      inputSchema: updateObjectFieldsSchema,
      execute: async (fields: z.infer<typeof updateObjectFieldsSchema>) => {
        const live = getLiveObject(ctx.queueManager, ctx.objectName);
        if (!live) return { error: `Object ${ctx.objectName} not found` };
        const draft = loadDraft(ctx);
        // Aggressive invalidation: any field edit clears all preview
        // artifacts so apply.ts cannot promote stale files.
        const next: ObjectDraft = {
          objectFields: { ...draft.objectFields, ...fields } as ObjectFields,
          pendingReferenceImage: draft.pendingReferenceImage,
        };
        saveDraft(ctx, next);
        return { ok: true, draftFields: next.objectFields };
      },
    }),

    replaceReferenceImage: ({
      description:
        "Register a pending reference-image replacement. The client should have already uploaded the image and provide its sandbox-relative path.",
      inputSchema: z.object({
        source: z.enum(["upload", "url"]),
        data: z.string().describe("Either the uploaded sandbox path or the URL"),
      }),
      execute: async (input: { source: "upload" | "url"; data: string }) => {
        const draft = loadDraft(ctx);
        // Image replacement is a draft mutation — clear preview artifacts.
        const next: ObjectDraft = {
          objectFields: draft.objectFields,
          pendingReferenceImage: { path: input.data },
        };
        saveDraft(ctx, next);
        return { ok: true, pendingReferenceImage: next.pendingReferenceImage };
      },
    }),

    previewReferenceImage: ({
      description:
        "Generate a reference-image preview for this object using the current draft. Writes only to the chat sandbox. Expensive — only call when the user explicitly asks.",
      inputSchema: z.object({ note: z.string().optional() }),
      execute: async ({ note }: { note?: string }) => {
        const draft = loadDraft(ctx);
        const object = mergedObject(ctx.queueManager, ctx.objectName, draft);
        if (!object) return { error: "Object not found" };
        const state = ctx.queueManager.getState();
        const analysis = state.storyAnalysis;
        if (!analysis) return { error: "No storyAnalysis available" };

        const runOutputAbs = resolveOutputDirAbs(state.outputDir);
        const sandboxAbs = chatPreviewDir(runOutputAbs, "object", ctx.scopeKey);
        mkdirSync(sandboxAbs, { recursive: true });

        const version = Date.now();
        const imageBackend = state.options?.assetImageBackend ?? state.options?.imageBackend ?? "grok";
        const result = await generateAsset({
          objectName: object.name,
          description: object.visualDescription,
          artStyle: analysis.artStyle,
          outputDir: sandboxAbs,
          imageBackend,
          aspectRatio: state.options?.aspectRatio,
          version,
          directorsNote: note,
        });
        if (!result?.path) return { error: "Reference image generation produced no output" };
        recordPreviewImageCost(
          ctx.queueManager, ctx.runManager, ctx.runId,
          "object", ctx.scopeKey, "referenceImage", imageBackend,
        );
        const fileName = result.path.split("/").pop()!;
        const rel = chatPreviewRelative("object", ctx.scopeKey, fileName);
        const createdAt = new Date().toISOString();
        ctx.store.appendIntermediate("object", ctx.scopeKey, ctx.runId, {
          kind: "asset",
          path: rel,
          fromToolCallId: "previewReferenceImage",
          createdAt,
          note,
        });
        // Record promotion metadata so apply.ts can copy this sandbox
        // preview into the canonical reference image path.
        const inputsHash = objectReferenceInputsHash({ artStyle: analysis.artStyle, object });
        const refreshed = loadDraft(ctx);
        saveDraft(ctx, {
          ...refreshed,
          previewArtifacts: {
            ...(refreshed.previewArtifacts ?? {}),
            referenceImage: { sandboxPath: rel, createdAt, inputsHash },
          },
        });
        return {
          ok: true,
          path: rel,
          url: `/api/runs/${ctx.runId}/media/${rel.split("/").map(encodeURIComponent).join("/")}`,
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

const SYSTEM_INSTRUCTIONS = `You are an editor for a single Object in an AI video pipeline.

The Object belongs to a larger story analysis document. You can:
- Read the current Object via getObject.
- See available characters/locations/objects via getStoryContext.
- See which downstream queue items would be regenerated via getDownstreamImpact.
- Stage a partial update to the Object via updateObjectFields. This goes into a draft, not the live document.
- Stage a reference-image replacement via replaceReferenceImage.
- Generate a preview of a new reference image via previewReferenceImage, writing to a sandbox.

Previews are expensive — only call previewReferenceImage when the user explicitly asks for a regenerated image, not as a default.

Minimal-change discipline. The only writable field is visualDescription, and any change to it cascades hard: reference-image regeneration plus a frame regeneration (and therefore a video regeneration) for every shot that uses this object. Edit the existing visualDescription narrowly — preserve the prose and only adjust the part the user asked about. Do not rewrite the whole description, do not insert details (lighting, materials, scale, context) the user did not mention, and do not "polish" prose that is already fine. Use getDownstreamImpact before staging so you can tell the user how many shots will be regenerated. When in doubt about whether a tweak is worth the cascade, ask.

Tool selection:
- If the user wants to regenerate the reference image (with or without changes), call previewReferenceImage with an optional \`note\` to bias the prompt. Then call proposeApply. The user can apply the preview if they like it, or discard.
- If the user wants to change the Object description without generating a preview, stage edits with updateObjectFields and finish with proposeApply. Apply will commit the draft and the existing redo cascade will regenerate downstream items.

Always finish by calling proposeApply with a short summary of the staged changes (or of the preview that is ready to promote).`;

export function createObjectEditorAgent(ctx: ObjectEditorContext): Agent<never, ToolSet> {
  const tools = buildObjectEditorTools(ctx);
  return new ToolLoopAgent({
    model: getLlmModel("strong"),
    instructions: SYSTEM_INSTRUCTIONS,
    tools,
    stopWhen: [stepCountIs(20), hasToolCall("proposeApply")],
  });
}
