import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QueueManager } from '../queue/queue-manager.js';
import type { RunManager } from '../queue/run-manager.js';
import type { Shot, StoryAnalysis } from '../types.js';
import { ChatSessionStore } from './session-store.js';
import { runFramePreview, type ShotEditorContext } from './agents/shot-editor.js';
import {
  recordPreviewImageCost,
  recordPreviewVideoCost,
} from './preview-cost.js';

function makeShot(overrides: Partial<Shot> = {}): Shot {
  return {
    shotNumber: 1, sceneNumber: 1, shotInScene: 1,
    durationSeconds: 4, shotType: 'first_last_frame', composition: 'medium_shot',
    startFramePrompt: 'shot 1', dialogue: '', speaker: '', soundEffects: '',
    cameraDirection: '', videoPrompt: '',
    charactersPresent: [], objectsPresent: [], location: 'Studio',
    continuousFromPrevious: false,
    ...overrides,
  };
}

function makeAnalysis(shot: Shot): StoryAnalysis {
  return {
    title: 'Test', artStyle: 'cinematic',
    characters: [], locations: [{ name: 'Studio', visualDescription: 'A sound stage' }], objects: [],
    scenes: [{
      sceneNumber: 1, title: 'Scene 1', narrativeSummary: '',
      charactersPresent: [], location: 'Studio', estimatedDurationSeconds: 4,
      shots: [shot], transition: 'cut',
    }],
  };
}

function makeQm(dir: string): QueueManager {
  const qm = new QueueManager('run-1', '(test)', dir);
  qm.setStoryAnalysis(makeAnalysis(makeShot()));
  qm.setAssetLibrary({ characterImages: {}, locationImages: {}, objectImages: {} });
  return qm;
}

function testRecordPreviewImageCostGrok(): void {
  const dir = mkdtempSync(join(tmpdir(), 'preview-cost-grok-'));
  const qm = makeQm(dir);
  const rm = new EventEmitter() as unknown as RunManager;
  let emitted = 0;
  rm.on('cost:updated', () => { emitted++; });
  recordPreviewImageCost(qm, rm, 'run-1', 'shot', '1-1', 'frame', 'grok');
  const entries = qm.getCostEntries();
  assert.equal(entries.length, 1);
  const [e] = entries;
  assert.equal(e.category, 'image');
  assert.equal(e.model, 'grok-imagine-image');
  assert.ok(e.itemKey.startsWith('preview:frame:'), `itemKey was ${e.itemKey}`);
  assert.ok(e.itemId.startsWith('preview-'));
  assert.ok(e.costUsd > 0, 'grok image cost must be positive');
  assert.equal(emitted, 1);
  console.log('  ✓ recordPreviewImageCost(grok) records one image entry, emits cost:updated');
}

function testRecordPreviewVideoCostGrok(): void {
  const dir = mkdtempSync(join(tmpdir(), 'preview-cost-vgrok-'));
  const qm = makeQm(dir);
  const rm = new EventEmitter() as unknown as RunManager;
  recordPreviewVideoCost(qm, rm, 'run-1', 'shot', '1-1', 'video', 'grok', 4.0);
  const entries = qm.getCostEntries();
  assert.equal(entries.length, 1);
  const [e] = entries;
  assert.equal(e.category, 'video');
  assert.equal(e.model, 'grok-imagine-video');
  assert.equal(e.durationSeconds, 4.0);
  assert.ok(e.itemKey.startsWith('preview:video:'));
  assert.ok(e.costUsd > 0, 'grok video cost must be positive');
  console.log('  ✓ recordPreviewVideoCost(grok, 4s) records one video entry with durationSeconds');
}

function testRecordPreviewVideoCostLtxIsZero(): void {
  const dir = mkdtempSync(join(tmpdir(), 'preview-cost-ltx-'));
  const qm = makeQm(dir);
  const rm = new EventEmitter() as unknown as RunManager;
  recordPreviewVideoCost(qm, rm, 'run-1', 'shot', '1-1', 'video', 'ltx-full', 4.0);
  const [e] = qm.getCostEntries();
  assert.equal(e.model, 'ltx');
  assert.equal(e.costUsd, 0, 'ltx is self-hosted; cost must be zero');
  console.log('  ✓ recordPreviewVideoCost(ltx-full) records costUsd === 0');
}

async function testAutoChainRecordsBothEntries(): Promise<void> {
  // Mirrors previewVideo's auto-refresh path: runFramePreview records the
  // frame cost, then the video helper is called separately for the video
  // cost. Both entries must end up in the ledger.
  const dir = mkdtempSync(join(tmpdir(), 'preview-cost-chain-'));
  const qm = makeQm(dir);
  const rm = new EventEmitter() as unknown as RunManager;
  const ctx: ShotEditorContext = {
    runId: 'run-1', sceneNumber: 1, shotInScene: 1, scopeKey: '1-1',
    store: new ChatSessionStore(dir), runManager: rm, queueManager: qm,
  };
  const stubGenerate = (async (params: { outputDir: string }) =>
    ({ shotNumber: 1, startPath: join(params.outputDir, 'frames/stub.png') })
  ) as unknown as Parameters<typeof runFramePreview>[1] extends infer _ ? typeof import('../tools/generate-frame.js').generateFrame : never;
  const r = await runFramePreview(ctx, { generate: stubGenerate });
  assert.equal(r.ok, true);
  recordPreviewVideoCost(qm, rm, 'run-1', 'shot', '1-1', 'video', 'grok', 4.0);

  const entries = qm.getCostEntries();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].category, 'image');
  assert.ok(entries[0].itemKey.startsWith('preview:frame:'));
  assert.equal(entries[1].category, 'video');
  assert.ok(entries[1].itemKey.startsWith('preview:video:'));
  const summary = qm.getCostSummary();
  assert.equal(summary.entryCount, 2);
  assert.ok((summary.byCategory.image ?? 0) > 0);
  assert.ok((summary.byCategory.video ?? 0) > 0);
  console.log('  ✓ auto-chain (frame + video) records BOTH cost entries');
}

async function main(): Promise<void> {
  console.log('Chat preview cost tracking:');
  testRecordPreviewImageCostGrok();
  testRecordPreviewVideoCostGrok();
  testRecordPreviewVideoCostLtxIsZero();
  await testAutoChainRecordsBothEntries();
  console.log('\nAll tests passed ✓');
}

main().catch((err) => { console.error(err); process.exit(1); });
