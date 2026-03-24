import { randomUUID } from "crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { EventEmitter } from "events";
import { QueueManager } from "./queue-manager.js";
import { QueueProcessor } from "./processors.js";
import type { WorkItem, QueueName } from "./types.js";

// ---------------------------------------------------------------------------
// Run record persisted to queue-runs.json
// ---------------------------------------------------------------------------

export type QueueRunStatus = "running" | "stopped" | "completed" | "failed";

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
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RUN_DB_DIR = resolve(process.env.STORYTOVIDEO_RUN_DB_DIR ?? "./output/api-server");
const RUN_DB_PATH = join(RUN_DB_DIR, "queue-runs.json");
const RUN_OUTPUT_ROOT = resolve(process.env.STORYTOVIDEO_RUN_OUTPUT_ROOT ?? "./output/runs");

// ---------------------------------------------------------------------------
// RunManager
// ---------------------------------------------------------------------------

export class RunManager extends EventEmitter {
  private readonly runs = new Map<string, QueueRunRecord>();
  private readonly queueManagers = new Map<string, QueueManager>();
  private readonly processors = new Map<string, QueueProcessor[]>();

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
      for (const r of records) {
        this.runs.set(r.id, r);
      }
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
    const outputDir = resolve(join(RUN_OUTPUT_ROOT, runId));
    mkdirSync(outputDir, { recursive: true });

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
      const proc = new QueueProcessor(queue, qm, runId);
      // Forward processor events so the server can relay them via SSE
      proc.on("item:started", (data) => this.emit("item:started", data));
      proc.on("item:completed", (data) => this.emit("item:completed", data));
      proc.on("item:failed", (data) => this.emit("item:failed", data));
      proc.on("pipeline:pause", (data) => {
        this.emit("pipeline:pause", data);
        // Auto-pause: stop all processors for this run
        this.stopRun(runId);
      });
      proc.start();
      procs.push(proc);
    }

    this.processors.set(runId, procs);
  }

  // -- Stop / Resume --------------------------------------------------------

  async stopRun(runId: string): Promise<boolean> {
    const procs = this.processors.get(runId);
    if (!procs) return false;

    await Promise.allSettled(procs.map(p => p.stop()));

    this.patchRun(runId, { status: "stopped" });
    return true;
  }

  async resumeRun(runId: string): Promise<boolean> {
    const record = this.runs.get(runId);
    if (!record) return false;
    if (record.status !== "stopped") return false;

    let qm = this.queueManagers.get(runId);
    if (!qm) {
      // Reload from disk
      const stateFile = join(record.outputDir, "queue_state.json");
      qm = QueueManager.load(stateFile);
      this.queueManagers.set(runId, qm);
    }

    // Stop any existing processors
    const existing = this.processors.get(runId);
    if (existing) {
      await Promise.allSettled(existing.map(p => p.stop()));
    }

    this.startProcessors(runId, qm);
    this.patchRun(runId, { status: "running", startedAt: new Date().toISOString() });
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

  // -- Run completion / failure hooks (called by processors) ----------------

  markRunCompleted(runId: string): void {
    this.patchRun(runId, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });
  }

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
    // Stop processors first
    await this.stopRun(runId);
    this.processors.delete(runId);
    this.queueManagers.delete(runId);

    const existed = this.runs.delete(runId);
    if (existed) this.persistRuns();
    return existed;
  }

  // -- Load existing runs on startup ----------------------------------------

  loadExistingRuns(): void {
    // Re-attach QueueManagers for persisted runs that have state on disk
    for (const [runId, record] of this.runs) {
      if (record.status === "running" || record.status === "stopped") {
        try {
          const stateFile = join(record.outputDir, "queue_state.json");
          if (!existsSync(stateFile)) continue;
          const qm = QueueManager.load(stateFile);
          this.queueManagers.set(runId, qm);

          // Mark previously-running runs as stopped (server restarted)
          if (record.status === "running") {
            this.patchRun(runId, { status: "stopped" });
          }
        } catch (err) {
          console.error(`[RunManager] Failed to reload run ${runId}:`, err);
        }
      }
    }
  }
}
