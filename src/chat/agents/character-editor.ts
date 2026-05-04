import { mkdirSync } from "fs";
import { isAbsolute, resolve } from "path";
import { z } from "zod";
import { ToolLoopAgent, hasToolCall, stepCountIs, type Agent, type ToolSet } from "ai";

import { getLlmModel } from "../../llm-provider.js";
import { generateAsset } from "../../tools/generate-asset.js";
import type { Character } from "../../types.js";
import type { RunManager } from "../../queue/run-manager.js";
import type { QueueManager } from "../../queue/queue-manager.js";
import {
  ChatSessionStore,
  chatPreviewDir,
  chatPreviewRelative,
} from "../session-store.js";
import {
  emptyCharacterDraft,
  isCharacterDraft,
  type CharacterDraft,
  type CharacterFields,
} from "../types.js";
import { characterReferenceInputsHash } from "../preview-hash.js";
import { recordPreviewImageCost } from "../preview-cost.js";

export interface CharacterEditorContext {
  runId: string;
  scopeKey: string;
  characterName: string;
  store: ChatSessionStore;
  runManager: RunManager;
  queueManager: QueueManager;
}

function resolveOutputDirAbs(outputDir: string): string {
  return isAbsolute(outputDir) ? outputDir : resolve(process.cwd(), outputDir);
}

function getLiveCharacter(qm: QueueManager, name: string): Character | null {
  const analysis = qm.getState().storyAnalysis;
  if (!analysis) return null;
  return analysis.characters.find((c) => c.name === name) ?? null;
}

function mergedCharacter(qm: QueueManager, name: string, draft: CharacterDraft | null): Character | null {
  const live = getLiveCharacter(qm, name);
  if (!live) return null;
  if (!draft || Object.keys(draft.characterFields).length === 0) return live;
  return { ...live, ...draft.characterFields } as Character;
}

function loadDraft(ctx: CharacterEditorContext): CharacterDraft {
  const session = ctx.store.load("character", ctx.scopeKey, ctx.runId);
  return isCharacterDraft(session.draft) ? session.draft : emptyCharacterDraft();
}

function saveDraft(ctx: CharacterEditorContext, draft: CharacterDraft): void {
  ctx.store.setDraft("character", ctx.scopeKey, ctx.runId, draft);
}

const updateCharacterFieldsSchema = z.object({
  physicalDescription: z.string().optional(),
  personality: z.string().optional(),
  ageRange: z.string().optional(),
});

export function buildCharacterEditorTools(ctx: CharacterEditorContext): ToolSet {
  const tools = {
    getCharacter: ({
      description: "Get the current Character fields. Returns the merged value (live document with draft overrides applied).",
      inputSchema: z.object({}),
      execute: async () => {
        const draft = loadDraft(ctx);
        const character = mergedCharacter(ctx.queueManager, ctx.characterName, draft);
        if (!character) return { error: `Character ${ctx.characterName} not found` };
        return { character, draftFields: draft.characterFields, pendingReferenceImage: draft.pendingReferenceImage };
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
      description: "Reports which active queue items reference this character and would be regenerated when the draft is applied.",
      inputSchema: z.object({}),
      execute: async () => {
        const items = ctx.queueManager.getState().workItems;
        const affected: Array<{ id: string; itemKey: string; type: string; status: string }> = [];
        for (const item of items) {
          if (item.status === "superseded" || item.status === "cancelled") continue;
          // The character's own asset item.
          if (item.type === "generate_asset" && item.itemKey === `asset:character:${ctx.characterName}:front`) {
            affected.push({ id: item.id, itemKey: item.itemKey, type: item.type, status: item.status });
            continue;
          }
          // Frame items whose shot uses this character.
          if (item.type === "generate_frame") {
            const shot = item.inputs?.shot as { charactersPresent?: string[] } | undefined;
            if (Array.isArray(shot?.charactersPresent) && shot.charactersPresent.includes(ctx.characterName)) {
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
        const session = ctx.store.load("character", ctx.scopeKey, ctx.runId);
        return { intermediates: session.intermediates };
      },
    }),

    updateCharacterFields: ({
      description:
        "Stage a partial Character update to the draft (does NOT mutate the live document). Supports physicalDescription, personality, and ageRange.",
      inputSchema: updateCharacterFieldsSchema,
      execute: async (fields: z.infer<typeof updateCharacterFieldsSchema>) => {
        const live = getLiveCharacter(ctx.queueManager, ctx.characterName);
        if (!live) return { error: `Character ${ctx.characterName} not found` };
        const draft = loadDraft(ctx);
        // Aggressive invalidation: any field edit clears all preview
        // artifacts so apply.ts cannot promote stale files.
        const next: CharacterDraft = {
          characterFields: { ...draft.characterFields, ...fields } as CharacterFields,
          pendingReferenceImage: draft.pendingReferenceImage,
        };
        saveDraft(ctx, next);
        return { ok: true, draftFields: next.characterFields };
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
        const next: CharacterDraft = {
          characterFields: draft.characterFields,
          pendingReferenceImage: { path: input.data },
        };
        saveDraft(ctx, next);
        return { ok: true, pendingReferenceImage: next.pendingReferenceImage };
      },
    }),

    previewReferenceImage: ({
      description:
        "Generate a reference-image preview for this character using the current draft. Writes only to the chat sandbox. Expensive — only call when the user explicitly asks.",
      inputSchema: z.object({ note: z.string().optional() }),
      execute: async ({ note }: { note?: string }) => {
        const draft = loadDraft(ctx);
        const character = mergedCharacter(ctx.queueManager, ctx.characterName, draft);
        if (!character) return { error: "Character not found" };
        const state = ctx.queueManager.getState();
        const analysis = state.storyAnalysis;
        if (!analysis) return { error: "No storyAnalysis available" };

        const runOutputAbs = resolveOutputDirAbs(state.outputDir);
        const sandboxAbs = chatPreviewDir(runOutputAbs, "character", ctx.scopeKey);
        mkdirSync(sandboxAbs, { recursive: true });

        const version = Date.now();
        const imageBackend = state.options?.assetImageBackend ?? state.options?.imageBackend ?? "grok";
        const result = await generateAsset({
          characterName: character.name,
          description: character.physicalDescription,
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
          "character", ctx.scopeKey, "referenceImage", imageBackend,
        );
        const fileName = result.path.split("/").pop()!;
        const rel = chatPreviewRelative("character", ctx.scopeKey, fileName);
        const createdAt = new Date().toISOString();
        ctx.store.appendIntermediate("character", ctx.scopeKey, ctx.runId, {
          kind: "asset",
          path: rel,
          fromToolCallId: "previewReferenceImage",
          createdAt,
          note,
        });
        // Record promotion metadata so apply.ts can copy this sandbox
        // preview into the canonical reference image path.
        const inputsHash = characterReferenceInputsHash({ artStyle: analysis.artStyle, character });
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

const SYSTEM_INSTRUCTIONS = `You are an editor for a single Character in an AI video pipeline.

The Character belongs to a larger story analysis document. You can:
- Read the current Character via getCharacter.
- See available characters/locations/objects via getStoryContext.
- See which downstream queue items would be regenerated via getDownstreamImpact.
- Stage a partial update to the Character via updateCharacterFields. This goes into a draft, not the live document.
- Stage a reference-image replacement via replaceReferenceImage.
- Generate a preview of a new reference image via previewReferenceImage, writing to a sandbox.

Previews are expensive — only call previewReferenceImage when the user explicitly asks for a regenerated image, not as a default.

Writable fields are physicalDescription, personality, and ageRange. Of these, only physicalDescription drives reference-image generation; personality and ageRange edits update the canonical record without regenerating the asset or any frames. A physicalDescription change cascades hard: reference-image regeneration plus a frame regeneration (and therefore a video regeneration) for every shot whose charactersPresent includes this character. Edit the existing physicalDescription narrowly — preserve the prose and only adjust the part the user asked about. Do not rewrite the whole description, do not insert details (lighting, materials, scale, context) the user did not mention, and do not "polish" prose that is already fine. Use getDownstreamImpact before staging physicalDescription edits so you can tell the user how many shots will be regenerated. When in doubt about whether a tweak is worth the cascade, ask.

Tool selection:
- If the user wants to regenerate the reference image (with or without changes), call previewReferenceImage with an optional \`note\` to bias the prompt. Then call proposeApply. The user can apply the preview if they like it, or discard.
- If the user wants to change Character fields without generating a preview, stage edits with updateCharacterFields and finish with proposeApply. Apply will commit the draft and (for physicalDescription) the existing redo cascade will regenerate downstream items.

Always finish by calling proposeApply with a short summary of the staged changes (or of the preview that is ready to promote).`;

export function createCharacterEditorAgent(ctx: CharacterEditorContext): Agent<never, ToolSet> {
  const tools = buildCharacterEditorTools(ctx);
  return new ToolLoopAgent({
    model: getLlmModel("strong"),
    instructions: SYSTEM_INSTRUCTIONS,
    tools,
    stopWhen: [stepCountIs(20), hasToolCall("proposeApply")],
  });
}
