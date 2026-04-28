import type { IncomingMessage, ServerResponse } from "http";
import type { UIMessage } from "ai";
import { pipeAgentUIStreamToResponse } from "ai";

import type { RunManager } from "../queue/run-manager.js";
import { ChatSessionStore, chatPreviewDir } from "./session-store.js";
import { getScopeRegistration } from "./scope-registry.js";
import "./scopes/index.js";
import type { ChatScope, ShotDraft } from "./types.js";
import { emptyShotDraft, isShotDraftEmpty } from "./types.js";

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage, maxBytes = 5_000_000): Promise<unknown> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > maxBytes) throw new Error("Request body exceeds limit");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (raw.trim().length === 0) return {};
  return JSON.parse(raw);
}

interface HandleChatOptions {
  runManager: RunManager;
  runId: string;
  scope: ChatScope;
  scopeKey: string;
  sceneNumber: number;
  shotInScene: number;
  req: IncomingMessage;
  res: ServerResponse;
}

function getStore(runManager: RunManager, runId: string): ChatSessionStore | null {
  const run = runManager.getRun(runId);
  if (!run) return null;
  return new ChatSessionStore(run.outputDir);
}

export async function handleChatGet(opts: HandleChatOptions): Promise<void> {
  const { runManager, runId, scope, scopeKey, sceneNumber, shotInScene, res } = opts;
  const store = getStore(runManager, runId);
  if (!store) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }
  const session = store.load(scope, scopeKey, runId);
  const reg = getScopeRegistration(scope);
  const scopeContext = reg?.getScopeContext?.({
    runId, scope, scopeKey, sceneNumber, shotInScene, runManager,
  }) ?? null;
  sendJson(res, 200, { ...session, scopeContext });
}

export async function handleChatPost(opts: HandleChatOptions): Promise<void> {
  const { runManager, runId, scope, scopeKey, sceneNumber, shotInScene, req, res } = opts;
  const store = getStore(runManager, runId);
  if (!store) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }
  const qm = runManager.getQueueManager(runId);
  if (!qm) { sendJson(res, 404, { error: `Run has no queue manager: ${runId}` }); return; }
  const reg = getScopeRegistration(scope);
  if (!reg) { sendJson(res, 404, { error: `Unknown chat scope: ${scope}` }); return; }

  const body = (await readJsonBody(req)) as { messages?: UIMessage[] };
  const incomingMessages = Array.isArray(body.messages) ? body.messages : [];
  if (incomingMessages.length === 0) {
    sendJson(res, 400, { error: "messages required" });
    return;
  }

  // Persist incoming messages immediately so a refresh restores user input.
  store.setMessages(scope, scopeKey, runId, incomingMessages);

  const agent = reg.agentFactory({
    runId, scope, scopeKey, sceneNumber, shotInScene, store, runManager, queueManager: qm,
  });

  res.setHeader("x-vercel-ai-ui-message-stream", "v1");

  await pipeAgentUIStreamToResponse({
    response: res,
    agent,
    uiMessages: incomingMessages as any,
    originalMessages: incomingMessages as any,
    onFinish: ({ messages }: { messages: unknown }) => {
      try {
        store.setMessages(scope, scopeKey, runId, messages as UIMessage[]);
      } catch (err) {
        console.error("[chat] Failed to persist messages on finish:", err);
      }
    },
  });
}

export async function handleChatApply(opts: HandleChatOptions): Promise<void> {
  const { runManager, runId, scope, scopeKey, sceneNumber, shotInScene, res } = opts;
  const store = getStore(runManager, runId);
  if (!store) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }
  const reg = getScopeRegistration(scope);
  if (!reg) { sendJson(res, 404, { error: `Unknown chat scope: ${scope}` }); return; }

  const session = store.load(scope, scopeKey, runId);
  if (!session.draft || isShotDraftEmpty(session.draft)) {
    sendJson(res, 200, { ok: true, regeneratedItemIds: [], imageReplacementsApplied: [] });
    return;
  }

  try {
    const result = await reg.applyDraft(
      { runId, scope, scopeKey, sceneNumber, shotInScene, runManager },
      session.draft,
    );
    store.clearDraft(scope, scopeKey, runId);
    sendJson(res, 200, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: msg });
  }
}

export async function handleChatDiscard(opts: HandleChatOptions): Promise<void> {
  const { runManager, runId, scope, scopeKey, res } = opts;
  const store = getStore(runManager, runId);
  if (!store) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }
  store.clearDraft(scope, scopeKey, runId);
  sendJson(res, 200, { ok: true });
}

export async function handleChatDraft(opts: HandleChatOptions): Promise<void> {
  const { runManager, runId, scope, scopeKey, req, res } = opts;
  const store = getStore(runManager, runId);
  if (!store) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }

  let body: { fields?: Record<string, unknown> };
  try {
    body = (await readJsonBody(req)) as { fields?: Record<string, unknown> };
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const fields = body?.fields ?? {};
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    sendJson(res, 400, { error: "fields must be an object" });
    return;
  }

  const session = store.load(scope, scopeKey, runId);
  const current: ShotDraft = session.draft ?? emptyShotDraft();
  const next: ShotDraft = {
    shotFields: { ...current.shotFields, ...(fields as Record<string, never>) },
    pendingImageReplacements: current.pendingImageReplacements,
  };
  store.setDraft(scope, scopeKey, runId, next);
  sendJson(res, 200, { ok: true, draft: next });
}

export function chatPreviewDirForRun(
  runManager: RunManager,
  runId: string,
  scope: ChatScope,
  scopeKey: string,
): string | null {
  const run = runManager.getRun(runId);
  if (!run) return null;
  return chatPreviewDir(run.outputDir, scope, scopeKey);
}
