import type { IncomingMessage, ServerResponse } from "http";
import type { UIMessage, UIMessageChunk } from "ai";
import {
  lastAssistantMessageIsCompleteWithApprovalResponses,
  pipeUIMessageStreamToResponse,
} from "ai";

import type { RunManager } from "../queue/run-manager.js";
import { ChatSessionStore, chatPreviewDir } from "./session-store.js";
import { getScopeRegistration } from "./scope-registry.js";
import "./scopes/index.js";
import { clearEvents, readEvents } from "./event-log.js";
import {
  getOrCreateRunner,
  getRunner,
  hasRunner,
  listActiveChats,
  removeRunner,
} from "./runner-registry.js";
import type { ChatScope, LocationDraft, LocationFields, ShotDraft, StoryDraft, StoryFields } from "./types.js";
import {
  emptyLocationDraft,
  emptyShotDraft,
  emptyStoryDraft,
  isDraftEmpty,
  isLocationDraft,
  isShotDraft,
  isStoryDraft,
} from "./types.js";

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
  let session = store.load(scope, scopeKey, runId);
  // Reconcile persisted "running" with reality: if no live runner exists, the
  // previous process crashed or the runner was garbage-collected. Promote the
  // file to "interrupted" so the client surfaces the banner instead of trying
  // to attach to a live stream that no longer exists.
  if (session.runStatus === "running" && !hasRunner(runId, scope, scopeKey)) {
    session = store.setRunStatus(scope, scopeKey, runId, "interrupted");
  }
  const reg = getScopeRegistration(scope);
  const scopeContext = reg?.getScopeContext?.({
    runId, scope, scopeKey, sceneNumber, shotInScene, runManager,
  }) ?? null;
  sendJson(res, 200, { ...session, scopeContext });
}

function getRunOutputDir(runManager: RunManager, runId: string): string | null {
  const run = runManager.getRun(runId);
  return run?.outputDir ?? null;
}

/**
 * Diff `incoming` against the runner's history and return only the user
 * messages the client just appended. We restrict to role==="user" because
 * during a mid-stream POST the client's local history may include a
 * partially-streamed assistant message that the runner hasn't persisted yet.
 */
function appendedMessages(known: UIMessage[], incoming: UIMessage[]): UIMessage[] {
  if (incoming.length <= known.length) return [];
  return incoming.slice(known.length).filter((m) => m.role === "user");
}

export async function handleChatPost(opts: HandleChatOptions): Promise<void> {
  const { runManager, runId, scope, scopeKey, sceneNumber, shotInScene, req, res } = opts;
  const store = getStore(runManager, runId);
  if (!store) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }
  const qm = runManager.getQueueManager(runId);
  if (!qm) { sendJson(res, 404, { error: `Run has no queue manager: ${runId}` }); return; }
  const reg = getScopeRegistration(scope);
  if (!reg) { sendJson(res, 404, { error: `Unknown chat scope: ${scope}` }); return; }
  const outputDir = getRunOutputDir(runManager, runId);
  if (!outputDir) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }

  const body = (await readJsonBody(req)) as { messages?: UIMessage[] };
  const incomingMessages = Array.isArray(body.messages) ? body.messages : [];
  if (incomingMessages.length === 0) {
    sendJson(res, 400, { error: "messages required" });
    return;
  }

  const runner = getOrCreateRunner({
    runId, scope, scopeKey, sceneNumber, shotInScene, outputDir, store, runManager,
  });

  // Diff against the runner's view of history (matches persisted state when
  // idle, and tracks live mid-turn state otherwise) so we only enqueue the
  // user messages the client actually appended this round.
  const baseHistory = runner.getHistory();
  const newMessages = appendedMessages(baseHistory, incomingMessages);
  // Tool approvals don't append a user message — the client mutates the
  // existing assistant message in place, flipping tool-part `state` from
  // "approval-requested" to "approval-responded". In that case the
  // length-based diff yields nothing, so detect the continuation via the
  // ai SDK helper and overwrite history instead of appending.
  const isApprovalContinuation =
    newMessages.length === 0 &&
    lastAssistantMessageIsCompleteWithApprovalResponses({ messages: incomingMessages });
  if (newMessages.length === 0 && !isApprovalContinuation) {
    sendJson(res, 400, { error: "no new messages to send" });
    return;
  }

  // Enqueue first so the runner transitions to running synchronously, then
  // subscribe — otherwise subscribe() may auto-close because it sees the
  // runner as idle right between turns.
  if (isApprovalContinuation) {
    runner.enqueueContinuation(incomingMessages);
  } else {
    runner.enqueue(newMessages);
  }
  const stream = runner.subscribe();

  pipeUIMessageStreamToResponse({ response: res, stream });
}

export async function handleChatApply(opts: HandleChatOptions): Promise<void> {
  const { runManager, runId, scope, scopeKey, sceneNumber, shotInScene, res } = opts;
  const store = getStore(runManager, runId);
  if (!store) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }
  const reg = getScopeRegistration(scope);
  if (!reg) { sendJson(res, 404, { error: `Unknown chat scope: ${scope}` }); return; }

  const session = store.load(scope, scopeKey, runId);
  if (!session.draft || isDraftEmpty(session.draft)) {
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
  if (scope === "location") {
    const current: LocationDraft = isLocationDraft(session.draft) ? session.draft : emptyLocationDraft();
    const next: LocationDraft = {
      locationFields: { ...current.locationFields, ...(fields as LocationFields) },
      pendingReferenceImage: current.pendingReferenceImage,
    };
    store.setDraft(scope, scopeKey, runId, next);
    sendJson(res, 200, { ok: true, draft: next });
    return;
  }
  if (scope === "story") {
    const current: StoryDraft = isStoryDraft(session.draft) ? session.draft : emptyStoryDraft();
    const next: StoryDraft = {
      storyFields: { ...current.storyFields, ...(fields as StoryFields) },
    };
    store.setDraft(scope, scopeKey, runId, next);
    sendJson(res, 200, { ok: true, draft: next });
    return;
  }
  const current: ShotDraft = isShotDraft(session.draft) ? session.draft : emptyShotDraft();
  const next: ShotDraft = {
    shotFields: { ...current.shotFields, ...(fields as Record<string, never>) },
    pendingImageReplacements: current.pendingImageReplacements,
  };
  store.setDraft(scope, scopeKey, runId, next);
  sendJson(res, 200, { ok: true, draft: next });
}

/**
 * GET /api/runs/:id/chat/<scope>/<scopeKey>/stream — re-attach to an in-flight
 * agent run. Replays the events log (chunks emitted so far this turn) then
 * tails new events until the runner finishes. If no runner is active, returns
 * 204 (matching DefaultChatTransport.reconnectToStream's "nothing to resume"
 * contract).
 */
export async function handleChatStream(opts: HandleChatOptions): Promise<void> {
  const { runManager, runId, scope, scopeKey, res } = opts;
  const outputDir = getRunOutputDir(runManager, runId);
  if (!outputDir) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }
  const runner = getRunner(runId, scope, scopeKey);
  if (!runner || !runner.isRunning()) {
    res.statusCode = 204;
    res.end();
    return;
  }
  // The runner's subscribe() already replays its in-memory buffer (which is a
  // mirror of the events log for the current turn) before tailing live chunks.
  const stream = runner.subscribe();
  pipeUIMessageStreamToResponse({ response: res, stream });
}

/**
 * POST /api/runs/:id/chat/<scope>/<scopeKey>/cancel — abort the runner.
 */
export async function handleChatCancel(opts: HandleChatOptions): Promise<void> {
  const { runId, scope, scopeKey, res } = opts;
  const runner = getRunner(runId, scope, scopeKey);
  if (!runner) { sendJson(res, 200, { ok: true, cancelled: false }); return; }
  runner.cancel();
  sendJson(res, 200, { ok: true, cancelled: true });
}

/**
 * POST /api/runs/:id/chat/<scope>/<scopeKey>/reset — wipe the chat session
 * back to an empty state. This is the escape hatch for sessions stuck because
 * an assistant tool-call has no matching tool-result (Anthropic rejects any
 * further messages otherwise). Cancels and drops any active runner, clears
 * the persisted session JSON and the events log. Does not touch the canonical
 * document.
 */
export async function handleChatReset(opts: HandleChatOptions): Promise<void> {
  const { runManager, runId, scope, scopeKey, res } = opts;
  const store = getStore(runManager, runId);
  if (!store) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }
  const outputDir = getRunOutputDir(runManager, runId);
  if (!outputDir) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }

  const runner = getRunner(runId, scope, scopeKey);
  if (runner) {
    try { runner.cancel(); } catch (err) {
      console.error("[handleChatReset] runner.cancel() failed:", err);
    }
  }
  removeRunner(runId, scope, scopeKey);

  store.reset(scope, scopeKey, runId);
  try {
    clearEvents(outputDir, scope, scopeKey);
  } catch (err) {
    console.error("[handleChatReset] clearEvents failed:", err);
  }

  sendJson(res, 200, { ok: true });
}

/**
 * GET /api/runs/:id/chats/active — list active runners for the run, used by
 * the TopBar indicator.
 */
export function handleChatActive(
  runManager: RunManager,
  runId: string,
  res: ServerResponse,
): void {
  const run = runManager.getRun(runId);
  if (!run) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }
  sendJson(res, 200, { runId, chats: listActiveChats(runId) });
}

/**
 * Read persisted chunks from disk for diagnostics. Not currently exposed via
 * an HTTP route, but exported so tooling can verify the events log.
 */
export function readPersistedEvents(
  runManager: RunManager,
  runId: string,
  scope: ChatScope,
  scopeKey: string,
): UIMessageChunk[] {
  const outputDir = getRunOutputDir(runManager, runId);
  if (!outputDir) return [];
  return readEvents(outputDir, scope, scopeKey);
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
