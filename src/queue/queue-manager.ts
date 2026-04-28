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
import type { CostEntry, CostSummary } from './cost-tracker.js';
import { summarizeCosts } from './cost-tracker.js';

interface AddItemOptions {
  type: WorkItemType;
  queue: QueueName;
  itemKey: string;
  dependencies?: string[];
  inputs?: Record<string, unknown>;
  priority?: Priority;
  /** When set to 'completed', the item is added directly in completed state with
   *  `initialOutputs` populated. Used by the preview-promotion path so apply.ts
   *  can register a pre-computed result without running the worker loop. */
  initialStatus?: 'completed';
  initialOutputs?: Record<string, unknown>;
}

interface PromoteCompletedOptions {
  itemKey: string;
  outputs: Record<string, unknown>;
  /** Optional explicit id of the item being superseded. If omitted, the active
   *  item with the matching itemKey is used. */
  supersedeId?: string;
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

  /** Migrate any absolute paths in generatedOutputs, work item inputs/outputs, assetLibrary, and outputDir to relative. */
  private migrateAbsolutePaths(): void {
    let changed = false;

    // Determine the absolute prefix to strip
    let absPrefix: string;
    if (isAbsolute(this.state.outputDir)) {
      absPrefix = this.state.outputDir;
      this.state.outputDir = relative(process.cwd(), absPrefix);
      changed = true;
    } else {
      absPrefix = resolve(process.cwd(), this.state.outputDir);
    }

    // Helper: strip absolute prefix from a string value
    const stripPrefix = (val: string): string | null => {
      if (val.startsWith(absPrefix)) {
        return val.slice(absPrefix.length).replace(/^\//, '');
      }
      return null;
    };

    // Strip from generatedOutputs
    for (const [key, val] of Object.entries(this.state.generatedOutputs)) {
      const rel = stripPrefix(val);
      if (rel !== null) {
        this.state.generatedOutputs[key] = rel;
        changed = true;
      }
    }

    // Strip from work item inputs/outputs
    for (const item of this.state.workItems) {
      for (const [key, val] of Object.entries(item.outputs)) {
        if (typeof val === 'string') {
          const rel = stripPrefix(val);
          if (rel !== null) {
            (item.outputs as Record<string, unknown>)[key] = rel;
            changed = true;
          }
        }
      }
      for (const [key, val] of Object.entries(item.inputs)) {
        if (typeof val === 'string') {
          const rel = stripPrefix(val);
          if (rel !== null) {
            (item.inputs as Record<string, unknown>)[key] = rel;
            changed = true;
          }
        }
      }
    }

    // Strip from assetLibrary paths
    if (this.state.assetLibrary) {
      const lib = this.state.assetLibrary;
      for (const [name, imgs] of Object.entries(lib.characterImages)) {
        const frontRel = stripPrefix(imgs.front);
        const angleRel = stripPrefix(imgs.angle);
        if (frontRel !== null) { lib.characterImages[name] = { ...imgs, front: frontRel }; changed = true; }
        if (angleRel !== null) { lib.characterImages[name] = { ...lib.characterImages[name], angle: angleRel }; changed = true; }
      }
      for (const [name, path] of Object.entries(lib.locationImages)) {
        const rel = stripPrefix(path);
        if (rel !== null) { lib.locationImages[name] = rel; changed = true; }
      }
      for (const [name, path] of Object.entries(lib.objectImages)) {
        const rel = stripPrefix(path);
        if (rel !== null) { lib.objectImages[name] = rel; changed = true; }
      }
    }

    // Always rebuild assetLibrary from the (now-relative) generatedOutputs.
    // This fixes runs that were saved with absolute assetLibrary paths,
    // regardless of whether the prefix matched for stripping.
    this.rebuildAssetLibrary();

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
      if (item.dependencies.some(d => d.startsWith('video:'))) {
        console.log(`[claim] Claimed ${item.itemKey} with video deps: ${item.dependencies.filter(d => d.startsWith('video:')).join(', ')}`);
      }
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

    const isCompleted = opts.initialStatus === 'completed';
    const now = new Date().toISOString();

    const item: WorkItem = {
      id: randomUUID(),
      type: opts.type,
      queue: opts.queue,
      status: isCompleted ? 'completed' : 'pending',
      priority: opts.priority ?? 'normal',
      version,
      itemKey: opts.itemKey,
      dependencies: opts.dependencies ?? [],
      inputs: opts.inputs ?? {},
      outputs: isCompleted ? (opts.initialOutputs ?? {}) : {},
      retryCount: 0,
      error: null,
      supersededBy: null,
      createdAt: now,
      startedAt: isCompleted ? now : null,
      completedAt: isCompleted ? now : null,
    };

    this.state.workItems.push(item);
    this.touch();
    return this.snapshot(item);
  }

  /** Promote a pre-computed result into the queue as a completed work item.
   *  Used by the preview-promotion path: apply.ts already has fresh outputs
   *  (e.g. a sandbox preview frame) and wants to skip regeneration. The new
   *  item is inserted as `completed`, the prior active item (if any) is
   *  superseded, and the existing redo cascade re-supersedes stale
   *  downstream items. The caller is still responsible for invoking
   *  `seedDownstream` to create new downstream work items. */
  promoteCompleted(opts: PromoteCompletedOptions): WorkItem {
    const supersedeTarget = opts.supersedeId
      ? this.requireItem(opts.supersedeId)
      : this.findActiveItemByKey(opts.itemKey);

    if (!supersedeTarget) {
      throw new Error(
        `promoteCompleted: no active item found for itemKey '${opts.itemKey}' and no supersedeId provided`,
      );
    }

    const newItem = this.addItem({
      type: supersedeTarget.type,
      queue: supersedeTarget.queue,
      itemKey: supersedeTarget.itemKey,
      dependencies: supersedeTarget.dependencies.map(depId => this.latestVersionId(depId)),
      inputs: { ...supersedeTarget.inputs },
      priority: supersedeTarget.priority,
      initialStatus: 'completed',
      initialOutputs: opts.outputs,
    });

    this.setSuperseded(supersedeTarget);
    supersedeTarget.supersededBy = newItem.id;

    this.cascadeRedo(supersedeTarget.id, newItem.id);

    this.touch();
    return this.snapshot(newItem);
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

  /** Reset all in_progress items back to pending.
   *  Call this after a server restart to recover items that were being processed
   *  when the server was interrupted. Returns the number of items reset. */
  resetStuckItems(): number {
    let count = 0;
    for (const item of this.state.workItems) {
      if (item.status === 'in_progress') {
        item.status = 'pending';
        item.startedAt = null;
        count++;
      }
    }
    if (count > 0) {
      console.log(`[QueueManager] Reset ${count} stuck in_progress items to pending`);
      this.touch();
    }
    return count;
  }

  /** Manual retry — resets a failed or cancelled item to pending so it gets picked up again.
   *  Unlike redo, this does NOT create a new version or cascade to dependents.
   *  No retry limit — the user can call this as many times as they want. */
  retryItem(id: string): WorkItem {
    const item = this.requireItem(id);
    if (item.status !== 'failed' && item.status !== 'cancelled') {
      throw new Error(`Cannot retry item ${id}: status is '${item.status}', expected 'failed' or 'cancelled'`);
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

  supersedeItem(id: string, supersededBy?: string): WorkItem {
    const item = this.requireItem(id);
    if (item.status === 'superseded' || item.status === 'cancelled') {
      return this.snapshot(item);
    }
    this.setSuperseded(item);
    if (supersededBy) {
      item.supersededBy = supersededBy;
    }
    this.touch();
    return this.snapshot(item);
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
      const met = dep !== undefined && dep.status === 'completed';
      return met;
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

  /** Clear scenes from storyAnalysis so the UI shows empty/loading state. */
  clearAnalysisScenes(): void {
    if (!this.state.storyAnalysis) return;
    this.state.storyAnalysis.scenes = [];
    this.touch();
  }

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

  // --- Cost tracking ---

  recordCost(entry: CostEntry): void {
    if (!this.state.costEntries) {
      this.state.costEntries = [];
    }
    this.state.costEntries.push(entry);
    this.touch();
  }

  getCostEntries(): CostEntry[] {
    return [...(this.state.costEntries ?? [])];
  }

  getCostSummary(): CostSummary {
    return summarizeCosts(this.state.costEntries ?? []);
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

  /** Update one shot's skipped flag by scene number and shot-in-scene index. */
  updateShotSkipped(sceneNumber: number, shotInScene: number, skipped: boolean): void {
    const analysis = this.state.storyAnalysis;
    if (!analysis) return;
    const scene = analysis.scenes?.find(s => s.sceneNumber === sceneNumber);
    if (!scene?.shots) return;
    const shot = scene.shots.find(s => s.shotInScene === shotInScene);
    if (!shot) return;
    shot.skipped = skipped;
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

  /** Update arbitrary fields on a shot in storyAnalysis by scene number and shot-in-scene index. */
  updateShotFields(sceneNumber: number, shotInScene: number, fields: Record<string, unknown>): void {
    const analysis = this.state.storyAnalysis;
    if (!analysis) return;
    const scene = analysis.scenes?.find(s => s.sceneNumber === sceneNumber);
    if (!scene?.shots) return;
    const shot = scene.shots.find(s => s.shotInScene === shotInScene);
    if (!shot) return;
    Object.assign(shot, fields);
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

  /** Remap runId and outputDir after import. Rebuilds assetLibrary with relative paths. */
  remapRunId(newRunId: string, newOutputDir: string): void {
    this.state.runId = newRunId;
    this.state.outputDir = newOutputDir;
    const absOutputDir = isAbsolute(newOutputDir) ? newOutputDir : resolve(process.cwd(), newOutputDir);
    this.stateFilePath = join(absOutputDir, 'queue_state.json');

    // Rebuild assetLibrary from generatedOutputs with relative paths
    this.rebuildAssetLibrary();
  }

  /** Rebuild the assetLibrary from generatedOutputs and storyAnalysis. All paths stored are relative to outputDir. */
  rebuildAssetLibrary(): void {
    const analysis = this.state.storyAnalysis;
    if (!analysis) return;

    const lib: import('../types.js').AssetLibrary = {
      characterImages: {},
      locationImages: {},
      objectImages: {},
    };

    for (const char of analysis.characters) {
      const frontPath = this.state.generatedOutputs[`character:${char.name}:front`];
      const anglePath = this.state.generatedOutputs[`character:${char.name}:angle`];
      if (frontPath) {
        lib.characterImages[char.name] = {
          front: frontPath,
          angle: anglePath ?? frontPath,
        };
      }
    }

    for (const loc of analysis.locations) {
      const p = this.state.generatedOutputs[`location:${loc.name}:front`];
      if (p) lib.locationImages[loc.name] = p;
    }

    for (const obj of (analysis.objects ?? [])) {
      const p = this.state.generatedOutputs[`object:${obj.name}:front`];
      if (p) lib.objectImages[obj.name] = p;
    }

    this.state.assetLibrary = lib;
  }

  /** Return a copy of the assetLibrary with all paths resolved to absolute using the run's outputDir. */
  resolveAssetLibrary(): import('../types.js').AssetLibrary | null {
    if (!this.state.assetLibrary) return null;
    const absOutputDir = isAbsolute(this.state.outputDir) ? this.state.outputDir : resolve(process.cwd(), this.state.outputDir);
    const toAbs = (p: string) => isAbsolute(p) ? p : join(absOutputDir, p);

    const lib = this.state.assetLibrary;
    return {
      characterImages: Object.fromEntries(
        Object.entries(lib.characterImages).map(([name, imgs]) => [name, { front: toAbs(imgs.front), angle: toAbs(imgs.angle) }])
      ),
      locationImages: Object.fromEntries(
        Object.entries(lib.locationImages).map(([name, p]) => [name, toAbs(p)])
      ),
      objectImages: Object.fromEntries(
        Object.entries(lib.objectImages).map(([name, p]) => [name, toAbs(p)])
      ),
    };
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

