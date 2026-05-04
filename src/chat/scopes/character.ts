import type { Character } from "../../types.js";
import { applyCharacterDraft } from "../apply/character.js";
import { createCharacterEditorAgent } from "../agents/character-editor.js";
import { registerScope } from "../scope-registry.js";
import { isCharacterDraft } from "../types.js";

registerScope("character", {
  agentFactory: (ctx) =>
    createCharacterEditorAgent({
      runId: ctx.runId,
      scopeKey: ctx.scopeKey,
      characterName: decodeURIComponent(ctx.scopeKey),
      store: ctx.store,
      runManager: ctx.runManager,
      queueManager: ctx.queueManager,
    }),
  applyDraft: async (ctx, draft) => {
    if (!isCharacterDraft(draft)) throw new Error("character scope received non-character draft");
    return applyCharacterDraft(ctx.runManager, ctx.runId, ctx.scopeKey, draft);
  },
  getScopeContext: (ctx) => {
    const qm = ctx.runManager.getQueueManager(ctx.runId);
    if (!qm) return { liveCharacter: null, storyContext: null, downstream: [] };
    const analysis = qm.getState().storyAnalysis;
    const characterName = decodeURIComponent(ctx.scopeKey);
    const liveCharacter: Character | null =
      analysis?.characters.find((c) => c.name === characterName) ?? null;
    const storyContext = analysis
      ? {
          title: analysis.title,
          artStyle: analysis.artStyle,
          characters: analysis.characters.map((c) => c.name),
          locations: analysis.locations.map((l) => l.name),
          objects: (analysis.objects ?? []).map((o) => o.name),
        }
      : null;

    const downstream: Array<{ id: string; itemKey: string; type: string; status: string }> = [];
    const items = qm.getState().workItems;
    for (const item of items) {
      if (item.status === "superseded" || item.status === "cancelled") continue;
      if (item.type === "generate_asset" && item.itemKey === `asset:character:${characterName}:front`) {
        downstream.push({ id: item.id, itemKey: item.itemKey, type: item.type, status: item.status });
        continue;
      }
      if (item.type === "generate_frame") {
        const shot = item.inputs?.shot as { charactersPresent?: string[] } | undefined;
        if (Array.isArray(shot?.charactersPresent) && shot.charactersPresent.includes(characterName)) {
          downstream.push({ id: item.id, itemKey: item.itemKey, type: item.type, status: item.status });
        }
      }
    }
    return { liveCharacter, storyContext, downstream };
  },
});
