import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QueueManager } from '../queue/queue-manager.js';
import { seedDownstream } from '../queue/seed-downstream.js';
import type { WorkItem } from '../queue/types.js';
import type { RunManager } from '../queue/run-manager.js';
import type { Shot, StoryAnalysis } from '../types.js';
import { applyShotDraft } from './apply.js';
import { shotFrameInputsHash } from './preview-hash.js';
import type { ShotDraft } from './types.js';

function makeShot(): Shot {
  return {
    shotNumber: 1, sceneNumber: 1, shotInScene: 1,
    durationSeconds: 4, shotType: 'first_last_frame', composition: 'medium_shot',
    startFramePrompt: 'shot 1', dialogue: '', speaker: '', soundEffects: '',
    cameraDirection: '', videoPrompt: '',
    charactersPresent: [], objectsPresent: [], location: 'Studio',
    continuousFromPrevious: false,
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

interface RedoSpy { calls: number }

function makeStubRunManager(qm: QueueManager, runId: string, spy: RedoSpy): RunManager {
  const stub = {
    getQueueManager(_id: string): QueueManager | undefined { return qm; },
    getRun(_id: string) { return { id: runId, outputDir: qm.getState().outputDir }; },
    redoItem(_runId: string, itemId: string, newInputs?: Record<string, unknown>): WorkItem | undefined {
      spy.calls += 1;
      const newItem = qm.redoItem(itemId, newInputs);
      qm.save();
      return newItem;
    },
    promoteCompletedItem(opts: {
      runId: string; itemKey: string; outputs: Record<string, unknown>;
      supersedeId?: string; inputsOverride?: Record<string, unknown>;
    }): WorkItem | undefined {
      const { newItem } = qm.promoteCompleted({
        itemKey: opts.itemKey, outputs: opts.outputs,
        supersedeId: opts.supersedeId, inputsOverride: opts.inputsOverride,
      });
      seedDownstream(qm, newItem, opts.outputs);
      qm.save();
      return newItem;
    },
    async resumeRun(_id: string): Promise<boolean> { return true; },
  };
  return stub as unknown as RunManager;
}

async function testPromotionTakesOverWhenPreviewIsFresh(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'apply-promotion-'));
  const qm = new QueueManager('run-1', '(test)', dir);
  const shot = makeShot();
  qm.setStoryAnalysis(makeAnalysis(shot));
  qm.addItem({ type: 'generate_frame', queue: 'image', itemKey: 'frame:scene:1:shot:1', inputs: { shot } });

  // Sandbox preview file the agent would have produced via previewFrame.
  const sandboxRel = 'chat-sandbox/shot/1-1/preview.png';
  mkdirSync(join(dir, 'chat-sandbox/shot/1-1'), { recursive: true });
  writeFileSync(join(dir, sandboxRel), 'fake-preview-bytes');

  const draft: ShotDraft = {
    shotFields: {},
    pendingImageReplacements: [],
    previewArtifacts: {
      frame: {
        sandboxPath: sandboxRel,
        createdAt: new Date().toISOString(),
        inputsHash: shotFrameInputsHash({ artStyle: 'cinematic', shot }),
      },
    },
  };

  const spy: RedoSpy = { calls: 0 };
  const runManager = makeStubRunManager(qm, 'run-1', spy);
  const result = await applyShotDraft(runManager, 'run-1', 1, 1, draft);

  assert.equal(result.ok, true);
  assert.deepEqual(result.promoted, ['frame'], 'frame should have been promoted');
  assert.equal(spy.calls, 0, 'redoItem must not be called when promotion succeeds');
  assert.equal(result.regeneratedItemIds.length, 1);

  const promotedId = result.regeneratedItemIds[0];
  const promoted = qm.getItem(promotedId);
  assert.ok(promoted);
  assert.equal(promoted.status, 'completed');
  assert.equal(typeof promoted.outputs.startPath, 'string');
  const canonicalAbs = join(dir, promoted.outputs.startPath as string);
  assert.ok(existsSync(canonicalAbs), 'canonical frame file should exist on disk');
  assert.equal(readFileSync(canonicalAbs, 'utf-8'), 'fake-preview-bytes');
  console.log('  ✓ fresh preview is promoted; redoItem is not called');
}

async function testStaleHashFallsBackToRedo(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'apply-stale-'));
  const qm = new QueueManager('run-1', '(test)', dir);
  const shot = makeShot();
  qm.setStoryAnalysis(makeAnalysis(shot));
  qm.addItem({ type: 'generate_frame', queue: 'image', itemKey: 'frame:scene:1:shot:1', inputs: { shot } });

  const sandboxRel = 'chat-sandbox/shot/1-1/preview.png';
  mkdirSync(join(dir, 'chat-sandbox/shot/1-1'), { recursive: true });
  writeFileSync(join(dir, sandboxRel), 'preview');

  // Hash captured against the OLD shot, then user edits videoPrompt — the
  // recomputed hash post-mutation will differ, so promotion must abort.
  const stalePreviewArt = {
    sandboxPath: sandboxRel,
    createdAt: new Date().toISOString(),
    inputsHash: shotFrameInputsHash({ artStyle: 'cinematic', shot }),
  };
  const draft: ShotDraft = {
    shotFields: { videoPrompt: 'changed after preview' },
    pendingImageReplacements: [],
    previewArtifacts: { frame: stalePreviewArt },
  };

  const spy: RedoSpy = { calls: 0 };
  const runManager = makeStubRunManager(qm, 'run-1', spy);
  const result = await applyShotDraft(runManager, 'run-1', 1, 1, draft);

  assert.equal(result.ok, true);
  assert.deepEqual(result.promoted, [], 'no promotion when hash is stale');
  assert.equal(spy.calls, 1, 'redoItem should be called as the fallback path');
  console.log('  ✓ stale preview hash falls back to redoItem');
}

async function main(): Promise<void> {
  console.log('Apply promotion tests:');
  await testPromotionTakesOverWhenPreviewIsFresh();
  await testStaleHashFallsBackToRedo();
  console.log('\nAll tests passed ✓');
}

main().catch((err) => { console.error(err); process.exit(1); });
