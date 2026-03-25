import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import type {
  WorkItem,
  WorkItemType,
  QueueName,
  Priority,
  RunState,
  QueueSnapshot,
  DependencyGraph,
  DependencyGraphNode,
  DependencyGraphEdge,
} from './types.js';

interface AddItemOptions {
  type: WorkItemType;
  queue: QueueName;
  itemKey: string;
  dependencies?: string[];
  inputs?: Record<string, unknown>;
  priority?: Priority;
}

export class QueueManager {
  private state: RunState;
  private stateFilePath: string;

  constructor(runId: string, storyFile: string, outputDir: string, options?: RunState['options']) {
    this.stateFilePath = join(outputDir, 'queue_state.json');
    this.state = {
      runId,
      storyFile,
      outputDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workItems: [],
      storyAnalysis: null,
      assetLibrary: null,
      convertedScript: null,
      runName: null,
      generatedOutputs: {},
      options,
    };
  }

  // --- Static loader ---

  static load(stateFilePath: string): QueueManager {
    const raw = readFileSync(stateFilePath, 'utf-8');
    const state = JSON.parse(raw) as RunState;
    const mgr = new QueueManager(state.runId, state.storyFile, state.outputDir);
    mgr.state = state;
    mgr.stateFilePath = stateFilePath;
    mgr.migrateAbsolutePaths();
    return mgr;
  }

  /** Migrate any absolute paths in generatedOutputs and work item inputs/outputs to relative. */
  private migrateAbsolutePaths(): void {
    const outputDir = this.state.outputDir;
    let changed = false;

    for (const [key, val] of Object.entries(this.state.generatedOutputs)) {
      if (val.startsWith(outputDir)) {
        this.state.generatedOutputs[key] = val.slice(outputDir.length).replace(/^\//, '');
        changed = true;
      }
    }

    for (const item of this.state.workItems) {
      for (const [key, val] of Object.entries(item.outputs)) {
        if (typeof val === 'string' && val.startsWith(outputDir)) {
          (item.outputs as Record<string, unknown>)[key] = val.slice(outputDir.length).replace(/^\//, '');
          changed = true;
        }
      }
      for (const [key, val] of Object.entries(item.inputs)) {
        if (typeof val === 'string' && val.startsWith(outputDir)) {
          (item.inputs as Record<string, unknown>)[key] = val.slice(outputDir.length).replace(/^\//, '');
          changed = true;
        }
      }
    }

    if (changed) this.save();
  }

  // --- Accessors ---

  getState(): RunState {
    return this.state;
  }

  getItem(id: string): WorkItem | undefined {
    return this.state.workItems.find(item => item.id === id);
  }

  getItemsByKey(itemKey: string): WorkItem[] {
    return this.state.workItems.filter(item => item.itemKey === itemKey);
  }

  // --- Add items ---

  addItem(opts: AddItemOptions): WorkItem {
    const existing = this.getItemsByKey(opts.itemKey);
    const version = existing.length > 0
      ? Math.max(...existing.map(i => i.version)) + 1
      : 1;

    const item: WorkItem = {
      id: randomUUID(),
      type: opts.type,
      queue: opts.queue,
      status: 'pending',
      priority: opts.priority ?? 'normal',
      version,
      itemKey: opts.itemKey,
      dependencies: opts.dependencies ?? [],
      inputs: opts.inputs ?? {},
      outputs: {},
      retryCount: 0,
      error: null,
      supersededBy: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
    };

    this.state.workItems.push(item);
    this.touch();
    return item;
  }

  // --- Status transitions ---

  markInProgress(id: string): void {
    const item = this.requireItem(id);
    item.status = 'in_progress';
    item.startedAt = new Date().toISOString();
    this.touch();
  }

  markCompleted(id: string, outputs?: Record<string, unknown>): void {
    const item = this.requireItem(id);
    item.status = 'completed';
    item.completedAt = new Date().toISOString();
    if (outputs) {
      item.outputs = outputs;
    }
    this.touch();
  }

  markFailed(id: string, error: string): void {
    const item = this.requireItem(id);
    item.status = 'failed';
    item.error = error;
    item.completedAt = new Date().toISOString();
    this.touch();
  }

  requeueForRetry(id: string): void {
    const item = this.requireItem(id);
    item.status = 'pending';
    item.retryCount = (item.retryCount ?? 0) + 1;
    item.error = null;
    item.startedAt = null;
    item.completedAt = null;
    this.touch();
  }

  /** Manual retry — resets a failed item to pending so it gets picked up again.
   *  Unlike redo, this does NOT create a new version or cascade to dependents.
   *  No retry limit — the user can call this as many times as they want. */
  retryItem(id: string): WorkItem {
    const item = this.requireItem(id);
    if (item.status !== 'failed') {
      throw new Error(`Cannot retry item ${id}: status is '${item.status}', expected 'failed'`);
    }
    item.status = 'pending';
    item.retryCount = (item.retryCount ?? 0) + 1;
    item.error = null;
    item.startedAt = null;
    item.completedAt = null;
    this.touch();
    return item;
  }

  cancelItem(id: string): void {
    const item = this.requireItem(id);
    if (item.status === 'completed') return;
    item.status = 'cancelled';
    this.touch();
  }

  // --- Queue picking ---

  getNextReady(queue: QueueName, priority: Priority): WorkItem | null {
    const candidates = this.state.workItems.filter(item =>
      item.queue === queue &&
      item.priority === priority &&
      item.status === 'pending' &&
      this.areDependenciesMet(item)
    );

    if (candidates.length === 0) return null;

    // Return the earliest-created ready item
    candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return candidates[0];
  }

  private areDependenciesMet(item: WorkItem): boolean {
    return item.dependencies.every(depId => {
      const dep = this.getItem(depId);
      return dep !== undefined && dep.status === 'completed';
    });
  }

  // --- Redo / versioning ---

  redoItem(itemId: string, newInputs?: Record<string, unknown>): WorkItem {
    const old = this.requireItem(itemId);

    // Create new version of this item
    const newItem = this.addItem({
      type: old.type,
      queue: old.queue,
      itemKey: old.itemKey,
      // Remap dependencies: if any dependency was itself superseded, follow the chain
      dependencies: old.dependencies.map(depId => this.latestVersionId(depId)),
      inputs: newInputs ?? { ...old.inputs },
      priority: 'high',
    });

    // Mark old as superseded
    old.status = 'superseded';
    old.supersededBy = newItem.id;

    // Recursively create new versions of downstream dependents
    this.cascadeRedo(old.id, newItem.id);

    this.touch();
    return newItem;
  }

  private cascadeRedo(oldItemId: string, newItemId: string): void {
    // Find all items that depend on the old item (direct dependents)
    const dependents = this.state.workItems.filter(item =>
      item.dependencies.includes(oldItemId) &&
      item.status !== 'superseded' &&
      item.status !== 'cancelled'
    );

    for (const dep of dependents) {
      // If the old item was a frame and this dependent is also a frame (continuity link),
      // just update the dependency pointer — don't supersede/regenerate
      const oldItem = this.getItem(oldItemId);
      if (oldItem?.type === 'generate_frame' && dep.type === 'generate_frame') {
        dep.dependencies = dep.dependencies.map(d => d === oldItemId ? newItemId : d);
        continue;
      }

      // Normal cascade: create a new version of the dependent with updated dependency
      const updatedDeps = dep.dependencies.map(d =>
        d === oldItemId ? newItemId : this.latestVersionId(d)
      );

      const newDep = this.addItem({
        type: dep.type,
        queue: dep.queue,
        itemKey: dep.itemKey,
        dependencies: updatedDeps,
        inputs: { ...dep.inputs },
        priority: 'high',
      });

      // Mark old dependent as superseded
      dep.status = 'superseded';
      dep.supersededBy = newDep.id;

      // Recurse into this dependent's dependents
      this.cascadeRedo(dep.id, newDep.id);
    }
  }

  private latestVersionId(itemId: string): string {
    const item = this.getItem(itemId);
    if (!item) return itemId;
    if (item.supersededBy) {
      return this.latestVersionId(item.supersededBy);
    }
    return item.id;
  }

  // --- Snapshots for UI ---

  getQueueSnapshot(queue: QueueName): QueueSnapshot {
    const items = this.state.workItems.filter(i => i.queue === queue);
    return {
      queue,
      pending: items.filter(i => i.status === 'pending'),
      inProgress: items.filter(i => i.status === 'in_progress'),
      completed: items.filter(i => i.status === 'completed'),
      failed: items.filter(i => i.status === 'failed'),
      cancelled: items.filter(i => i.status === 'cancelled'),
      superseded: items.filter(i => i.status === 'superseded'),
    };
  }

  getDependencyGraph(): DependencyGraph {
    const nodes: DependencyGraphNode[] = this.state.workItems.map(item => ({
      id: item.id,
      itemKey: item.itemKey,
      type: item.type,
      status: item.status,
      version: item.version,
      queue: item.queue,
      priority: item.priority,
    }));

    const edges: DependencyGraphEdge[] = [];
    for (const item of this.state.workItems) {
      for (const depId of item.dependencies) {
        edges.push({ from: depId, to: item.id });
      }
    }

    return { nodes, edges };
  }

  // --- Persistence ---

  save(): void {
    this.state.updatedAt = new Date().toISOString();
    const dir = dirname(this.stateFilePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.stateFilePath, JSON.stringify(this.state, null, 2));
  }

  // --- Helpers ---

  private requireItem(id: string): WorkItem {
    const item = this.getItem(id);
    if (!item) {
      throw new Error(`Work item not found: ${id}`);
    }
    return item;
  }

  private touch(): void {
    this.state.updatedAt = new Date().toISOString();
  }
}

