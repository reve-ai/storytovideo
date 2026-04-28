import { mkdirSync } from "fs";
import { isAbsolute, resolve } from "path";
import { z } from "zod";
import { ToolLoopAgent, hasToolCall, stepCountIs, type Agent, type ToolSet } from "ai";

import { getLlmModel } from "../../llm-provider.js";
import { generateAsset } from "../../tools/generate-asset.js";
import type { Location } from "../../types.js";
import type { RunManager } from "../../queue/run-manager.js";
import type { QueueManager } from "../../queue/queue-manager.js";
import {
  ChatSessionStore,
  chatPreviewDir,
  chatPreviewRelative,
} from "../session-store.js";
import {
  emptyLocationDraft,
  isLocationDraft,
  type LocationDraft,
  type LocationFields,
} from "../types.js";

export interface LocationEditorContext {
  runId: string;
  scopeKey: string;
  locationName: string;
  store: ChatSessionStore;
  runManager: RunManager;
  queueManager: QueueManager;
}

function resolveOutputDirAbs(outputDir: string): string {
  return isAbsolute(outputDir) ? outputDir : resolve(process.cwd(), outputDir);
}

function getLiveLocation(qm: QueueManager, name: string): Location | null {
  const analysis = qm.getState().storyAnalysis;
  if (!analysis) return null;
  return analysis.locations?.find((l) => l.name === name) ?? null;
}

function mergedLocation(qm: QueueManager, name: string, draft: LocationDraft | null): Location | null {
  const live = getLiveLocation(qm, name);
  if (!live) return null;
  if (!draft || Object.keys(draft.locationFields).length === 0) return live;
  return { ...live, ...draft.locationFields } as Location;
}

function loadDraft(ctx: LocationEditorContext): LocationDraft {
  const session = ctx.store.load("location", ctx.scopeKey, ctx.runId);
  return isLocationDraft(session.draft) ? session.draft : emptyLocationDraft();
}

function saveDraft(ctx: LocationEditorContext, draft: LocationDraft): void {
  ctx.store.setDraft("location", ctx.scopeKey, ctx.runId, draft);
}

const updateLocationFieldsSchema = z.object({
  visualDescription: z.string().optional(),
});

export function buildLocationEditorTools(ctx: LocationEditorContext): ToolSet {
  const tools = {
    getLocation: ({
      description: "Get the current Location fields. Returns the merged value (live document with draft overrides applied).",
      inputSchema: z.object({}),
      execute: async () => {
        const draft = loadDraft(ctx);
        const location = mergedLocation(ctx.queueManager, ctx.locationName, draft);
        if (!location) return { error: `Location ${ctx.locationName} not found` };
        return { location, draftFields: draft.locationFields, pendingReferenceImage: draft.pendingReferenceImage };
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
      description: "Reports which active queue items reference this location and would be regenerated when the draft is applied.",
      inputSchema: z.object({}),
      execute: async () => {
        const items = ctx.queueManager.getState().workItems;
        const affected: Array<{ id: string; itemKey: string; type: string; status: string }> = [];
        for (const item of items) {
          if (item.status === "superseded" || item.status === "cancelled") continue;
          // The location's own asset item.
          if (item.type === "generate_asset" && item.itemKey === `asset:location:${ctx.locationName}`) {
            affected.push({ id: item.id, itemKey: item.itemKey, type: item.type, status: item.status });
            continue;
          }
          // Frame items whose shot uses this location.
          if (item.type === "generate_frame") {
            const shot = item.inputs?.shot as { location?: string } | undefined;
            if (shot?.location === ctx.locationName) {
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
        const session = ctx.store.load("location", ctx.scopeKey, ctx.runId);
        return { intermediates: session.intermediates };
      },
    }),

    updateLocationFields: ({
      description:
        "Stage a partial Location update to the draft (does NOT mutate the live document). Currently supports visualDescription.",
      inputSchema: updateLocationFieldsSchema,
      execute: async (fields: z.infer<typeof updateLocationFieldsSchema>) => {
        const live = getLiveLocation(ctx.queueManager, ctx.locationName);
        if (!live) return { error: `Location ${ctx.locationName} not found` };
        const draft = loadDraft(ctx);
        const next: LocationDraft = {
          locationFields: { ...draft.locationFields, ...fields } as LocationFields,
          pendingReferenceImage: draft.pendingReferenceImage,
        };
        saveDraft(ctx, next);
        return { ok: true, draftFields: next.locationFields };
      },
    }),

    replaceReferenceImage: ({
      description:
        "Register a pending reference-image replacement. The user must approve. The client should have already uploaded the image and provide its sandbox-relative path.",
      inputSchema: z.object({
        source: z.enum(["upload", "url"]),
        data: z.string().describe("Either the uploaded sandbox path or the URL"),
      }),
      needsApproval: true,
      execute: async (input: { source: "upload" | "url"; data: string }) => {
        const draft = loadDraft(ctx);
        const next: LocationDraft = {
          locationFields: draft.locationFields,
          pendingReferenceImage: { path: input.data },
        };
        saveDraft(ctx, next);
        return { ok: true, pendingReferenceImage: next.pendingReferenceImage };
      },
    }),

    previewReferenceImage: ({
      description:
        "Generate a reference-image preview for this location using the current draft. Writes only to the chat sandbox. Approval required.",
      inputSchema: z.object({ note: z.string().optional() }),
      needsApproval: true,
      execute: async ({ note }: { note?: string }) => {
        const draft = loadDraft(ctx);
        const location = mergedLocation(ctx.queueManager, ctx.locationName, draft);
        if (!location) return { error: "Location not found" };
        const state = ctx.queueManager.getState();
        const analysis = state.storyAnalysis;
        if (!analysis) return { error: "No storyAnalysis available" };

        const runOutputAbs = resolveOutputDirAbs(state.outputDir);
        const sandboxAbs = chatPreviewDir(runOutputAbs, "location", ctx.scopeKey);
        mkdirSync(sandboxAbs, { recursive: true });

        const version = Date.now();
        const result = await generateAsset({
          locationName: location.name,
          description: location.visualDescription,
          artStyle: analysis.artStyle,
          outputDir: sandboxAbs,
          imageBackend: state.options?.assetImageBackend ?? state.options?.imageBackend ?? "grok",
          aspectRatio: state.options?.aspectRatio,
          version,
          directorsNote: note,
        });
        if (!result?.path) return { error: "Reference image generation produced no output" };
        const fileName = result.path.split("/").pop()!;
        const rel = chatPreviewRelative("location", ctx.scopeKey, fileName);
        ctx.store.appendIntermediate("location", ctx.scopeKey, ctx.runId, {
          kind: "asset",
          path: rel,
          fromToolCallId: "previewReferenceImage",
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

const SYSTEM_INSTRUCTIONS = `You are an editor for a single Location in an AI video pipeline.

The Location belongs to a larger story analysis document. You can:
- Read the current Location via getLocation.
- See available characters/locations/objects via getStoryContext.
- See which downstream queue items would be regenerated via getDownstreamImpact.
- Stage a partial update to the Location via updateLocationFields. This goes into a draft, not the live document.
- Stage a reference-image replacement via replaceReferenceImage (requires user approval).
- Generate a preview of a new reference image via previewReferenceImage (requires approval). This writes to a sandbox.

Always finish your work by calling proposeApply with a short summary of the staged changes. The user will then click Apply (commits the draft) or Discard.`;

export function createLocationEditorAgent(ctx: LocationEditorContext): Agent<never, ToolSet> {
  const tools = buildLocationEditorTools(ctx);
  return new ToolLoopAgent({
    model: getLlmModel("strong"),
    instructions: SYSTEM_INSTRUCTIONS,
    tools,
    stopWhen: [stepCountIs(20), hasToolCall("proposeApply")],
  });
}
