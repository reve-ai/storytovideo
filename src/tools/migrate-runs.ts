#!/usr/bin/env npx tsx
/**
 * Migration script: converts old pipeline_state.json runs into queue format
 * (queue_state.json + queue-runs.json entry) so they appear in the queue UI.
 *
 * Usage: npx tsx src/tools/migrate-runs.ts
 *
 * Safe to run multiple times — skips directories that already have queue_state.json.
 */

import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'fs';
import { join, resolve, relative, isAbsolute } from 'path';
import type { PipelineState, GeneratedFrameSet, ArtifactVersion } from '../types.js';
import type { WorkItem, WorkItemType, QueueName, RunState } from '../queue/types.js';
import type { QueueRunRecord, RunOptions } from '../queue/run-manager.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RUN_OUTPUT_ROOT = resolve(process.env.STORYTOVIDEO_RUN_OUTPUT_ROOT ?? './output/runs');
const RUN_DB_DIR = resolve(process.env.STORYTOVIDEO_RUN_DB_DIR ?? './output/api-server');
const RUN_DB_PATH = join(RUN_DB_DIR, 'queue-runs.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<WorkItem> & Pick<WorkItem, 'id' | 'type' | 'queue' | 'itemKey'>): WorkItem {
  return {
    status: 'completed',
    priority: 'normal',
    version: 1,
    dependencies: [],
    inputs: {},
    outputs: {},
    retryCount: 0,
    error: null,
    supersededBy: null,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Normalize a path to be relative to outputDir. */
function normalizePath(p: string, outputDir: string): string {
  if (!p) return p;
  if (isAbsolute(p)) {
    if (p.startsWith(outputDir)) {
      return relative(outputDir, p);
    }
    // Try to make it relative anyway
    return relative(outputDir, p);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Migration logic for a single run
// ---------------------------------------------------------------------------

function migrateRun(runDir: string): QueueRunRecord | null {
  const runId = runDir.split('/').pop()!;
  const pipelineStatePath = join(runDir, 'pipeline_state.json');

  if (!existsSync(pipelineStatePath)) return null;
  if (existsSync(join(runDir, 'queue_state.json'))) {
    console.log(`  [skip] ${runId} — already has queue_state.json`);
    return null;
  }

  console.log(`  [migrate] ${runId}`);

  const raw = readFileSync(pipelineStatePath, 'utf-8');
  const old = JSON.parse(raw) as PipelineState;
  const outputDir = resolve(runDir);

  const items: WorkItem[] = [];
  const generatedOutputs: Record<string, string> = {};
  const now = old.lastSavedAt || new Date().toISOString();

  // Track IDs for dependency wiring
  let analyzeStoryId: string | null = null;
  let storyToScriptId: string | null = null;
  const assetItemIds: string[] = [];
  const planShotsIds: Record<number, string> = {};
  const frameItemIds: Record<number, string> = {};
  const videoItemIds: Record<number, string> = {};

  // --- story_to_script ---
  if (old.convertedScript) {
    const id = randomUUID();
    storyToScriptId = id;
    items.push(makeItem({
      id,
      type: 'story_to_script',
      queue: 'llm',
      itemKey: 'story_to_script',
      inputs: { storyText: '(migrated)' },
      outputs: { script: old.convertedScript },
      createdAt: now, startedAt: now, completedAt: now,
    }));
  }

  // --- analyze_story ---
  if (old.storyAnalysis) {
    const id = randomUUID();
    analyzeStoryId = id;
    items.push(makeItem({
      id,
      type: 'analyze_story',
      queue: 'llm',
      itemKey: 'analyze_story',
      dependencies: storyToScriptId ? [storyToScriptId] : [],
      inputs: { storyText: '(migrated)' },
      outputs: { analysis: old.storyAnalysis },
      createdAt: now, startedAt: now, completedAt: now,
    }));
  }

  // --- generate_asset items ---
  if (old.generatedAssets) {
    for (const [key, rawPath] of Object.entries(old.generatedAssets)) {
      const id = randomUUID();
      const relPath = normalizePath(rawPath, outputDir);
      const itemKey = `asset:${key}`;

      // Parse asset key to set proper inputs
      const parts = key.split(':');
      const assetType = parts[0]; // character, location, object
      const assetName = parts[1];
      const inputs: Record<string, unknown> = {
        description: '(migrated)',
        artStyle: old.storyAnalysis?.artStyle ?? '',
      };
      if (assetType === 'character') inputs.characterName = assetName;
      else if (assetType === 'location') inputs.locationName = assetName;
      else if (assetType === 'object') inputs.objectName = assetName;

      items.push(makeItem({
        id,
        type: 'generate_asset',
        queue: 'image',
        itemKey,
        dependencies: analyzeStoryId ? [analyzeStoryId] : [],
        inputs,
        outputs: { key, path: relPath },
        createdAt: now, startedAt: now, completedAt: now,
      }));

      // generatedOutputs uses the key WITHOUT the "asset:" prefix
      generatedOutputs[key] = relPath;
      assetItemIds.push(id);

      // Handle asset versions
      if (old.assetVersions?.[key]) {
        handleAssetVersions(old.assetVersions[key], items, id, itemKey, 'generate_asset', 'image',
          inputs, key, outputDir, now, generatedOutputs, assetItemIds, analyzeStoryId);
      }
    }
  }

  // --- plan_shots items ---
  if (old.storyAnalysis?.scenes) {
    for (const scene of old.storyAnalysis.scenes) {
      if (!scene.shots || scene.shots.length === 0) continue;
      const id = randomUUID();
      planShotsIds[scene.sceneNumber] = id;
      items.push(makeItem({
        id,
        type: 'plan_shots',
        queue: 'llm',
        itemKey: `plan_shots:scene:${scene.sceneNumber}`,
        dependencies: analyzeStoryId ? [analyzeStoryId] : [],
        inputs: { sceneNumber: scene.sceneNumber },
        outputs: { shots: scene.shots },
        createdAt: now, startedAt: now, completedAt: now,
      }));
    }
  }

  // Add frames, videos, and assemble
  addFrameVideoAssembleItems(old, items, generatedOutputs, outputDir, now,
    planShotsIds, assetItemIds, frameItemIds, videoItemIds, analyzeStoryId);

  // --- Build RunState ---
  const runState: RunState = {
    runId,
    storyFile: old.storyFile || '(migrated)',
    outputDir,
    createdAt: now,
    updatedAt: now,
    workItems: items,
    storyAnalysis: old.storyAnalysis,
    assetLibrary: old.assetLibrary,
    convertedScript: old.convertedScript ?? null,
    runName: null,
    generatedOutputs,
    manualDurations: old.manualDurations,
    options: {},
  };

  // Write queue_state.json
  const queueStatePath = join(runDir, 'queue_state.json');
  writeFileSync(queueStatePath, JSON.stringify(runState, null, 2));
  console.log(`    wrote ${queueStatePath}`);

  // Build QueueRunRecord
  const status = old.interrupted ? 'stopped' : 'completed';
  const record: QueueRunRecord = {
    id: runId,
    storyText: old.convertedScript ?? '(migrated from old pipeline)',
    outputDir,
    status: status as 'stopped' | 'completed',
    createdAt: now,
    startedAt: now,
    completedAt: status === 'completed' ? now : undefined,
    options: {} as RunOptions,
  };

  if (old.storyAnalysis?.title) {
    record.name = old.storyAnalysis.title;
  }

  return record;
}

// ---------------------------------------------------------------------------
// Frame, Video, and Assemble items
// ---------------------------------------------------------------------------

function addFrameVideoAssembleItems(
  old: PipelineState,
  items: WorkItem[],
  generatedOutputs: Record<string, string>,
  outputDir: string,
  now: string,
  planShotsIds: Record<number, string>,
  assetItemIds: string[],
  frameItemIds: Record<number, string>,
  videoItemIds: Record<number, string>,
  analyzeStoryId: string | null,
): void {
  // --- generate_frame items ---
  if (old.generatedFrames) {
    for (const [shotNumStr, frameSet] of Object.entries(old.generatedFrames)) {
      const shotNum = Number(shotNumStr);
      const fs = frameSet as GeneratedFrameSet;
      if (!fs.start && !fs.end) continue;

      const id = randomUUID();
      frameItemIds[shotNum] = id;

      // Find which scene this shot belongs to for dependency wiring
      const scene = old.storyAnalysis?.scenes.find(s =>
        s.shots?.some(sh => sh.shotNumber === shotNum)
      );
      const shot = scene?.shots?.find(sh => sh.shotNumber === shotNum);
      const deps: string[] = [];
      if (scene && planShotsIds[scene.sceneNumber]) {
        deps.push(planShotsIds[scene.sceneNumber]);
      }
      deps.push(...assetItemIds);

      const startPath = fs.start ? normalizePath(fs.start, outputDir) : undefined;
      const endPath = fs.end ? normalizePath(fs.end, outputDir) : undefined;

      if (startPath) generatedOutputs[`frame:shot:${shotNum}:start`] = startPath;
      if (endPath) generatedOutputs[`frame:shot:${shotNum}:end`] = endPath;

      items.push(makeItem({
        id,
        type: 'generate_frame',
        queue: 'image',
        itemKey: `frame:shot:${shotNum}`,
        dependencies: deps,
        inputs: { shot: shot ?? { shotNumber: shotNum } },
        outputs: { shotNumber: shotNum, startPath, endPath },
        createdAt: now, startedAt: now, completedAt: now,
      }));

      // Handle frame versions
      if (old.frameVersions?.[shotNum]) {
        handleFrameVersions(old.frameVersions[shotNum], items, id, shotNum, outputDir, now,
          deps, shot, generatedOutputs, frameItemIds);
      }
    }
  }

  // --- generate_video items ---
  if (old.generatedVideos) {
    for (const [shotNumStr, rawPath] of Object.entries(old.generatedVideos)) {
      const shotNum = Number(shotNumStr);
      const relPath = normalizePath(rawPath as string, outputDir);
      const id = randomUUID();
      videoItemIds[shotNum] = id;

      const deps: string[] = [];
      if (frameItemIds[shotNum]) deps.push(frameItemIds[shotNum]);

      const scene = old.storyAnalysis?.scenes.find(s =>
        s.shots?.some(sh => sh.shotNumber === shotNum)
      );
      const shot = scene?.shots?.find(sh => sh.shotNumber === shotNum);

      const startPath = generatedOutputs[`frame:shot:${shotNum}:start`];

      generatedOutputs[`video:shot:${shotNum}`] = relPath;

      items.push(makeItem({
        id,
        type: 'generate_video',
        queue: 'video',
        itemKey: `video:shot:${shotNum}`,
        dependencies: deps,
        inputs: {
          shot: shot ?? { shotNumber: shotNum },
          startFramePath: startPath,
        },
        outputs: {
          shotNumber: shotNum,
          path: relPath,
          promptSent: old.videoPromptsSent?.[shotNum],
        },
        createdAt: now, startedAt: now, completedAt: now,
      }));

      // Handle video versions
      if (old.videoVersions?.[shotNum]) {
        handleVideoVersions(old.videoVersions[shotNum], items, id, shotNum, outputDir, now,
          deps, shot, startPath, generatedOutputs, videoItemIds);
      }
    }
  }

  // --- assemble ---
  const finalMp4 = join(outputDir, 'final.mp4');
  if (existsSync(finalMp4)) {
    const assembleId = randomUUID();
    const allVideoIds = Object.values(videoItemIds);
    items.push(makeItem({
      id: assembleId,
      type: 'assemble',
      queue: 'llm',
      itemKey: 'assemble',
      dependencies: allVideoIds,
      outputs: { path: 'final.mp4' },
      createdAt: now, startedAt: now, completedAt: now,
    }));
  }
}

// ---------------------------------------------------------------------------
// Version handling helpers
// ---------------------------------------------------------------------------

function handleAssetVersions(
  versions: ArtifactVersion[],
  items: WorkItem[],
  firstItemId: string,
  itemKey: string,
  type: WorkItemType,
  queue: QueueName,
  inputs: Record<string, unknown>,
  assetKey: string,
  outputDir: string,
  now: string,
  generatedOutputs: Record<string, string>,
  assetItemIds: string[],
  analyzeStoryId: string | null,
): void {
  if (versions.length <= 1) return;

  // The first item we already created is version 1.
  // Create additional items for versions 2+, with supersededBy chains.
  let prevId = firstItemId;
  for (let i = 1; i < versions.length; i++) {
    const v = versions[i];
    const id = randomUUID();
    const relPath = normalizePath(v.path, outputDir);

    // Mark previous as superseded
    const prevItem = items.find(it => it.id === prevId);
    if (prevItem) {
      prevItem.status = 'superseded';
      prevItem.supersededBy = id;
    }

    items.push(makeItem({
      id,
      type,
      queue,
      itemKey,
      version: v.version || i + 1,
      dependencies: analyzeStoryId ? [analyzeStoryId] : [],
      inputs,
      outputs: { key: assetKey, path: relPath },
      createdAt: v.timestamp || now,
      startedAt: v.timestamp || now,
      completedAt: v.timestamp || now,
    }));

    generatedOutputs[assetKey] = relPath;
    // Replace in assetItemIds
    const idx = assetItemIds.indexOf(prevId);
    if (idx >= 0) assetItemIds[idx] = id;
    prevId = id;
  }
}

function handleFrameVersions(
  frameVersionMap: Record<string, ArtifactVersion[]>,
  items: WorkItem[],
  firstItemId: string,
  shotNum: number,
  outputDir: string,
  now: string,
  deps: string[],
  shot: unknown,
  generatedOutputs: Record<string, string>,
  frameItemIds: Record<number, string>,
): void {
  // frameVersionMap is { start: ArtifactVersion[], end: ArtifactVersion[] }
  const startVersions = frameVersionMap['start'] ?? [];
  const endVersions = frameVersionMap['end'] ?? [];
  const maxVersions = Math.max(startVersions.length, endVersions.length);
  if (maxVersions <= 1) return;

  let prevId = firstItemId;
  for (let i = 1; i < maxVersions; i++) {
    const id = randomUUID();
    const sv = startVersions[i];
    const ev = endVersions[i];

    const prevItem = items.find(it => it.id === prevId);
    if (prevItem) {
      prevItem.status = 'superseded';
      prevItem.supersededBy = id;
    }

    const startPath = sv ? normalizePath(sv.path, outputDir) : undefined;
    const endPath = ev ? normalizePath(ev.path, outputDir) : undefined;
    const ts = sv?.timestamp || ev?.timestamp || now;

    if (startPath) generatedOutputs[`frame:shot:${shotNum}:start`] = startPath;
    if (endPath) generatedOutputs[`frame:shot:${shotNum}:end`] = endPath;

    items.push(makeItem({
      id,
      type: 'generate_frame',
      queue: 'image',
      itemKey: `frame:shot:${shotNum}`,
      version: i + 1,
      dependencies: deps,
      inputs: { shot: shot ?? { shotNumber: shotNum } },
      outputs: { shotNumber: shotNum, startPath, endPath },
      createdAt: ts, startedAt: ts, completedAt: ts,
    }));

    frameItemIds[shotNum] = id;
    prevId = id;
  }
}

function handleVideoVersions(
  versions: ArtifactVersion[],
  items: WorkItem[],
  firstItemId: string,
  shotNum: number,
  outputDir: string,
  now: string,
  deps: string[],
  shot: unknown,
  startPath: string | undefined,
  generatedOutputs: Record<string, string>,
  videoItemIds: Record<number, string>,
): void {
  if (versions.length <= 1) return;

  let prevId = firstItemId;
  for (let i = 1; i < versions.length; i++) {
    const v = versions[i];
    const id = randomUUID();
    const relPath = normalizePath(v.path, outputDir);

    const prevItem = items.find(it => it.id === prevId);
    if (prevItem) {
      prevItem.status = 'superseded';
      prevItem.supersededBy = id;
    }

    generatedOutputs[`video:shot:${shotNum}`] = relPath;

    items.push(makeItem({
      id,
      type: 'generate_video',
      queue: 'video',
      itemKey: `video:shot:${shotNum}`,
      version: v.version || i + 1,
      dependencies: deps,
      inputs: {
        shot: shot ?? { shotNumber: shotNum },
        startFramePath: startPath,
      },
      outputs: {
        shotNumber: shotNum,
        path: relPath,
        duration: v.duration,
        promptSent: v.promptSent,
        pacingAdjusted: v.pacingAdjusted,
      },
      createdAt: v.timestamp || now,
      startedAt: v.timestamp || now,
      completedAt: v.timestamp || now,
    }));

    videoItemIds[shotNum] = id;
    prevId = id;
  }
}

// ---------------------------------------------------------------------------
// Main: scan output/runs/ and migrate
// ---------------------------------------------------------------------------

function loadExistingRunRecords(): QueueRunRecord[] {
  if (!existsSync(RUN_DB_PATH)) return [];
  try {
    return JSON.parse(readFileSync(RUN_DB_PATH, 'utf-8')) as QueueRunRecord[];
  } catch {
    return [];
  }
}

function main(): void {
  console.log('=== migrate-runs: converting old pipeline runs to queue format ===');
  console.log(`Scanning: ${RUN_OUTPUT_ROOT}`);

  if (!existsSync(RUN_OUTPUT_ROOT)) {
    console.log('No output/runs/ directory found. Nothing to migrate.');
    return;
  }

  const entries = readdirSync(RUN_OUTPUT_ROOT);
  const existingRecords = loadExistingRunRecords();
  const existingIds = new Set(existingRecords.map(r => r.id));
  let migratedCount = 0;

  for (const entry of entries) {
    const runDir = join(RUN_OUTPUT_ROOT, entry);
    if (!statSync(runDir).isDirectory()) continue;

    const record = migrateRun(runDir);
    if (record) {
      if (!existingIds.has(record.id)) {
        existingRecords.push(record);
        existingIds.add(record.id);
      }
      migratedCount++;
    }
  }

  if (migratedCount > 0) {
    // Sort by createdAt descending (newest first)
    existingRecords.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    mkdirSync(RUN_DB_DIR, { recursive: true });
    writeFileSync(RUN_DB_PATH, JSON.stringify(existingRecords, null, 2));
    console.log(`\nWrote ${RUN_DB_PATH}`);
  }

  console.log(`\nDone. Migrated ${migratedCount} run(s).`);
}

main();
