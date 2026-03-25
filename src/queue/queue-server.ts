import "dotenv/config";
import {
  createReadStream,
  existsSync,
  readFileSync,
  statSync,
} from "fs";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { join, resolve, extname } from "path";

import { RunManager } from "./run-manager.js";
import type { QueueName, WorkItem } from "./types.js";

// ---------------------------------------------------------------------------
// Media helpers (inlined from deleted server-assets.ts)
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".json": "application/json; charset=utf-8",
};

function resolveMediaPathForRun(outputDir: string, encodedSegments: string[]): string | null {
  if (encodedSegments.length === 0) return null;
  const decodedPath = encodedSegments.map((s) => decodeURIComponent(s)).join("/");
  const candidate = resolve(outputDir, decodedPath);
  const runRoot = resolve(outputDir);
  if (candidate !== runRoot && !candidate.startsWith(`${runRoot}/`)) return null;
  return candidate;
}

function detectMimeType(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PORT = Number(process.env.QUEUE_SERVER_PORT ?? "3000");
const WEB_ROOT = resolve(process.cwd(), "src", "queue", "queue-web");
const SHUTDOWN_TIMEOUT_MS = 1_500;
const SSE_HEARTBEAT_MS = 15_000;
const EVENT_HISTORY_LIMIT = 2_000;

// ---------------------------------------------------------------------------
// RunManager singleton
// ---------------------------------------------------------------------------

const runManager = new RunManager();
runManager.loadExistingRuns();

// ---------------------------------------------------------------------------
// SSE event system
// ---------------------------------------------------------------------------

interface QueueEvent {
  id: number;
  runId: string;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

const eventsByRunId = new Map<string, QueueEvent[]>();
const eventSeqByRunId = new Map<string, number>();
const sseClientsByRunId = new Map<string, Set<ServerResponse>>();

function nextEventId(runId: string): number {
  const next = (eventSeqByRunId.get(runId) ?? 0) + 1;
  eventSeqByRunId.set(runId, next);
  return next;
}

function emitEvent(runId: string, type: string, payload: Record<string, unknown>): void {
  const event: QueueEvent = {
    id: nextEventId(runId),
    runId,
    type,
    timestamp: new Date().toISOString(),
    payload,
  };

  const history = eventsByRunId.get(runId) ?? [];
  history.push(event);
  if (history.length > EVENT_HISTORY_LIMIT) {
    history.splice(0, history.length - EVENT_HISTORY_LIMIT);
  }
  eventsByRunId.set(runId, history);

  const clients = sseClientsByRunId.get(runId);
  if (!clients) return;

  for (const client of [...clients]) {
    if (client.writableEnded) {
      clients.delete(client);
      continue;
    }
    writeSseEvent(client, event);
  }

  if (clients.size === 0) {
    sseClientsByRunId.delete(runId);
  }
}

function writeSseEvent(res: ServerResponse, event: QueueEvent): void {
  res.write(`id: ${event.id}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// Wire up RunManager + processor events to SSE
runManager.on("run:created", (record) => {
  emitEvent(record.id, "run_status", { status: "running" });
});

runManager.on("run:updated", (record) => {
  emitEvent(record.id, "run_status", { status: record.status, name: record.name });
});

runManager.on("pipeline:pause", (data: { runId: string; item: { itemKey: string }; error: string }) => {
  emitEvent(data.runId, "pipeline_paused", {
    reason: `Pipeline paused: ${data.item.itemKey} failed after max retries`,
    itemKey: data.item.itemKey,
    error: data.error,
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Last-Event-ID");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > maxBytes) throw new Error(`Request body exceeds limit`);
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (raw.trim().length === 0) return {};
  try { return JSON.parse(raw); } catch { throw new Error("Invalid JSON"); }
}

// ---------------------------------------------------------------------------
// Wire processor events (forwarded through RunManager)
// ---------------------------------------------------------------------------

// Listen for item-level events from processors (RunManager re-emits them)
runManager.on("item:started", (data: { runId: string; item: WorkItem }) => {
  emitEvent(data.runId, "item_started", {
    itemId: data.item.id,
    type: data.item.type,
    queue: data.item.queue,
    itemKey: data.item.itemKey,
  });
});

runManager.on("item:completed", (data: { runId: string; item: WorkItem }) => {
  emitEvent(data.runId, "item_completed", {
    itemId: data.item.id,
    type: data.item.type,
    queue: data.item.queue,
    itemKey: data.item.itemKey,
    outputs: data.item.outputs,
  });

  // Propagate run name when name_run completes
  if (data.item.type === 'name_run' && data.item.outputs?.name) {
    runManager.setRunName(data.runId, data.item.outputs.name as string);
  }
});

runManager.on("item:failed", (data: { runId: string; item: WorkItem; error: string }) => {
  emitEvent(data.runId, "item_failed", {
    itemId: data.item.id,
    type: data.item.type,
    queue: data.item.queue,
    itemKey: data.item.itemKey,
    error: data.error,
  });
});

runManager.on("pipeline:pause", (data: { runId: string; item: WorkItem; error: string }) => {
  emitEvent(data.runId, "pipeline_paused", {
    itemId: data.item.id,
    type: data.item.type,
    queue: data.item.queue,
    itemKey: data.item.itemKey,
    error: data.error,
    retryCount: data.item.retryCount,
  });
});

// ---------------------------------------------------------------------------
// Static file serving for queue web UI
// ---------------------------------------------------------------------------

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function serveStaticFile(res: ServerResponse, filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return false;
  } catch { return false; }

  const ext = extname(filePath).toLowerCase();
  const contentType = STATIC_MIME[ext] ?? "application/octet-stream";
  res.statusCode = 200;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store");
  res.end(readFileSync(filePath));
  return true;
}

// ---------------------------------------------------------------------------
// SSE stream handler
// ---------------------------------------------------------------------------

function handleSseStream(req: IncomingMessage, res: ServerResponse, runId: string, url: URL): void {
  const run = runManager.getRun(runId);
  if (!run) {
    sendJson(res, 404, { error: `Run not found: ${runId}` });
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.write("retry: 2000\n\n");

  const clients = sseClientsByRunId.get(runId) ?? new Set<ServerResponse>();
  clients.add(res);
  sseClientsByRunId.set(runId, clients);

  // Replay history
  const lastEventIdRaw = req.headers["last-event-id"]
    ?? url.searchParams.get("lastEventId")
    ?? undefined;
  const lastEventId = lastEventIdRaw ? Number(lastEventIdRaw) : undefined;
  const history = eventsByRunId.get(runId) ?? [];
  for (const event of history) {
    if (lastEventId === undefined || event.id > lastEventId) {
      writeSseEvent(res, event);
    }
  }

  res.write(
    `event: connected\ndata: ${JSON.stringify({ runId, timestamp: new Date().toISOString() })}\n\n`,
  );

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    }
  }, SSE_HEARTBEAT_MS);

  const cleanup = (): void => {
    clearInterval(heartbeat);
    const existing = sseClientsByRunId.get(runId);
    if (existing) {
      existing.delete(res);
      if (existing.size === 0) sseClientsByRunId.delete(runId);
    }
  };

  req.on("close", cleanup);
  req.on("error", cleanup);
}

// ---------------------------------------------------------------------------
// Media file serving (same pattern as existing server)
// ---------------------------------------------------------------------------

function handleMediaRequest(res: ServerResponse, req: IncomingMessage, outputDir: string, pathSegments: string[]): void {
  const mediaPath = resolveMediaPathForRun(outputDir, pathSegments);
  if (!mediaPath) {
    sendJson(res, 400, { error: "Invalid media path" });
    return;
  }
  if (!existsSync(mediaPath)) {
    sendJson(res, 404, { error: "Media file not found" });
    return;
  }

  let stats;
  try {
    stats = statSync(mediaPath);
    if (!stats.isFile()) {
      sendJson(res, 404, { error: "Media file not found" });
      return;
    }
  } catch {
    sendJson(res, 404, { error: "Media file not found" });
    return;
  }

  const fileSize = stats.size;
  const rangeHeader = req.headers.range;

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", detectMimeType(mediaPath));
  res.setHeader("Cache-Control", "no-store");

  if (!rangeHeader) {
    res.statusCode = 200;
    res.setHeader("Content-Length", fileSize);
    createReadStream(mediaPath).pipe(res);
    return;
  }

  const rangeMatch = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!rangeMatch || (rangeMatch[1] === "" && rangeMatch[2] === "")) {
    res.statusCode = 416;
    res.setHeader("Content-Range", `bytes */${fileSize}`);
    res.end();
    return;
  }

  let start: number;
  let end: number;
  if (rangeMatch[1] === "" && rangeMatch[2] !== "") {
    const suffixLength = parseInt(rangeMatch[2], 10);
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  } else {
    start = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : 0;
    end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : fileSize - 1;
  }

  if (start >= fileSize || start > end) {
    res.statusCode = 416;
    res.setHeader("Content-Range", `bytes */${fileSize}`);
    res.end();
    return;
  }
  if (end >= fileSize) end = fileSize - 1;

  res.statusCode = 206;
  res.setHeader("Content-Length", end - start + 1);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
  createReadStream(mediaPath, { start, end }).pipe(res);
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

async function requestHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathParts = url.pathname.split("/").filter(Boolean);

  try {
    // Health check
    if (method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Static file serving for queue web UI
    if (method === "GET" && !url.pathname.startsWith("/api/")) {
      let filePath: string;
      if (url.pathname === "/" || url.pathname === "/index.html") {
        filePath = join(WEB_ROOT, "index.html");
      } else {
        filePath = join(WEB_ROOT, url.pathname);
      }
      // Prevent path traversal
      const resolved = resolve(filePath);
      if (resolved.startsWith(resolve(WEB_ROOT)) && serveStaticFile(res, resolved)) {
        return;
      }
    }

    // POST /api/runs — Create a new run
    if (method === "POST" && url.pathname === "/api/runs") {
      const body = await readJsonBody(req) as Record<string, unknown>;
      const storyText = body.storyText;
      if (typeof storyText !== "string" || storyText.trim().length === 0) {
        sendJson(res, 400, { error: "storyText is required and must be a non-empty string" });
        return;
      }
      const options = (body.options ?? {}) as Record<string, unknown>;
      const record = runManager.createRun(storyText, {
        needsConversion: Boolean(options.needsConversion),
        aspectRatio: typeof options.aspectRatio === "string" ? options.aspectRatio : undefined,
        dryRun: Boolean(options.dryRun),
      });
      sendJson(res, 201, record);
      return;
    }

    // GET /api/runs — List all runs
    if (method === "GET" && url.pathname === "/api/runs") {
      sendJson(res, 200, { runs: runManager.listRuns() });
      return;
    }

    // Routes with runId: /api/runs/:id/...
    if (pathParts.length >= 3 && pathParts[0] === "api" && pathParts[1] === "runs") {
      const runId = decodeURIComponent(pathParts[2]);

      // GET /api/runs/:id
      if (method === "GET" && pathParts.length === 3) {
        const run = runManager.getRun(runId);
        if (!run) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }
        const qm = runManager.getQueueManager(runId);
        sendJson(res, 200, { ...run, state: qm?.getState() ?? null });
        return;
      }

      const action = pathParts[3];

      // GET /api/runs/:id/queues
      if (method === "GET" && action === "queues") {
        const qm = runManager.getQueueManager(runId);
        if (!qm) { sendJson(res, 404, { error: `Run not found or no queue state: ${runId}` }); return; }
        const queues: QueueName[] = ["llm", "image", "video"];
        const snapshots = queues.map(q => qm.getQueueSnapshot(q));
        sendJson(res, 200, { runId, queues: snapshots });
        return;
      }

      // GET /api/runs/:id/graph
      if (method === "GET" && action === "graph") {
        const qm = runManager.getQueueManager(runId);
        if (!qm) { sendJson(res, 404, { error: `Run not found or no queue state: ${runId}` }); return; }
        sendJson(res, 200, { runId, graph: qm.getDependencyGraph() });
        return;
      }

      // GET /api/runs/:id/events — SSE stream
      if (method === "GET" && action === "events") {
        handleSseStream(req, res, runId, url);
        return;
      }

      // GET /api/runs/:id/media/** — Serve generated files
      if (method === "GET" && action === "media" && pathParts.length >= 5) {
        const run = runManager.getRun(runId);
        if (!run) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }
        handleMediaRequest(res, req, run.outputDir, pathParts.slice(4));
        return;
      }

      // POST /api/runs/:id/items/:itemId/redo
      if (method === "POST" && action === "items" && pathParts.length >= 6 && pathParts[5] === "redo") {
        const itemId = decodeURIComponent(pathParts[4]);
        console.log(`[queue-server] Redo request: runId=${runId}, itemId=${itemId}`);
        const body = await readJsonBody(req) as Record<string, unknown>;
        const newInputs = body.inputs as Record<string, unknown> | undefined;
        const durationOverride = body.durationOverride as number | undefined;

        // If a durationOverride is provided, update the shot duration in storyAnalysis and mark as manual
        if (durationOverride !== undefined) {
          const qm = runManager.getQueueManager(runId);
          if (qm) {
            const state = qm.getState();
            const oldItem = state.workItems.find(i => i.id === itemId);
            if (oldItem && oldItem.type === 'generate_video') {
              const shot = (newInputs?.shot ?? oldItem.inputs.shot) as Record<string, unknown> | undefined;
              const shotNumber = shot?.shotNumber as number | undefined;
              if (shotNumber !== undefined) {
                // Update shot duration in storyAnalysis
                const shotObj = state.storyAnalysis?.scenes.flatMap(s => s.shots).find(s => s.shotNumber === shotNumber);
                if (shotObj) shotObj.durationSeconds = durationOverride;

                // Mark as manual duration (skip pacing analysis)
                if (!state.manualDurations) state.manualDurations = {};
                state.manualDurations[shotNumber] = true;

                // Update the shot in inputs with the new duration
                if (!newInputs) {
                  const updatedShot = { ...oldItem.inputs.shot as Record<string, unknown>, durationSeconds: durationOverride };
                  const updatedInputs = { ...oldItem.inputs, shot: updatedShot };
                  const newItem = runManager.redoItem(runId, itemId, updatedInputs);
                  if (!newItem) { sendJson(res, 404, { error: `Item not found: ${itemId}` }); return; }
                  qm.save();
                  // Auto-resume processors if run is stopped/completed
                  await runManager.resumeRun(runId);
                  emitEvent(runId, "item_redo", { oldItemId: itemId, newItem });
                  sendJson(res, 200, { newItem });
                  return;
                } else if (newInputs.shot) {
                  (newInputs.shot as Record<string, unknown>).durationSeconds = durationOverride;
                }
              }
            }
          }
        }

        const newItem = runManager.redoItem(runId, itemId, newInputs);
        if (!newItem) { sendJson(res, 404, { error: `Item not found: ${itemId}` }); return; }
        // Auto-resume processors if run is stopped/completed
        await runManager.resumeRun(runId);
        emitEvent(runId, "item_redo", { oldItemId: itemId, newItem });
        sendJson(res, 200, { newItem });
        return;
      }

      // POST /api/runs/:id/items/:itemId/retry — manual retry (no limit)
      if (method === "POST" && action === "items" && pathParts.length >= 6 && pathParts[5] === "retry") {
        const itemId = decodeURIComponent(pathParts[4]);
        const qm = runManager.getQueueManager(runId);
        if (!qm) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }
        try {
          const item = qm.retryItem(itemId);
          qm.save();
          emitEvent(runId, "item_retried", { itemId: item.id, type: item.type, queue: item.queue, itemKey: item.itemKey, retryCount: item.retryCount });
          sendJson(res, 200, { item });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          sendJson(res, 409, { error: msg });
        }
        return;
      }

      // POST /api/runs/:id/items/:itemId/edit
      if (method === "POST" && action === "items" && pathParts.length >= 6 && pathParts[5] === "edit") {
        const itemId = decodeURIComponent(pathParts[4]);
        const qm = runManager.getQueueManager(runId);
        if (!qm) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }
        const item = qm.getItem(itemId);
        if (!item) { sendJson(res, 404, { error: `Item not found: ${itemId}` }); return; }
        if (item.status !== "pending") {
          sendJson(res, 409, { error: "Can only edit pending items" });
          return;
        }
        const body = await readJsonBody(req) as Record<string, unknown>;
        if (body.inputs && typeof body.inputs === "object") {
          Object.assign(item.inputs, body.inputs);
          qm.save();
        }
        sendJson(res, 200, { item });
        return;
      }

      // POST /api/runs/:id/items/:itemId/cancel
      if (method === "POST" && action === "items" && pathParts.length >= 6 && pathParts[5] === "cancel") {
        const itemId = decodeURIComponent(pathParts[4]);
        const qm = runManager.getQueueManager(runId);
        if (!qm) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }
        runManager.cancelItem(runId, itemId);
        emitEvent(runId, "item_cancelled", { itemId });
        sendJson(res, 200, { cancelled: itemId });
        return;
      }

      // PATCH /api/runs/:id/items/:itemId/priority
      if (method === "PATCH" && action === "items" && pathParts.length >= 6 && pathParts[5] === "priority") {
        const itemId = decodeURIComponent(pathParts[4]);
        const qm = runManager.getQueueManager(runId);
        if (!qm) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }
        const item = qm.getItem(itemId);
        if (!item) { sendJson(res, 404, { error: `Item not found: ${itemId}` }); return; }
        const body = await readJsonBody(req) as Record<string, unknown>;
        const priority = body.priority;
        if (priority !== "normal" && priority !== "high") {
          sendJson(res, 400, { error: 'priority must be "normal" or "high"' });
          return;
        }
        item.priority = priority;
        qm.save();
        sendJson(res, 200, { item });
        return;
      }

      // POST /api/runs/:id/stop
      if (method === "POST" && action === "stop") {
        const stopped = await runManager.stopRun(runId);
        if (!stopped) { sendJson(res, 404, { error: `Run not found or not running: ${runId}` }); return; }
        // Status SSE events are emitted by RunManager via run:updated
        sendJson(res, 200, { message: "Run stopping" });
        return;
      }

      // POST /api/runs/:id/resume
      if (method === "POST" && action === "resume") {
        const resumed = await runManager.resumeRun(runId);
        if (!resumed) { sendJson(res, 409, { error: `Cannot resume run: ${runId}` }); return; }
        // Status SSE events are emitted by RunManager via run:updated
        sendJson(res, 200, { message: "Run resumed" });
        return;
      }

      // DELETE /api/runs/:id
      if (method === "DELETE" && pathParts.length === 3) {
        const deleted = await runManager.deleteRun(runId);
        if (!deleted) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }
        sendJson(res, 200, { deleted: runId });
        return;
      }
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    sendJson(res, 400, { error: message });
  }
}


// ---------------------------------------------------------------------------
// Server startup + graceful shutdown
// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
  void requestHandler(req, res);
});

let shutdownInProgress = false;

function initiateShutdown(reason: string, exitCode: number): void {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  console.log(`[queue-server] Shutting down: ${reason}`);

  const exitTimer = setTimeout(() => process.exit(exitCode), SHUTDOWN_TIMEOUT_MS);
  exitTimer.unref();

  server.close(() => {
    process.exit(exitCode);
  });
}

process.on("SIGINT", () => initiateShutdown("SIGINT", 130));
process.on("SIGTERM", () => initiateShutdown("SIGTERM", 143));
process.on("uncaughtException", (err) => {
  console.error("[queue-server] Uncaught exception:", err);
  initiateShutdown("uncaught_exception", 1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[queue-server] Unhandled rejection:", reason);
  initiateShutdown("unhandled_rejection", 1);
});

server.listen(PORT, () => {
  console.log(`Queue server listening on http://localhost:${PORT}`);
});