import { randomUUID } from "crypto";
import { mkdirSync, existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join, resolve, relative, isAbsolute } from "path";
import { EventEmitter } from "events";
import { QueueManager } from "./queue-manager.js";
import { QueueProcessor, getQueueConcurrency } from "./processors.js";
import type { WorkItem, QueueName } from "./types.js";
import type { ImageBackend, VideoBackend } from "../types.js";

// ---------------------------------------------------------------------------
// Path helpers — stored paths are relative to process.cwd()
// ---------------------------------------------------------------------------

/** Convert a potentially-absolute outputDir to a path relative to process.cwd(). */
export function toRelativeOutputDir(outputDir: string): string {
  if (!isAbsolute(outputDir)) return outputDir;
  return relative(process.cwd(), outputDir);
}

/** Resolve a (potentially relative) outputDir to an absolute path. */
export function resolveOutputDir(outputDir: string): string {
  if (isAbsolute(outputDir)) return outputDir;
  return resolve(process.cwd(), outputDir);
}

// ---------------------------------------------------------------------------
// Run record persisted to queue-runs.json
// ---------------------------------------------------------------------------

export type QueueRunStatus = "running" | "stopping" | "stopped" | "done" | "completed" | "failed";

export interface QueueRunRecord {
  id: string;
  name?: string;
  storyText: string;
  outputDir: string;
  status: QueueRunStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  options: RunOptions;
}

export interface RunOptions {
  needsConversion?: boolean;   // if true, seed story_to_script first
  aspectRatio?: string;        // e.g. "16:9"
  dryRun?: boolean;
  imageBackend?: ImageBackend;
  assetImageBackend?: ImageBackend;
  videoBackend?: VideoBackend;
  llmProvider?: 'anthropic' | 'openai';
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RUN_DB_DIR = resolve(process.env.STORYTOVIDEO_RUN_DB_DIR ?? "./output/api-server");
const RUN_DB_PATH = join(RUN_DB_DIR, "queue-runs.json");
/** Relative output root for run directories (e.g. "output/runs"). */
const RUN_OUTPUT_ROOT = process.env.STORYTOVIDEO_RUN_OUTPUT_ROOT ?? "output/runs";

// ---------------------------------------------------------------------------
// RunManager
// ---------------------------------------------------------------------------

export class RunManager extends EventEmitter {
  private readonly runs = new Map<string, QueueRunRecord>();
  private readonly queueManagers = new Map<string, QueueManager>();
  private readonly processors = new Map<string, QueueProcessor[]>();
  private readonly runLocks = new Map<string, Promise<void>>();

  constructor() {
    super();
    this.loadRuns();
  }

  // -- Persistence ----------------------------------------------------------

  private loadRuns(): void {
    mkdirSync(RUN_DB_DIR, { recursive: true });
    if (!existsSync(RUN_DB_PATH)) return;
    try {
      const raw = readFileSync(RUN_DB_PATH, "utf-8");
      const records = JSON.parse(raw) as QueueRunRecord[];
      let migrated = false;
      for (const r of records) {
        // Migrate absolute outputDir → relative
        if (isAbsolute(r.outputDir)) {
          r.outputDir = toRelativeOutputDir(r.outputDir);
          migrated = true;
        }
        this.runs.set(r.id, r);
      }
      if (migrated) this.persistRuns();
    } catch (err) {
      console.error("[RunManager] Failed to load queue-runs.json:", err);
    }
  }

  private persistRuns(): void {
    mkdirSync(RUN_DB_DIR, { recursive: true });
    const list = [...this.runs.values()].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt),
    );
    writeFileSync(RUN_DB_PATH, JSON.stringify(list, null, 2), "utf-8");
  }

  private patchRun(id: string, patch: Partial<QueueRunRecord>): QueueRunRecord | undefined {
    const existing = this.runs.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch };
    this.runs.set(id, updated);
    this.persistRuns();
    this.emit("run:updated", updated);
    return updated;
  }

  // -- Queries --------------------------------------------------------------

  listRuns(): QueueRunRecord[] {
    return [...this.runs.values()].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt),
    );
  }

  getRun(id: string): QueueRunRecord | undefined {
    return this.runs.get(id);
  }

  getQueueManager(runId: string): QueueManager | undefined {
    return this.queueManagers.get(runId);
  }

  // -- Create a new run -----------------------------------------------------

  createRun(storyText: string, options: RunOptions = {}): QueueRunRecord {
    const runId = randomUUID();
    const outputDir = join(RUN_OUTPUT_ROOT, runId);           // relative path for storage
    mkdirSync(resolveOutputDir(outputDir), { recursive: true }); // absolute for fs

    const now = new Date().toISOString();

    const record: QueueRunRecord = {
      id: runId,
      storyText,
      outputDir,
      status: "running",
      createdAt: now,
      startedAt: now,
      options,
    };

    this.runs.set(runId, record);
    this.persistRuns();

    // Create queue manager for this run
    const qm = new QueueManager(runId, "(api-input)", outputDir, options);

    // Seed initial work items
    this.seedInitialItems(qm, storyText, options);

    this.queueManagers.set(runId, qm);
    qm.save();

    // Start processors
    this.startProcessors(runId, qm);

    this.emit("run:created", record);
    return record;
  }

  // -- Seed initial work items ----------------------------------------------

  private seedInitialItems(
    qm: QueueManager,
    storyText: string,
    options: RunOptions,
  ): void {
    const deps: string[] = [];

    // If the story needs conversion to a visual script, seed story_to_script first
    if (options.needsConversion) {
      const convertItem = qm.addItem({
        type: "story_to_script",
        queue: "llm",
        itemKey: "story_to_script",
        dependencies: [],
        inputs: { storyText },
      });
      deps.push(convertItem.id);
    }

    // Seed analyze_story (depends on story_to_script if conversion is needed)
    qm.addItem({
      type: "analyze_story",
      queue: "llm",
      itemKey: "analyze_story",
      dependencies: deps,
      inputs: { storyText },
    });

    // Seed name_run (no dependencies — can run immediately)
    qm.addItem({
      type: "name_run",
      queue: "llm",
      itemKey: "name_run",
      dependencies: [],
      inputs: { storyText },
    });

    // NOTE: Downstream items (plan_shots, generate_asset, generate_frame,
    // generate_video, assemble) are seeded dynamically by the processors
    // after analyze_story and plan_shots complete.
  }

  // -- Processors -----------------------------------------------------------

  private startProcessors(runId: string, qm: QueueManager): void {
    const queues: QueueName[] = ["llm", "image", "video"];
    const procs: QueueProcessor[] = [];

    for (const queue of queues) {
      const concurrency = getQueueConcurrency(queue);
      const proc = new QueueProcessor(queue, qm, runId, concurrency);
      // Forward processor events so the server can relay them via SSE
      proc.on("item:started", (data) => this.emit("item:started", data));
      proc.on("item:completed", (data) => {
        this.emit("item:completed", data);
        this.checkRunCompletion(runId);
      });
      proc.on("item:failed", (data) => this.emit("item:failed", data));
      proc.on("item:cancelled", (data) => this.emit("item:cancelled", data));
      proc.on("item:progress", (data) => this.emit("item:progress", data));
      proc.on("pipeline:pause", (data) => {
        this.emit("pipeline:pause", data);
        // Auto-stop: stop all processors for this run
        this.stopRun(runId);
      });
      proc.start();
      procs.push(proc);
    }

    this.processors.set(runId, procs);

    // Wire up supersession callback so in-flight work is aborted when items are superseded
    qm.onItemSuperseded = (itemId: string) => {
      for (const proc of procs) {
        if (proc.cancelItem(itemId)) break;
      }
    };
  }

  private async withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    while (this.runLocks.has(runId)) {
      await this.runLocks.get(runId);
    }

    let release!: () => void;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.runLocks.set(runId, lock);

    try {
      return await fn();
    } finally {
      this.runLocks.delete(runId);
      release();
    }
  }

  // -- Auto-stop when all work is done --------------------------------------

  private checkRunCompletion(runId: string): void {
    const qm = this.queueManagers.get(runId);
    if (!qm) return;

    const run = this.runs.get(runId);
    if (!run || run.status !== "running") return;

    const items = qm.getState().workItems;
    const activeItems = items.filter(
      (i) => i.status !== "superseded" && i.status !== "cancelled",
    );

    const allDone = activeItems.length > 0 && activeItems.every((i) => i.status === "completed");
    if (!allDone) return;

    // All work is done — stop processors and mark as "done"
    // (user can always resume to redo items)
    const procs = this.processors.get(runId);
    if (procs) {
      void Promise.allSettled(procs.map((p) => p.stop()));
    }
    this.patchRun(runId, { status: "done" });
  }

  // -- Stop / Resume --------------------------------------------------------

  async stopRun(runId: string): Promise<boolean> {
    return this.withRunLock(runId, () => this.stopRunLocked(runId));
  }

  private async stopRunLocked(runId: string): Promise<boolean> {
    const procs = this.processors.get(runId);
    if (!procs) return false;

    // Check if any processors have in-progress items
    const qm = this.queueManagers.get(runId);
    const hasInProgress = qm
      ? qm.getState().workItems.some(i => i.status === "in_progress")
      : false;

    if (hasInProgress) {
      // Items are still running — set "stopping" and wait in the background
      this.patchRun(runId, { status: "stopping" });

      // Fire-and-forget: await processors then transition to stopped
      void Promise.allSettled(procs.map(p => p.stop())).then(() => {
        // Only transition to stopped if still in stopping state (not resumed in the meantime)
        const current = this.runs.get(runId);
        if (current && current.status === "stopping") {
          this.patchRun(runId, { status: "stopped" });
        }
      });
    } else {
      // Nothing in progress — go straight to stopped
      await Promise.allSettled(procs.map(p => p.stop()));
      this.patchRun(runId, { status: "stopped" });
    }

    return true;
  }

  async resumeRun(runId: string): Promise<boolean> {
    return this.withRunLock(runId, async () => {
      const record = this.runs.get(runId);
      if (!record) return false;
      if (record.status !== "stopped" && record.status !== "stopping" && record.status !== "done" && record.status !== "completed") return false;

      let qm = this.queueManagers.get(runId);
      if (!qm) {
        // Reload from disk — resolve relative outputDir to absolute for fs access
        const stateFile = join(resolveOutputDir(record.outputDir), "queue_state.json");
        qm = QueueManager.load(stateFile);
        this.queueManagers.set(runId, qm);
      }

      // Stop any existing processors
      const existing = this.processors.get(runId);
      if (existing) {
        await Promise.allSettled(existing.map(p => p.stop()));
      }

      // Reset any items that were in_progress when the server was interrupted
      const resetCount = qm.resetStuckItems();
      if (resetCount > 0) {
        qm.save();
      }

      this.startProcessors(runId, qm);
      this.patchRun(runId, { status: "running", startedAt: new Date().toISOString() });
      return true;
    });
  }

  // -- Cancel item -----------------------------------------------------------

  cancelItem(runId: string, itemId: string): boolean {
    const procs = this.processors.get(runId);
    const qm = this.queueManagers.get(runId);
    if (!qm) return false;

    // Try to abort in-progress work
    if (procs) {
      for (const proc of procs) {
        if (proc.cancelItem(itemId)) {
          break;
        }
      }
    }

    // Update status in queue manager
    qm.cancelItem(itemId);
    qm.save();
    return true;
  }

  // -- Redo -----------------------------------------------------------------

  redoItem(runId: string, itemId: string, newInputs?: Record<string, unknown>): WorkItem | undefined {
    const qm = this.queueManagers.get(runId);
    if (!qm) return undefined;

    const newItem = qm.redoItem(itemId, newInputs);
    qm.save();
    this.emit("item:redo", { runId, oldItemId: itemId, newItem });
    return newItem;
  }

  // -- Run failure hook (called by processors) ------------------------------

  markRunFailed(runId: string, error: string): void {
    this.patchRun(runId, {
      status: "failed",
      error,
    });
  }

  setRunName(runId: string, name: string): void {
    this.patchRun(runId, { name });
  }

  // -- Delete ---------------------------------------------------------------

  async deleteRun(runId: string): Promise<boolean> {
    return this.withRunLock(runId, async () => {
      await this.stopRunLocked(runId);
      this.processors.delete(runId);
      this.queueManagers.delete(runId);

      const existed = this.runs.delete(runId);
      if (existed) this.persistRuns();
      return existed;
    });
  }

  // -- Import a run from an extracted zip directory --------------------------

  importRun(extractedDir: string, runRecord: QueueRunRecord): QueueRunRecord {
    const newRunId = randomUUID();
    const outputDir = join(RUN_OUTPUT_ROOT, newRunId);
    const absOutputDir = resolveOutputDir(outputDir);

    // Move (rename) extracted data directory to the new run location
    renameSync(extractedDir, absOutputDir);

    // Load queue state and remap runId + outputDir
    const stateFile = join(absOutputDir, "queue_state.json");
    if (!existsSync(stateFile)) {
      throw new Error("Imported zip is missing queue_state.json");
    }
    const qm = QueueManager.load(stateFile);
    qm.remapRunId(newRunId, outputDir);
    qm.save();

    // Build run record for this import
    const now = new Date().toISOString();
    const record: QueueRunRecord = {
      id: newRunId,
      name: runRecord.name ? `${runRecord.name} (imported)` : undefined,
      storyText: runRecord.storyText,
      outputDir,
      status: "stopped",
      createdAt: now,
      startedAt: runRecord.startedAt,
      completedAt: runRecord.completedAt,
      options: runRecord.options,
    };

    this.runs.set(newRunId, record);
    this.queueManagers.set(newRunId, qm);
    this.persistRuns();
    this.emit("run:created", record);
    return record;
  }

  // -- Load existing runs on startup ----------------------------------------

  loadExistingRuns(): void {
    // Re-attach QueueManagers for persisted runs that have state on disk
    for (const [runId, record] of this.runs) {
      if (record.status === "running" || record.status === "stopped" || record.status === "stopping" || record.status === "done" || record.status === "completed") {
        try {
          const stateFile = join(resolveOutputDir(record.outputDir), "queue_state.json");
          if (!existsSync(stateFile)) continue;
          const qm = QueueManager.load(stateFile);
          this.queueManagers.set(runId, qm);

          // Reset any items that were in_progress when the server was interrupted
          const resetCount = qm.resetStuckItems();
          if (resetCount > 0) {
            qm.save();
          }

          // Determine correct status after server restart
          const items = qm.getState().workItems;
          const activeItems = items.filter(i => i.status !== "superseded" && i.status !== "cancelled");
          const allDone = activeItems.length > 0 && activeItems.every(i => i.status === "completed");

          if (allDone) {
            // All work completed — mark as done
            if (record.status !== "done") {
              this.patchRun(runId, { status: "done" });
            }
          } else if (record.status === "running" || record.status === "stopping" || record.status === "completed") {
            // Was in-flight when server restarted — mark as stopped
            this.patchRun(runId, { status: "stopped" });
          }
        } catch (err) {
          console.error(`[RunManager] Failed to reload run ${runId}:`, err);
        }
      }
    }
  }
}
