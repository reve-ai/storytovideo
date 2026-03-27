import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname, isAbsolute, relative, resolve } from 'path';
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
import type { StoryAnalysis, AssetLibrary, Shot, Character, Location as StoryLocation, StoryObject, Scene } from '../types.js';

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

  /** Called when an in-progress item is superseded so the processor can abort it. */
  onItemSuperseded?: (itemId: string) => void;

  constructor(runId: string, storyFile: string, outputDir: string, options?: RunState['options']) {
    // Resolve to absolute for fs operations; store the (possibly relative) outputDir as-is in state
    const absOutputDir = isAbsolute(outputDir) ? outputDir : resolve(process.cwd(), outputDir);
    this.stateFilePath = join(absOutputDir, 'queue_state.json');
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

  /** Migrate any absolute paths in generatedOutputs, work item inputs/outputs, and outputDir to relative. */
  private migrateAbsolutePaths(): void {
    let changed = false;

    // Migrate outputDir itself from absolute → relative to process.cwd()
    if (isAbsolute(this.state.outputDir)) {
      const absOutputDir = this.state.outputDir;
      this.state.outputDir = relative(process.cwd(), absOutputDir);
      changed = true;

      // Strip the old absolute outputDir prefix from generatedOutputs and work items
      for (const [key, val] of Object.entries(this.state.generatedOutputs)) {
        if (val.startsWith(absOutputDir)) {
          this.state.generatedOutputs[key] = val.slice(absOutputDir.length).replace(/^\//, '');
          changed = true;
        }
      }

      for (const item of this.state.workItems) {
        for (const [key, val] of Object.entries(item.outputs)) {
          if (typeof val === 'string' && val.startsWith(absOutputDir)) {
            (item.outputs as Record<string, unknown>)[key] = val.slice(absOutputDir.length).replace(/^\//, '');
            changed = true;
          }
        }
        for (const [key, val] of Object.entries(item.inputs)) {
          if (typeof val === 'string' && val.startsWith(absOutputDir)) {
            (item.inputs as Record<string, unknown>)[key] = val.slice(absOutputDir.length).replace(/^\//, '');
            changed = true;
          }
        }
      }
    } else {
      // outputDir is already relative; still strip any lingering absolute prefixes using resolved path
      const resolvedDir = resolve(process.cwd(), this.state.outputDir);
      for (const [key, val] of Object.entries(this.state.generatedOutputs)) {
        if (val.startsWith(resolvedDir)) {
          this.state.generatedOutputs[key] = val.slice(resolvedDir.length).replace(/^\//, '');
          changed = true;
        }
      }

      for (const item of this.state.workItems) {
        for (const [key, val] of Object.entries(item.outputs)) {
          if (typeof val === 'string' && val.startsWith(resolvedDir)) {
            (item.outputs as Record<string, unknown>)[key] = val.slice(resolvedDir.length).replace(/^\//, '');
            changed = true;
          }
        }
        for (const [key, val] of Object.entries(item.inputs)) {
          if (typeof val === 'string' && val.startsWith(resolvedDir)) {
            (item.inputs as Record<string, unknown>)[key] = val.slice(resolvedDir.length).replace(/^\//, '');
            changed = true;
          }
        }
      }
    }

    if (changed) this.save();
  }

  // --- Accessors ---

  getState(): RunState {
    return this.snapshot(this.state);
  }

  getItem(id: string): WorkItem | undefined {
    const item = this.findItem(id);
    return item ? this.snapshot(item) : undefined;
  }

  getItemsByKey(itemKey: string): WorkItem[] {
    return this.snapshot(this.findItemsByKey(itemKey));
  }

  claimNextReady(queue: QueueName): WorkItem | null {
    for (const priority of ['high', 'normal'] as const) {
      const item = this.findNextReady(queue, priority);
      if (!item) continue;
      item.status = 'in_progress';
      item.startedAt = new Date().toISOString();
      this.touch();
      return this.snapshot(item);
    }
    return null;
  }

  // --- Add items ---

  addItem(opts: AddItemOptions): WorkItem {
    const existing = this.findItemsByKey(opts.itemKey);
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
    return this.snapshot(item);
  }

  // --- Status transitions ---

  markInProgress(id: string): boolean {
    const item = this.requireItem(id);
    if (item.status !== 'pending') return false;
    item.status = 'in_progress';
    item.startedAt = new Date().toISOString();
    this.touch();
    return true;
  }

  markCompleted(id: string, outputs?: Record<string, unknown>): boolean {
    const item = this.requireItem(id);
    if (item.status !== 'in_progress') return false;
    item.status = 'completed';
    item.completedAt = new Date().toISOString();
    if (outputs) {
      item.outputs = outputs;
    }
    this.touch();
    return true;
  }

  markFailed(id: string, error: string): boolean {
    const item = this.requireItem(id);
    if (item.status !== 'in_progress') return false;
    item.status = 'failed';
    item.error = error;
    item.completedAt = new Date().toISOString();
    this.touch();
    return true;
  }

  requeueForRetry(id: string): boolean {
    const item = this.requireItem(id);
    if (item.status !== 'in_progress') return false;
    item.status = 'pending';
    item.retryCount = (item.retryCount ?? 0) + 1;
    item.error = null;
    item.startedAt = null;
    item.completedAt = null;
    this.touch();
    return true;
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
    return this.snapshot(item);
  }

  cancelItem(id: string): boolean {
    const item = this.requireItem(id);
    if (item.status === 'completed' || item.status === 'superseded' || item.status === 'cancelled') return false;
    item.status = 'cancelled';
    this.touch();
    return true;
  }

  setReviewStatus(id: string, reviewStatus: 'accepted' | 'rejected'): WorkItem {
    const item = this.requireItem(id);
    if (item.reviewStatus) {
      throw new Error(`Review status already set for item ${id}: ${item.reviewStatus}`);
    }
    item.reviewStatus = reviewStatus;
    this.touch();
    return this.snapshot(item);
  }

  /** Add a dependency to an existing pending item (idempotent — skips if already present). */
  addDependency(itemId: string, depRef: string): WorkItem {
    const item = this.requireItem(itemId);
    if (item.status !== 'pending') {
      throw new Error(`Cannot add dependency to item ${itemId}: status is '${item.status}', expected 'pending'`);
    }
    if (!item.dependencies.includes(depRef)) {
      item.dependencies.push(depRef);
      this.touch();
    }
    return this.snapshot(item);
  }

  updateItemInputs(id: string, fields: Record<string, unknown>): WorkItem {
    const item = this.requireItem(id);
    if (item.status !== 'pending') {
      throw new Error(`Cannot edit item ${id}: status is '${item.status}', expected 'pending'`);
    }
    item.inputs = { ...item.inputs, ...fields };
    this.touch();
    return this.snapshot(item);
  }

  setItemPriority(id: string, priority: Priority): WorkItem {
    const item = this.requireItem(id);
    if (item.status !== 'pending') {
      throw new Error(`Cannot reprioritize item ${id}: status is '${item.status}', expected 'pending'`);
    }
    item.priority = priority;
    this.touch();
    return this.snapshot(item);
  }

  deleteAnalyzeItems(): number {
    const activeAnalyze = this.state.workItems.find(
      item => item.type === 'analyze_video' && item.status === 'in_progress'
    );
    if (activeAnalyze) {
      throw new Error(`Cannot delete analyze items while ${activeAnalyze.id} is in progress`);
    }

    const before = this.state.workItems.length;
    this.state.workItems = this.state.workItems.filter(item => item.type !== 'analyze_video');
    const deleted = before - this.state.workItems.length;
    if (deleted > 0) this.touch();
    return deleted;
  }

  // --- Queue picking ---

  getNextReady(queue: QueueName, priority: Priority): WorkItem | null {
    const item = this.findNextReady(queue, priority);
    return item ? this.snapshot(item) : null;
  }

  private areDependenciesMet(item: WorkItem): boolean {
    return item.dependencies.every(depRef => {
      const dep = this.resolveDependencyRef(depRef);
      return dep !== undefined && dep.status === 'completed';
    });
  }

  // --- Redo / versioning ---

  redoItem(itemId: string, newInputs?: Record<string, unknown>): WorkItem {
    const old = this.requireItem(itemId);
    if (old.status === 'in_progress') {
      throw new Error(`Cannot redo item ${itemId}: status is 'in_progress'`);
    }

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
    this.setSuperseded(old);
    old.supersededBy = newItem.id;

    // Recursively create new versions of downstream dependents
    this.cascadeRedo(old.id, newItem.id);

    this.touch();
    return this.snapshot(newItem);
  }

  private cascadeRedo(oldItemId: string, newItemId: string): void {
    const oldItem = this.findItem(oldItemId);
    const dependencyRefs = new Set<string>([oldItemId, oldItem?.itemKey].filter((value): value is string => Boolean(value)));

    // Find all items that depend on the old item (direct dependents)
    const dependents = this.state.workItems.filter(item =>
      item.dependencies.some(dep => dependencyRefs.has(dep)) &&
      item.status !== 'superseded' &&
      item.status !== 'cancelled'
    );

    for (const dep of dependents) {
      // Don't cascade items whose inputs come from parent outputs. They will be
      // re-seeded later with fresh paths after the upstream item completes.
      if (dep.type === 'generate_video') {
        this.setSuperseded(dep);
        this.cascadeSupersededVideoDependents(dep);
        continue;
      }

      if (dep.type === 'analyze_video') {
        this.setSuperseded(dep);
        this.supersedeDependents(dep.id);
        continue;
      }

      // If the old item was a frame and this dependent is also a frame (continuity link),
      // just update the dependency pointer — don't supersede/regenerate
      if (oldItem?.type === 'generate_frame' && dep.type === 'generate_frame') {
        dep.dependencies = dep.dependencies.map(d => d === oldItemId ? newItemId : d);
        continue;
      }

      // Normal cascade: create a new version of the dependent with updated dependency
      const updatedDeps = dep.dependencies.map(d =>
        (d === oldItemId || d === oldItem?.itemKey) ? newItemId : this.latestVersionId(d)
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
      this.setSuperseded(dep);
      dep.supersededBy = newDep.id;

      // Recurse into this dependent's dependents
      this.cascadeRedo(dep.id, newDep.id);
    }
  }

  private supersedeDependents(itemId: string): void {
    const item = this.findItem(itemId);
    const dependencyRefs = new Set<string>([itemId, item?.itemKey].filter((value): value is string => Boolean(value)));

    const dependents = this.state.workItems.filter(item =>
      item.dependencies.some(dep => dependencyRefs.has(dep)) &&
      item.status !== 'superseded' &&
      item.status !== 'cancelled'
    );

    for (const dep of dependents) {
      this.setSuperseded(dep);
      this.supersedeDependents(dep.id);
    }
  }

  private cascadeSupersededVideoDependents(videoItem: WorkItem): void {
    const dependencyRefs = new Set<string>([videoItem.id, videoItem.itemKey]);

    const dependents = this.state.workItems.filter(item =>
      item.dependencies.some(dep => dependencyRefs.has(dep)) &&
      item.status !== 'superseded' &&
      item.status !== 'cancelled'
    );

    for (const dep of dependents) {
      this.setSuperseded(dep);
      this.supersedeDependents(dep.id);
    }
  }

  /** Mark an item as superseded. If it was in_progress, notify via callback so the processor can abort. */
  private setSuperseded(item: WorkItem): void {
    const wasInProgress = item.status === 'in_progress';
    item.status = 'superseded';
    if (wasInProgress && this.onItemSuperseded) {
      this.onItemSuperseded(item.id);
    }
  }

  private latestVersionId(itemId: string): string {
    const item = this.findItem(itemId);
    if (!item) return itemId;
    if (item.supersededBy) {
      return this.latestVersionId(item.supersededBy);
    }
    return item.id;
  }

  // --- Snapshots for UI ---

  getQueueSnapshot(queue: QueueName): QueueSnapshot {
    const items = this.state.workItems.filter(i => i.queue === queue);
    return this.snapshot({
      queue,
      pending: items.filter(i => i.status === 'pending'),
      inProgress: items.filter(i => i.status === 'in_progress'),
      completed: items.filter(i => i.status === 'completed'),
      failed: items.filter(i => i.status === 'failed'),
      cancelled: items.filter(i => i.status === 'cancelled'),
      superseded: items.filter(i => i.status === 'superseded'),
    });
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
      for (const depRef of item.dependencies) {
        const dep = this.resolveDependencyRef(depRef);
        if (dep) {
          edges.push({ from: dep.id, to: item.id });
        }
      }
    }

    return this.snapshot({ nodes, edges });
  }

  // --- Scoped state mutation helpers ---

  /** Set initial story analysis (run-once, safe to replace). */
  setStoryAnalysis(analysis: StoryAnalysis): void {
    this.state.storyAnalysis = analysis;
    this.touch();
  }

  /** Set converted script (run-once, safe to replace). */
  setConvertedScript(script: string): void {
    this.state.convertedScript = script;
    this.touch();
  }

  /** Set run name (run-once, safe to replace). */
  setRunName(name: string): void {
    this.state.runName = name;
    this.touch();
  }

  /** Set one scene's shots in-place. Finds the scene by number and sets only scene.shots and scene.transition. */
  updateSceneShots(sceneNumber: number, shots: Shot[], transition: 'cut' | 'fade_black'): void {
    const analysis = this.state.storyAnalysis;
    if (!analysis) throw new Error('updateSceneShots: no storyAnalysis');
    const scene = analysis.scenes.find(s => s.sceneNumber === sceneNumber);
    if (!scene) throw new Error(`updateSceneShots: scene ${sceneNumber} not found`);
    scene.shots = shots;
    scene.transition = transition;
    this.touch();
  }

  /** Update or push a character by name. */
  updateCharacter(name: string, fields: Partial<Omit<Character, 'name'>>): void {
    const analysis = this.state.storyAnalysis;
    if (!analysis) throw new Error('updateCharacter: no storyAnalysis');
    const existing = analysis.characters.find(c => c.name === name);
    if (existing) {
      Object.assign(existing, fields);
    } else {
      analysis.characters.push({ name, physicalDescription: '', personality: '', ageRange: '', ...fields });
    }
    this.touch();
  }

  /** Update a location by name. */
  updateLocation(name: string, fields: Partial<Omit<StoryLocation, 'name'>>): void {
    const analysis = this.state.storyAnalysis;
    if (!analysis) throw new Error('updateLocation: no storyAnalysis');
    const existing = analysis.locations.find(l => l.name === name);
    if (existing) {
      Object.assign(existing, fields);
    }
    this.touch();
  }

  /** Update an object by name. */
  updateObject(name: string, fields: Partial<Omit<StoryObject, 'name'>>): void {
    const analysis = this.state.storyAnalysis;
    if (!analysis) throw new Error('updateObject: no storyAnalysis');
    const objects = analysis.objects ?? [];
    const existing = objects.find(o => o.name === name);
    if (existing) {
      Object.assign(existing, fields);
    }
    this.touch();
  }

  /** Update one scene's metadata (title, narrativeSummary, etc.) by scene number. */
  updateScene(sceneNumber: number, fields: Partial<Omit<Scene, 'sceneNumber' | 'shots' | 'transition'>>): void {
    const analysis = this.state.storyAnalysis;
    if (!analysis) throw new Error('updateScene: no storyAnalysis');
    const existing = analysis.scenes.find(s => s.sceneNumber === sceneNumber);
    if (existing) {
      Object.assign(existing, fields);
    }
    this.touch();
  }

  /** Update top-level analysis fields (artStyle, title) for pacing artifact. */
  updateAnalysisMeta(fields: Partial<Pick<StoryAnalysis, 'artStyle' | 'title'>>): void {
    const analysis = this.state.storyAnalysis;
    if (!analysis) throw new Error('updateAnalysisMeta: no storyAnalysis');
    Object.assign(analysis, fields);
    this.touch();
  }

  /** Update one shot's duration by scene number and shot-in-scene index. */
  updateShotDuration(sceneNumber: number, shotInScene: number, duration: number): void {
    const analysis = this.state.storyAnalysis;
    if (!analysis) throw new Error('updateShotDuration: no storyAnalysis');
    const scene = analysis.scenes.find(s => s.sceneNumber === sceneNumber);
    if (!scene) throw new Error(`updateShotDuration: scene ${sceneNumber} not found`);
    const shot = scene.shots.find(s => s.shotInScene === shotInScene);
    if (!shot) throw new Error(`updateShotDuration: shot ${sceneNumber}.${shotInScene} not found`);
    shot.durationSeconds = duration;
    this.touch();
  }

  /** Update one shot's continuity flag by scene number and shot-in-scene index. */
  updateShotContinuity(sceneNumber: number, shotInScene: number, enabled: boolean): void {
    const analysis = this.state.storyAnalysis;
    if (!analysis) throw new Error('updateShotContinuity: no storyAnalysis');
    const scene = analysis.scenes.find(s => s.sceneNumber === sceneNumber);
    if (!scene) throw new Error(`updateShotContinuity: scene ${sceneNumber} not found`);
    const shot = scene.shots.find(s => s.shotInScene === shotInScene);
    if (!shot) throw new Error(`updateShotContinuity: shot ${sceneNumber}.${shotInScene} not found`);
    shot.continuousFromPrevious = enabled;
    this.touch();
  }

  /** Set a single generated output path by key. */
  setGeneratedOutput(key: string, path: string): void {
    this.state.generatedOutputs[key] = path;
    this.touch();
  }

  /** Full replace of asset library (rebuilt from generatedOutputs). */
  setAssetLibrary(lib: AssetLibrary): void {
    this.state.assetLibrary = lib;
    this.touch();
  }

  /** Set one manual duration entry. */
  setManualDuration(key: string | number, value: boolean): void {
    if (!this.state.manualDurations) this.state.manualDurations = {};
    this.state.manualDurations[key] = value;
    this.touch();
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
    const item = this.findItem(id);
    if (!item) {
      throw new Error(`Work item not found: ${id}`);
    }
    return item;
  }

  private findItem(id: string): WorkItem | undefined {
    return this.state.workItems.find(item => item.id === id);
  }

  private resolveDependencyRef(depRef: string): WorkItem | undefined {
    return this.findItem(depRef) ?? this.findActiveItemByKey(depRef);
  }

  private findItemsByKey(itemKey: string): WorkItem[] {
    return this.state.workItems.filter(item => item.itemKey === itemKey);
  }

  private findActiveItemByKey(itemKey: string): WorkItem | undefined {
    return this.findItemsByKey(itemKey)
      .filter(item => item.status !== 'superseded' && item.status !== 'cancelled')
      .sort((a, b) => b.version - a.version)[0];
  }

  private findNextReady(queue: QueueName, priority: Priority): WorkItem | null {
    const candidates = this.state.workItems.filter(item =>
      item.queue === queue &&
      item.priority === priority &&
      item.status === 'pending' &&
      this.areDependenciesMet(item)
    );

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return candidates[0];
  }

  private snapshot<T>(value: T): T {
    return this.deepFreeze(structuredClone(value));
  }

  private deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== 'object') {
      return value;
    }

    const obj = value as Record<string, unknown>;
    const props = Object.getOwnPropertyNames(obj);
    for (const prop of props) {
      this.deepFreeze(obj[prop]);
    }
    return Object.freeze(value);
  }

  private touch(): void {
    this.state.updatedAt = new Date().toISOString();
  }
}

