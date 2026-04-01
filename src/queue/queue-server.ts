import "dotenv/config";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { join, resolve, extname } from "path";
import { randomUUID } from "crypto";
import sharp from "sharp";

import { RunManager, resolveOutputDir } from "./run-manager.js";
import { getSettings, loadSettings, setLlmProvider, updateSettings } from "./settings.js";
import { setLlmProvider as setLlmProviderImpl } from "../llm-provider.js";
import { isElevenLabsAvailable, generateMusicFromVideo, mixMusicIntoVideo } from "../elevenlabs-client.js";
import { getQueueConcurrency } from "./processors.js";
import type { QueueName, WorkItem } from "./types.js";
import type { ImageBackend, VideoBackend } from "../types.js";

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

const IMAGE_BACKENDS: readonly ImageBackend[] = ["grok", "reve", "nano-banana"];
const VIDEO_BACKENDS: readonly VideoBackend[] = ["grok", "veo", "ltx-full", "ltx-distilled"];
const LLM_PROVIDERS = ["anthropic", "openai"] as const;

function parseImageBackend(value: unknown): ImageBackend | undefined {
  return typeof value === "string" && IMAGE_BACKENDS.includes(value as ImageBackend)
    ? (value as ImageBackend)
    : undefined;
}

function parseVideoBackend(value: unknown): VideoBackend | undefined {
  return typeof value === "string" && VIDEO_BACKENDS.includes(value as VideoBackend)
    ? (value as VideoBackend)
    : undefined;
}

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
const WEB_ROOT = resolve(process.cwd(), "web-ui", "dist");
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
    reason: `Pipeline stopped: ${data.item.itemKey} failed after max retries`,
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

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20MB

async function readRawBody(req: IncomingMessage, maxBytes = MAX_UPLOAD_BYTES): Promise<Buffer> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > maxBytes) throw new Error("Upload exceeds 20MB limit");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * Pad an image buffer to match a target aspect ratio by adding black letterbox/pillarbox bars.
 */
async function padImageToAspectRatio(imageBuffer: Buffer, targetAspectRatio: string): Promise<Buffer> {
  const metadata = await sharp(imageBuffer).metadata();
  const srcWidth = metadata.width!;
  const srcHeight = metadata.height!;

  const [arW, arH] = targetAspectRatio.split(":").map(Number);
  const targetRatio = arW / arH;
  const srcRatio = srcWidth / srcHeight;

  // If already correct ratio (within tolerance), return original
  if (Math.abs(srcRatio - targetRatio) < 0.05) {
    return imageBuffer;
  }

  let newWidth: number, newHeight: number;
  if (srcRatio > targetRatio) {
    // Image is wider than target — add height (letterbox)
    newWidth = srcWidth;
    newHeight = Math.round(srcWidth / targetRatio);
  } else {
    // Image is taller than target — add width (pillarbox)
    newHeight = srcHeight;
    newWidth = Math.round(srcHeight * targetRatio);
  }

  return sharp(imageBuffer)
    .resize(newWidth, newHeight, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    })
    .png()
    .toBuffer();
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

runManager.on("item:progress", (data: { runId: string; itemId: string; itemKey: string; progress: { status: string; progress?: number; step?: number; totalSteps?: number; queuePosition?: number } }) => {
  emitEvent(data.runId, "item_progress", {
    itemId: data.itemId,
    itemKey: data.itemKey,
    progress: data.progress,
  });
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
    if (req.method === "HEAD") { res.end(); return; }
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

    // Static file serving for queue web UI (Vite/React SPA)
    if (method === "GET" && !url.pathname.startsWith("/api/")) {
      // In dev mode, delegate to Vite's middleware for HMR + SPA fallback
      if (viteDevServer) {
        await new Promise<void>((resolvePromise) => {
          viteDevServer!.middlewares.handle(req, res, () => {
            // Vite called next() — it didn't handle the request.
            // Fall through to the 404 at the bottom.
            resolvePromise();
          });
        });
        if (res.writableEnded) return;
      } else {
        // Production: serve built static files
        if (url.pathname !== "/") {
          const filePath = join(WEB_ROOT, url.pathname);
          const resolved = resolve(filePath);
          if (resolved.startsWith(resolve(WEB_ROOT)) && serveStaticFile(res, resolved)) {
            return;
          }
        }
        // SPA fallback: serve index.html for all unmatched routes
        const indexPath = join(WEB_ROOT, "index.html");
        if (serveStaticFile(res, indexPath)) {
          return;
        }
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
        imageBackend: parseImageBackend(options.imageBackend),
        assetImageBackend: parseImageBackend(options.assetImageBackend),
        videoBackend: parseVideoBackend(options.videoBackend),
        llmProvider: typeof options.llmProvider === 'string' && (LLM_PROVIDERS as readonly string[]).includes(options.llmProvider) ? options.llmProvider as 'anthropic' | 'openai' : undefined,
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

      // GET|HEAD /api/runs/:id/media/** — Serve generated files
      if ((method === "GET" || method === "HEAD") && action === "media" && pathParts.length >= 5) {
        const run = runManager.getRun(runId);
        if (!run) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }
        handleMediaRequest(res, req, resolveOutputDir(run.outputDir), pathParts.slice(4));
        return;
      }

      // POST /api/runs/:id/upload — Upload an image for a run
      if (method === "POST" && action === "upload") {
        const run = runManager.getRun(runId);
        if (!run) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }

        const imageData = await readRawBody(req);
        if (imageData.length === 0) {
          sendJson(res, 400, { error: "Empty request body" });
          return;
        }

        // Determine file extension from Content-Type
        const contentType = req.headers["content-type"] ?? "image/png";
        const extMap: Record<string, string> = {
          "image/png": ".png",
          "image/jpeg": ".jpg",
          "image/webp": ".webp",
        };
        const ext = extMap[contentType] ?? ".png";

        // Save to uploads/ subfolder with UUID filename
        const outputDir = resolveOutputDir(run.outputDir);
        const uploadsDir = join(outputDir, "uploads");
        mkdirSync(uploadsDir, { recursive: true });
        const filename = `${randomUUID()}${ext}`;
        const filePath = join(uploadsDir, filename);

        // Pad to target aspect ratio if needed
        const targetAspectRatio = run.options.aspectRatio ?? "16:9";
        const paddedBuffer = await padImageToAspectRatio(imageData, targetAspectRatio);
        writeFileSync(filePath, paddedBuffer);

        const relativePath = `uploads/${filename}`;

        // If itemId and field are provided, update the work item and trigger redo
        const itemId = url.searchParams.get("itemId");
        const field = url.searchParams.get("field");
        if (itemId && field) {
          const qm = runManager.getQueueManager(runId);
          if (qm) {
            const item = qm.getItem(itemId);
            if (item) {
              try {
                const newItem = runManager.redoItem(runId, itemId, { ...item.inputs, [field]: relativePath });
                if (newItem) {
                  qm.save();
                  await runManager.resumeRun(runId);
                  emitEvent(runId, "item_redo", { oldItemId: itemId, newItem });
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                sendJson(res, 409, { error: msg });
                return;
              }
            }
          }
        }

        sendJson(res, 200, { path: relativePath });
        return;
      }

      // POST /api/runs/:id/assets/replace — Replace an asset image with a user-uploaded one
      if (method === "POST" && action === "assets" && pathParts.length >= 5 && pathParts[4] === "replace") {
        const run = runManager.getRun(runId);
        if (!run) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }

        const assetKey = url.searchParams.get("assetKey");
        if (!assetKey) {
          sendJson(res, 400, { error: "assetKey query parameter is required (e.g. character:Sophie:front)" });
          return;
        }

        const imageData = await readRawBody(req);
        if (imageData.length === 0) {
          sendJson(res, 400, { error: "Empty request body" });
          return;
        }

        const qm = runManager.getQueueManager(runId);
        if (!qm) { sendJson(res, 404, { error: `Run not found or not initialized: ${runId}` }); return; }

        // Parse asset type from key (character:Name:front -> character)
        const [assetType] = assetKey.split(":");
        if (!["character", "location", "object"].includes(assetType)) {
          sendJson(res, 400, { error: `Invalid asset type: ${assetType}. Must be character, location, or object.` });
          return;
        }

        // Resize the image based on asset type
        const targetAspectRatio = run.options.aspectRatio ?? "16:9";
        let resizedBuffer: Buffer;
        if (assetType === "location") {
          // Locations match the video's aspect ratio
          const [arW, arH] = targetAspectRatio.split(":").map(Number);
          const ratio = arW / arH;
          let width: number, height: number;
          if (ratio >= 1) {
            width = 1920; height = Math.round(1920 / ratio);
          } else {
            height = 1920; width = Math.round(1920 * ratio);
          }
          resizedBuffer = await sharp(imageData)
            .resize(width, height, { fit: "cover" })
            .jpeg({ quality: 85 })
            .toBuffer();
        } else {
          // Characters and objects: 1024x1024 square
          resizedBuffer = await sharp(imageData)
            .resize(1024, 1024, { fit: "cover" })
            .jpeg({ quality: 85 })
            .toBuffer();
        }

        // Save to uploads/ directory
        const outputDir = resolveOutputDir(run.outputDir);
        const uploadsDir = join(outputDir, "uploads");
        mkdirSync(uploadsDir, { recursive: true });
        const filename = `${randomUUID()}.jpg`;
        const filePath = join(uploadsDir, filename);
        writeFileSync(filePath, resizedBuffer);
        const relativePath = `uploads/${filename}`;

        // Update generatedOutputs
        qm.setGeneratedOutput(assetKey, relativePath);

        // Rebuild asset library from generatedOutputs
        const state = qm.getState();
        const analysis = state.storyAnalysis;
        if (analysis) {
          const lib: { characterImages: Record<string, { front: string; angle: string }>; locationImages: Record<string, string>; objectImages: Record<string, string> } = {
            characterImages: {},
            locationImages: {},
            objectImages: {},
          };
          const absPath = (p: string) => join(outputDir, p);
          for (const char of analysis.characters) {
            const frontPath = state.generatedOutputs[`character:${char.name}:front`];
            const anglePath = state.generatedOutputs[`character:${char.name}:angle`];
            if (frontPath) {
              lib.characterImages[char.name] = {
                front: absPath(frontPath),
                angle: absPath(anglePath ?? frontPath),
              };
            }
          }
          for (const loc of analysis.locations) {
            const path = state.generatedOutputs[`location:${loc.name}:front`];
            if (path) lib.locationImages[loc.name] = absPath(path);
          }
          for (const obj of (analysis.objects ?? [])) {
            const path = state.generatedOutputs[`object:${obj.name}:front`];
            if (path) lib.objectImages[obj.name] = absPath(path);
          }
          qm.setAssetLibrary(lib);
        }

        // Find all active generate_frame items that reference this asset
        const assetName = assetKey.split(":")[1];
        const frameItemsToRedo: string[] = [];
        for (const item of state.workItems) {
          if (item.type !== "generate_frame") continue;
          if (item.status === "superseded" || item.status === "cancelled") continue;
          const shot = item.inputs.shot as { charactersPresent?: string[]; objectsPresent?: string[]; location?: string } | undefined;
          if (!shot) continue;

          let references = false;
          if (assetType === "character" && shot.charactersPresent?.includes(assetName)) references = true;
          if (assetType === "object" && shot.objectsPresent?.includes(assetName)) references = true;
          if (assetType === "location" && shot.location === assetName) references = true;

          if (references) frameItemsToRedo.push(item.id);
        }

        // Redo each frame item (cascade will handle downstream video items)
        const redoneItems: Array<{ oldItemId: string; newItemId: string }> = [];
        for (const frameItemId of frameItemsToRedo) {
          try {
            const newItem = runManager.redoItem(runId, frameItemId);
            if (newItem) {
              redoneItems.push({ oldItemId: frameItemId, newItemId: newItem.id });
              emitEvent(runId, "item_redo", { oldItemId: frameItemId, newItem });
            }
          } catch {
            // Item may already be superseded by a previous redo in this batch
          }
        }

        qm.save();
        await runManager.resumeRun(runId);

        sendJson(res, 200, {
          assetKey,
          path: relativePath,
          framesRequeued: redoneItems.length,
          redoneItems,
        });
        return;
      }

      // POST /api/runs/:id/assets/:assetKey/redo — Redo a generate_asset item with optional description override
      if (method === "POST" && action === "assets" && pathParts.length >= 6 && pathParts[5] === "redo") {
        const assetKey = decodeURIComponent(pathParts[4]);
        const qm = runManager.getQueueManager(runId);
        if (!qm) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }

        const body = await readJsonBody(req) as Record<string, unknown>;
        const newDescription = body.description as string | undefined;
        const directorsNote = body.directorsNote as string | undefined;

        // Asset queue keys have an "asset:" prefix, e.g. "asset:character:Sir Edric Valdane:front"
        const lookupKey = assetKey.startsWith("asset:") ? assetKey : `asset:${assetKey}`;
        const items = qm.getItemsByKey(lookupKey);
        const activeItem = items.filter(i => i.status !== "superseded" && i.status !== "cancelled").pop();

        if (!activeItem) {
          sendJson(res, 404, { error: `No active generate_asset item found for key: ${lookupKey}` });
          return;
        }

        let newInputs: Record<string, unknown> | undefined;
        if (newDescription !== undefined || directorsNote) {
          newInputs = { ...activeItem.inputs };
          if (newDescription !== undefined) newInputs.description = newDescription;
          if (directorsNote) newInputs.directorsNote = directorsNote;
        }

        // Persist the updated description into storyAnalysis so the UI reflects it
        if (newDescription !== undefined && qm.getState().storyAnalysis) {
          const parts = assetKey.split(':');
          const type = parts[0]; // character, location, object
          const name = parts.slice(1, -1).join(':'); // handle names with colons

          if (type === 'character') {
            qm.updateCharacter(name, { physicalDescription: newDescription });
          } else if (type === 'location') {
            qm.updateLocation(name, { visualDescription: newDescription });
          } else if (type === 'object') {
            qm.updateObject(name, { visualDescription: newDescription });
          }
        }

        try {
          const newItem = runManager.redoItem(runId, activeItem.id, newInputs);
          if (!newItem) { sendJson(res, 500, { error: `Failed to redo asset: ${lookupKey}` }); return; }
          qm.save();
          await runManager.resumeRun(runId);
          emitEvent(runId, "item_redo", { oldItemId: activeItem.id, newItem });
          sendJson(res, 200, { newItem });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          sendJson(res, 409, { error: msg });
        }
        return;
      }

      // POST /api/runs/:id/items/:itemId/continuity
      if (method === "POST" && action === "items" && pathParts.length >= 6 && pathParts[5] === "continuity") {
        const itemId = decodeURIComponent(pathParts[4]);
        const body = await readJsonBody(req) as Record<string, unknown>;
        const enabled = body.enabled;
        if (typeof enabled !== "boolean") {
          sendJson(res, 400, { error: 'enabled must be a boolean' });
          return;
        }

        const qm = runManager.getQueueManager(runId);
        if (!qm) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }

        const originalItem = qm.getItem(itemId);
        if (!originalItem) { sendJson(res, 404, { error: `Item not found: ${itemId}` }); return; }

        let targetItem = originalItem;
        if (originalItem.type === 'generate_video') {
          const frameItemId = originalItem.dependencies.find(depId => {
            const dep = qm.getItem(depId);
            return dep && dep.type === 'generate_frame';
          });
          if (!frameItemId) {
            sendJson(res, 409, { error: 'Could not find upstream frame item for continuity toggle' });
            return;
          }
          const frameItem = qm.getItem(frameItemId);
          if (!frameItem) {
            sendJson(res, 404, { error: `Item not found: ${frameItemId}` });
            return;
          }
          targetItem = frameItem;
        } else if (originalItem.type !== 'generate_frame') {
          sendJson(res, 400, { error: 'Continuity can only be toggled for frame/video items' });
          return;
        }

        const shot = targetItem.inputs.shot as Record<string, unknown> | undefined;
        const sceneNumber = shot?.sceneNumber as number | undefined;
        const shotInScene = shot?.shotInScene as number | undefined;
        if (sceneNumber === undefined || shotInScene === undefined) {
          sendJson(res, 400, { error: 'Shot metadata is missing sceneNumber/shotInScene' });
          return;
        }
        if (enabled && shotInScene <= 1) {
          sendJson(res, 409, { error: 'The first shot in a scene cannot use continuity' });
          return;
        }

        const updatedShot = { ...shot, continuousFromPrevious: enabled };
        const targetInputs = { ...targetItem.inputs, shot: updatedShot };

        try {
          const newItem = runManager.redoItem(runId, targetItem.id, targetInputs);
          if (!newItem) { sendJson(res, 404, { error: `Item not found: ${targetItem.id}` }); return; }

          // When enabling continuity, ensure the new frame item depends on the previous video
          if (enabled && shotInScene > 1) {
            const prevVideoKey = `video:scene:${sceneNumber}:shot:${shotInScene - 1}`;
            qm.addDependency(newItem.id, prevVideoKey);
          }

          qm.updateShotContinuity(sceneNumber, shotInScene, enabled);
          qm.save();
          await runManager.resumeRun(runId);
          emitEvent(runId, "item_redo", { oldItemId: targetItem.id, newItem });
          sendJson(res, 200, { enabled, newItem });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          sendJson(res, 409, { error: msg });
        }
        return;
      }

      // POST /api/runs/:id/items/:itemId/redo
      if (method === "POST" && action === "items" && pathParts.length >= 6 && pathParts[5] === "redo") {
        const itemId = decodeURIComponent(pathParts[4]);
        console.log(`[queue-server] Redo request: runId=${runId}, itemId=${itemId}`);
        const body = await readJsonBody(req) as Record<string, unknown>;
        let newInputs = body.inputs ? { ...(body.inputs as Record<string, unknown>) } : undefined;
        const durationOverride = body.durationOverride as number | undefined;
        const directorsNote = body.directorsNote as string | undefined;
        if (directorsNote) {
          newInputs = { ...(newInputs ?? {}), directorsNote };
        }
        const qm = runManager.getQueueManager(runId);
        if (!qm) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }
        const originalItem = qm.getItem(itemId);
        if (!originalItem) { sendJson(res, 404, { error: `Item not found: ${itemId}` }); return; }

        // If this is a generate_video item and frame-related fields changed,
        // redo the upstream generate_frame item instead (cascade will recreate the video)
        let targetItemId = itemId;
        let targetInputs = newInputs;
        if (newInputs && originalItem.type === 'generate_video') {
          const newShot = newInputs.shot as Record<string, unknown> | undefined;
          const oldShot = originalItem.inputs.shot as Record<string, unknown> | undefined;
          const frameKeys = ['startFramePrompt', 'endFramePrompt'];
          const frameFieldChanged = newShot && oldShot && frameKeys.some(key =>
            key in newShot && newShot[key] !== oldShot[key]
          );
          if (frameFieldChanged) {
            const frameItemId = originalItem.dependencies.find(depId => {
              const dep = qm.getItem(depId);
              return dep && dep.type === 'generate_frame';
            });
            if (frameItemId) {
              const frameItem = qm.getItem(frameItemId);
              targetItemId = frameItemId;
              targetInputs = { ...frameItem?.inputs, ...newInputs };
            }
          }
        }

        // If this is a generate_video redo and the shot has continuousFromPrevious,
        // redo the upstream frame instead — it will re-extract from the previous video
        // and cascade back to create a new video
        if (originalItem.type === 'generate_video' && targetItemId === itemId) {
          const shot = (targetInputs?.shot ?? originalItem.inputs.shot) as Record<string, unknown> | undefined;
          if (shot?.continuousFromPrevious) {
            const frameItemId = originalItem.dependencies.find(depId => {
              const dep = qm.getItem(depId);
              return dep && dep.type === 'generate_frame';
            });
            if (frameItemId) {
              targetItemId = frameItemId;
              // Use the frame's own inputs so it re-extracts the continuity start frame;
              // merge any caller-provided shot changes
              const frameItem = qm.getItem(frameItemId);
              if (newInputs && frameItem) {
                targetInputs = { ...frameItem.inputs, ...newInputs };
              } else {
                targetInputs = undefined;
              }
            }
          }
        }

        // Persist shot field changes (e.g. durationSeconds) to the shot plan data
        // so that when items are re-seeded from storyAnalysis, the new values survive
        if (newInputs && (originalItem.type === 'generate_video' || originalItem.type === 'generate_frame')) {
          const newShot = newInputs.shot as Record<string, unknown> | undefined;
          const oldShot = originalItem.inputs.shot as Record<string, unknown> | undefined;
          if (newShot && oldShot) {
            const sceneNumber = (newShot.sceneNumber ?? oldShot.sceneNumber) as number;
            const shotInScene = (newShot.shotInScene ?? oldShot.shotInScene) as number;
            if (typeof sceneNumber === 'number' && typeof shotInScene === 'number') {
              const updateFields: Record<string, unknown> = {};
              for (const key of ['durationSeconds', 'videoPrompt', 'dialogue', 'speaker', 'soundEffects', 'cameraDirection', 'startFramePrompt', 'endFramePrompt']) {
                if (key in newShot && newShot[key] !== oldShot[key]) {
                  updateFields[key] = newShot[key];
                }
              }
              if (Object.keys(updateFields).length > 0) {
                qm.updateShotFields(sceneNumber, shotInScene, updateFields);
              }
            }
          }
        }

        const targetItem = qm.getItem(targetItemId);
        if (!targetItem) { sendJson(res, 404, { error: `Item not found: ${targetItemId}` }); return; }
        if (targetItem.status === 'in_progress') {
          sendJson(res, 409, { error: `Cannot redo item ${targetItemId}: status is 'in_progress'` });
          return;
        }

        // If a durationOverride is provided, update the shot duration in storyAnalysis and mark as manual
        if (durationOverride !== undefined && originalItem.type === 'generate_video') {
          const shot = (targetInputs?.shot ?? originalItem.inputs.shot) as Record<string, unknown> | undefined;
          if (shot) {
            const sceneNumber = shot?.sceneNumber as number | undefined;
            const shotInScene = shot?.shotInScene as number | undefined;
            if (sceneNumber !== undefined && shotInScene !== undefined) {
              qm.updateShotDuration(sceneNumber, shotInScene, durationOverride);
              qm.setManualDuration(`scene:${sceneNumber}:shot:${shotInScene}`, true);
            }

            const baseShot = (targetInputs?.shot ?? originalItem.inputs.shot) as Record<string, unknown> | undefined;
            const updatedShot = baseShot ? { ...baseShot, durationSeconds: durationOverride } : { durationSeconds: durationOverride };
            targetInputs = { ...(targetInputs ?? originalItem.inputs), shot: updatedShot };
          }
        }
        try {
          const newItem = runManager.redoItem(runId, targetItemId, targetInputs);
          if (!newItem) { sendJson(res, 404, { error: `Item not found: ${targetItemId}` }); return; }
          // Auto-resume processors if run is stopped/completed
          await runManager.resumeRun(runId);
          emitEvent(runId, "item_redo", { oldItemId: targetItemId, newItem });
          sendJson(res, 200, { newItem });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          sendJson(res, 409, { error: msg });
        }
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
          await runManager.resumeRun(runId);
          emitEvent(runId, "item_retried", { itemId: item.id, type: item.type, queue: item.queue, itemKey: item.itemKey, retryCount: item.retryCount });
          sendJson(res, 200, { item });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          sendJson(res, 409, { error: msg });
        }
        return;
      }

      // POST /api/runs/:id/reseed-assemble
      if (method === "POST" && action === "reseed-assemble" && pathParts.length === 4) {
        const qm = runManager.getQueueManager(runId);
        if (!qm) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }

        const state = qm.getState();
        const analysis = state.storyAnalysis;
        if (!analysis) { sendJson(res, 409, { error: 'No story analysis available yet' }); return; }

        const allShots = analysis.scenes.flatMap(s => s.shots || []).filter(s => !s.skipped);
        const allVideosDone = allShots.every(shot => {
          const items = qm.getItemsByKey(`video:scene:${shot.sceneNumber}:shot:${shot.shotInScene}`);
          return items.some(i => i.status === 'completed' && !i.supersededBy);
        });

        if (!allVideosDone) {
          sendJson(res, 409, { error: 'Cannot reseed assemble until all videos are completed' });
          return;
        }

        const existingAssemble = qm.getItemsByKey('assemble')
          .filter(i => i.status !== 'superseded' && i.status !== 'cancelled');
        const videoKeys = allShots.map(shot => `video:scene:${shot.sceneNumber}:shot:${shot.shotInScene}`);

        const newItem = qm.addItem({
          type: 'assemble',
          queue: 'llm',
          itemKey: 'assemble',
          dependencies: videoKeys,
        });

        for (const existing of existingAssemble) {
          qm.supersedeItem(existing.id, newItem.id);
        }

        qm.save();
        await runManager.resumeRun(runId);
        emitEvent(runId, 'item_redo', {
          oldItemIds: existingAssemble.map(item => item.id),
          newItem,
        });
        sendJson(res, 200, { item: newItem });
        return;
      }

      // POST /api/runs/:id/items/:itemId/edit
      if (method === "POST" && action === "items" && pathParts.length >= 6 && pathParts[5] === "edit") {
        const itemId = decodeURIComponent(pathParts[4]);
        const qm = runManager.getQueueManager(runId);
        if (!qm) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }
        const item = qm.getItem(itemId);
        if (!item) { sendJson(res, 404, { error: `Item not found: ${itemId}` }); return; }
        const body = await readJsonBody(req) as Record<string, unknown>;
        if (body.inputs && typeof body.inputs === "object") {
          try {
            const updated = qm.updateItemInputs(itemId, body.inputs as Record<string, unknown>);
            qm.save();
            sendJson(res, 200, { item: updated });
            return;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            sendJson(res, 409, { error: msg });
            return;
          }
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
        try {
          const updated = qm.setItemPriority(itemId, priority);
          qm.save();
          sendJson(res, 200, { item: updated });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          sendJson(res, 409, { error: msg });
        }
        return;
      }

      // GET /api/runs/:id/analyze — list analyze_video items (pending, in_progress, and completed awaiting review)
      if (method === "GET" && action === "analyze" && pathParts.length === 4) {
        const qm = runManager.getQueueManager(runId);
        if (!qm) { sendJson(res, 404, { error: `Run not found or no queue state: ${runId}` }); return; }
        const state = qm.getState();
        const analyzeItems = state.workItems.filter(item =>
          item.type === 'analyze_video' &&
          item.status !== 'superseded' &&
          item.status !== 'cancelled' &&
          item.status !== 'failed' &&
          item.reviewStatus !== 'accepted' &&
          item.reviewStatus !== 'rejected'
        );
        sendJson(res, 200, { runId, items: analyzeItems });
        return;
      }

      // POST /api/runs/:id/analyze/enqueue-all — create analyze_video items for all unreviewed clips
      if (method === "POST" && action === "analyze" && pathParts.length === 5 && pathParts[4] === "enqueue-all") {
        const qm = runManager.getQueueManager(runId);
        if (!qm) { sendJson(res, 404, { error: `Run not found or no queue state: ${runId}` }); return; }
        const state = qm.getState();
        const analysis = state.storyAnalysis;
        if (!analysis) { sendJson(res, 409, { error: "No story analysis available yet" }); return; }

        const createdItems: WorkItem[] = [];
        const allShots = analysis.scenes.flatMap(s => s.shots || []).filter(s => !s.skipped);

        for (const shot of allShots) {
          // Find the latest completed, non-superseded generate_video item for this shot
          const videoItems = qm.getItemsByKey(`video:scene:${shot.sceneNumber}:shot:${shot.shotInScene}`);
          const completedVideo = videoItems.find(i => i.status === 'completed' && !i.supersededBy);
          if (!completedVideo) continue;

          // Check if an active analyze_video already exists that depends on this video
          const existingAnalyze = qm.getItemsByKey(`analyze_video:scene:${shot.sceneNumber}:shot:${shot.shotInScene}`);
          if (existingAnalyze.some(i => i.status !== 'superseded' && i.status !== 'cancelled' && i.dependencies.includes(completedVideo.id))) continue;

          // Build reference image paths from generated outputs
          const referenceImagePaths: string[] = [];
          for (const [key, value] of Object.entries(state.generatedOutputs)) {
            if (key.startsWith('character:') || key.startsWith('location:') || key.startsWith('object:')) {
              const name = key.split(':')[1];
              if (
                shot.charactersPresent.includes(name) ||
                shot.objectsPresent?.includes(name) ||
                shot.location === name
              ) {
                referenceImagePaths.push(value);
              }
            }
          }

          const newItem = qm.addItem({
            type: 'analyze_video',
            queue: 'llm',
            itemKey: `analyze_video:scene:${shot.sceneNumber}:shot:${shot.shotInScene}`,
            dependencies: [completedVideo.id],
            inputs: {
              shotNumber: shot.shotNumber,
              videoPath: completedVideo.outputs.path as string,
              startFramePath: completedVideo.inputs.startFramePath as string,
              referenceImagePaths,
              shot,
            },
          });
          createdItems.push(newItem);
        }

        if (createdItems.length > 0) {
          qm.save();
          await runManager.resumeRun(runId);
          for (const item of createdItems) {
            emitEvent(runId, "item_started", { itemId: item.id, type: item.type, queue: item.queue, itemKey: item.itemKey });
          }
        }

        sendJson(res, 200, { runId, created: createdItems.length, items: createdItems });
        return;
      }

      // POST /api/runs/:id/analyze/delete-all — remove all analyze_video work items entirely
      if (method === "POST" && action === "analyze" && pathParts.length === 5 && pathParts[4] === "delete-all") {
        const qm = runManager.getQueueManager(runId);
        if (!qm) { sendJson(res, 404, { error: `Run not found or no queue state: ${runId}` }); return; }
        try {
          const deleted = qm.deleteAnalyzeItems();
          qm.save();
          sendJson(res, 200, { deleted });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          sendJson(res, 409, { error: msg });
        }
        return;
      }


      // POST /api/runs/:id/analyze/:itemId/accept — accept recommendation
      if (method === "POST" && action === "analyze" && pathParts.length >= 6 && pathParts[5] === "accept") {
        const itemId = decodeURIComponent(pathParts[4]);
        const qm = runManager.getQueueManager(runId);
        if (!qm) { sendJson(res, 404, { error: `Run not found or no queue state: ${runId}` }); return; }
        const item = qm.getItem(itemId);
        if (!item || item.type !== 'analyze_video') {
          sendJson(res, 404, { error: `Analyze item not found: ${itemId}` });
          return;
        }
        if (item.status !== 'completed') {
          sendJson(res, 409, { error: `Item is not completed: ${item.status}` });
          return;
        }

        const body = await readJsonBody(req) as Record<string, unknown>;
        const editedInputs = body.inputs as Record<string, unknown> | undefined;

        // Find the upstream generate_video item this analysis depends on
        const videoItemId = item.dependencies.find(depId => {
          const dep = qm.getItem(depId);
          return dep && dep.type === 'generate_video';
        });

        if (!videoItemId) {
          sendJson(res, 500, { error: "Could not find upstream generate_video item" });
          return;
        }

        // Merge suggested inputs from recommendations
        const recommendations = (item.outputs.recommendations ?? []) as Array<{ type: string; suggestedInputs?: Record<string, unknown> }>;
        let suggestedInputs: Record<string, unknown> = {};
        for (const rec of recommendations) {
          if (rec.suggestedInputs) {
            suggestedInputs = { ...suggestedInputs, ...rec.suggestedInputs };
          }
        }

        // If the user provided edited inputs, those override suggestions
        if (editedInputs) {
          suggestedInputs = { ...suggestedInputs, ...editedInputs };
        }

        // Determine what to redo based on what inputs actually changed
        const frameKeys = ['startFramePrompt', 'endFramePrompt'];
        const redoFrame = frameKeys.some(key => key in suggestedInputs);

        try {
          qm.setReviewStatus(itemId, 'accepted');

          // Redo the appropriate upstream item
          let targetItemId = videoItemId;
          if (redoFrame) {
            const videoItem = qm.getItem(videoItemId);
            const frameItemId = videoItem?.dependencies.find(depId => {
              const dep = qm.getItem(depId);
              return dep && dep.type === 'generate_frame';
            });
            if (frameItemId) {
              targetItemId = frameItemId;
            }
          }

          const targetItem = qm.getItem(targetItemId);
          let mergedInputs: Record<string, unknown> | undefined = undefined;
          if (Object.keys(suggestedInputs).length > 0) {
            const shotFields = ['videoPrompt', 'startFramePrompt', 'dialogue', 'durationSeconds', 'cameraDirection'];
            const shotOverrides: Record<string, unknown> = {};
            const topLevelOverrides: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(suggestedInputs)) {
              if (shotFields.includes(key)) {
                shotOverrides[key] = value;
              } else {
                topLevelOverrides[key] = value;
              }
            }

            const existingShot = (targetItem?.inputs as Record<string, unknown> | undefined)?.shot as Record<string, unknown> | undefined;
            mergedInputs = {
              ...targetItem?.inputs,
              ...topLevelOverrides,
            };
            if (existingShot) {
              mergedInputs.shot = { ...existingShot, ...shotOverrides };
            }
          }

          const newItem = runManager.redoItem(runId, targetItemId, mergedInputs);
          if (!newItem) {
            sendJson(res, 500, { error: `Failed to redo item: ${targetItemId}` });
            return;
          }

          qm.save();
          await runManager.resumeRun(runId);
          emitEvent(runId, "analyze_accepted", { analyzeItemId: itemId, redoItemId: targetItemId, newItem });
          sendJson(res, 200, { accepted: itemId, newItem });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          sendJson(res, 409, { error: msg });
        }
        return;
      }

      // POST /api/runs/:id/analyze/:itemId/reject — reject recommendation
      if (method === "POST" && action === "analyze" && pathParts.length >= 6 && pathParts[5] === "reject") {
        const itemId = decodeURIComponent(pathParts[4]);
        const qm = runManager.getQueueManager(runId);
        if (!qm) { sendJson(res, 404, { error: `Run not found or no queue state: ${runId}` }); return; }
        const item = qm.getItem(itemId);
        if (!item || item.type !== 'analyze_video') {
          sendJson(res, 404, { error: `Analyze item not found: ${itemId}` });
          return;
        }

        try {
          qm.setReviewStatus(itemId, 'rejected');
          qm.save();
          emitEvent(runId, "analyze_rejected", { analyzeItemId: itemId });
          sendJson(res, 200, { rejected: itemId });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          sendJson(res, 409, { error: msg });
        }
        return;
      }

      // GET /api/runs/:id/script
      if (method === "GET" && action === "script" && pathParts.length === 4) {
        const run = runManager.getRun(runId);
        if (!run) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }
        const qm = runManager.getQueueManager(runId);
        const state = qm?.getState();
        const scenes = (state?.storyAnalysis?.scenes ?? []).map((s: { sceneNumber: number; title: string; narrativeSummary: string; location: string; charactersPresent: string[] }) => ({
          sceneNumber: s.sceneNumber,
          title: s.title,
          narrativeSummary: s.narrativeSummary,
          location: s.location,
          charactersPresent: s.charactersPresent,
        }));
        sendJson(res, 200, {
          convertedScript: state?.convertedScript ?? null,
          storyText: run.storyText,
          scenes,
        });
        return;
      }

      // PUT /api/runs/:id/script
      if (method === "PUT" && action === "script" && pathParts.length === 4) {
        const run = runManager.getRun(runId);
        if (!run) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }
        const qm = runManager.getQueueManager(runId);
        if (!qm) { sendJson(res, 404, { error: `Run not found or not initialized: ${runId}` }); return; }
        const body = await readJsonBody(req) as Record<string, unknown>;
        const script = body.script;
        if (typeof script !== "string" || script.trim().length === 0) {
          sendJson(res, 400, { error: "script is required and must be a non-empty string" });
          return;
        }
        qm.setConvertedScript(script);

        // Clear stale analysis data so the UI doesn't show old scenes
        const currentAnalysis = qm.getState().storyAnalysis;
        if (currentAnalysis) {
          qm.clearAnalysisScenes();
        }

        // Find the active analyze_story item
        const analyzeItems = qm.getItemsByKey("analyze_story")
          .filter(i => i.status !== "superseded" && i.status !== "cancelled");
        let supersededCount = 0;
        if (analyzeItems.length > 0) {
          const latestAnalyze = analyzeItems[analyzeItems.length - 1];
          try {
            const newItem = runManager.redoItem(runId, latestAnalyze.id, { storyText: script });
            if (newItem) {
              supersededCount = 1;
              // Count cascaded superseded items
              const state = qm.getState();
              supersededCount = state.workItems.filter(i => i.supersededBy === latestAnalyze.id || i.supersededBy === newItem.id).length + 1;
              emitEvent(runId, "item_redo", { oldItemId: latestAnalyze.id, newItem });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            sendJson(res, 409, { error: msg });
            return;
          }
        }

        qm.save();
        await runManager.resumeRun(runId);
        sendJson(res, 200, { ok: true, supersededCount });
        return;
      }

      // POST /api/runs/:id/scenes/:sceneNumber/redo
      if (method === "POST" && action === "scenes" && pathParts.length >= 6 && pathParts[5] === "redo") {
        const sceneNumber = parseInt(pathParts[4], 10);
        if (isNaN(sceneNumber)) {
          sendJson(res, 400, { error: "Invalid scene number" });
          return;
        }
        const qm = runManager.getQueueManager(runId);
        if (!qm) { sendJson(res, 404, { error: `Run not found or not initialized: ${runId}` }); return; }

        const body = await readJsonBody(req) as Record<string, unknown>;
        const directorsNote = body.directorsNote as string | undefined;

        const planShotsKey = `plan_shots:scene:${sceneNumber}`;
        const planItems = qm.getItemsByKey(planShotsKey)
          .filter(i => i.status !== "superseded" && i.status !== "cancelled");

        if (planItems.length === 0) {
          sendJson(res, 404, { error: `No plan_shots item found for scene ${sceneNumber}` });
          return;
        }

        const latestPlan = planItems[planItems.length - 1];
        const sceneNewInputs = directorsNote ? { ...latestPlan.inputs, directorsNote } : undefined;
        try {
          const newItem = runManager.redoItem(runId, latestPlan.id, sceneNewInputs);
          if (!newItem) {
            sendJson(res, 500, { error: `Failed to redo plan_shots for scene ${sceneNumber}` });
            return;
          }

          qm.save();
          await runManager.resumeRun(runId);
          emitEvent(runId, "item_redo", { oldItemId: latestPlan.id, newItem });

          const state = qm.getState();
          const cascadeCount = state.workItems.filter(i => i.supersededBy !== null && i.itemKey.includes(`scene:${sceneNumber}`)).length;
          sendJson(res, 200, { ok: true, redoneItemId: newItem.id, cascadeCount });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          sendJson(res, 409, { error: msg });
        }
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

    // GET /api/capabilities
    if (method === "GET" && url.pathname === "/api/capabilities") {
      sendJson(res, 200, {
        elevenLabsAvailable: isElevenLabsAvailable(),
        queueConcurrency: {
          llm: getQueueConcurrency("llm"),
          image: getQueueConcurrency("image"),
          video: getQueueConcurrency("video"),
        },
      });
      return;
    }

    // POST /api/runs/:id/add-music
    if (pathParts.length === 4 && pathParts[0] === "api" && pathParts[1] === "runs" && pathParts[3] === "add-music" && method === "POST") {
      const runId = decodeURIComponent(pathParts[2]);
      const run = runManager.getRun(runId);
      if (!run) { sendJson(res, 404, { error: `Run not found: ${runId}` }); return; }

      if (!isElevenLabsAvailable()) {
        sendJson(res, 400, { error: "ELEVENLABS_API_KEY is not configured" });
        return;
      }

      const outputDir = resolveOutputDir(run.outputDir);
      const videoPath = join(outputDir, "final.mp4");
      if (!existsSync(videoPath)) {
        sendJson(res, 404, { error: "final.mp4 not found — assembly may not be complete" });
        return;
      }

      try {
        const musicPath = join(outputDir, "generated-music.mp3");
        const finalMusicPath = join(outputDir, "final-music.mp4");

        await generateMusicFromVideo(videoPath, musicPath);
        await mixMusicIntoVideo(videoPath, musicPath, finalMusicPath);

        sendJson(res, 200, { path: "final-music.mp4", success: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[add-music] Error:", msg);
        sendJson(res, 500, { error: msg });
      }
      return;
    }

    // GET /api/settings
    if (method === "GET" && url.pathname === "/api/settings") {
      sendJson(res, 200, getSettings());
      return;
    }

    // POST /api/settings — partial update
    if (method === "POST" && url.pathname === "/api/settings") {
      const body = await readJsonBody(req) as Record<string, unknown>;
      const updated = updateSettings(body);
      sendJson(res, 200, updated);
      return;
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

// ---------------------------------------------------------------------------
// Vite dev middleware (dev mode only)
// ---------------------------------------------------------------------------

// Typed loosely to avoid coupling to Vite's Connect types at compile time
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let viteDevServer: any;

async function setupViteDevServer(): Promise<void> {
  if (process.env.NODE_ENV === "production") return;
  try {
    const vite = await (import("vite") as Promise<typeof import("vite")>);
    const webUiRoot = resolve(process.cwd(), "web-ui");
    viteDevServer = await vite.createServer({
      root: webUiRoot,
      configFile: resolve(webUiRoot, "vite.config.ts"),
      server: {
        middlewareMode: true,
        hmr: { server },
      },
    });
    console.log("[queue-server] Vite dev middleware attached (HMR enabled)");
  } catch {
    console.log("[queue-server] Vite not available, serving static files from web-ui/dist/");
  }
}

let shutdownInProgress = false;

function initiateShutdown(reason: string, exitCode: number): void {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  console.log(`[queue-server] Shutting down: ${reason}`);

  const exitTimer = setTimeout(() => process.exit(exitCode), SHUTDOWN_TIMEOUT_MS);
  exitTimer.unref();

  if (viteDevServer) {
    void viteDevServer.close();
  }

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

async function start(): Promise<void> {
  // Load persisted settings and apply LLM provider
  const settings = loadSettings();
  setLlmProvider(settings.llmProvider);
  setLlmProviderImpl(settings.llmProvider);

  await setupViteDevServer();
  server.listen(PORT, () => {
    console.log(`Queue server listening on http://localhost:${PORT}`);
  });
}

void start();