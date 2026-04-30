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
import { shotExtendVideoInputsHash, shotFrameInputsHash, shotVideoInputsHash } from './preview-hash.js';
import { isShotDraftEmpty, type ShotDraft } from './types.js';

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

interface RedoSpy { calls: number; redoneItemKeys: string[] }

function makeStubRunManager(qm: QueueManager, runId: string, spy: RedoSpy): RunManager {
  const stub = {
    getQueueManager(_id: string): QueueManager | undefined { return qm; },
    getRun(_id: string) { return { id: runId, outputDir: qm.getState().outputDir }; },
    redoItem(_runId: string, itemId: string, newInputs?: Record<string, unknown>): WorkItem | undefined {
      spy.calls += 1;
      const target = qm.getItem(itemId);
      if (target) spy.redoneItemKeys.push(target.itemKey);
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

  const spy: RedoSpy = { calls: 0, redoneItemKeys: [] };
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

  // Hash captured against the OLD shot, then user edits a frame-affecting
  // field — the recomputed hash post-mutation will differ, so promotion must
  // abort and the frame redo must run as the fallback.
  const stalePreviewArt = {
    sandboxPath: sandboxRel,
    createdAt: new Date().toISOString(),
    inputsHash: shotFrameInputsHash({ artStyle: 'cinematic', shot }),
  };
  const draft: ShotDraft = {
    shotFields: { composition: 'wide_shot' },
    pendingImageReplacements: [],
    previewArtifacts: { frame: stalePreviewArt },
  };

  const spy: RedoSpy = { calls: 0, redoneItemKeys: [] };
  const runManager = makeStubRunManager(qm, 'run-1', spy);
  const result = await applyShotDraft(runManager, 'run-1', 1, 1, draft);

  assert.equal(result.ok, true);
  assert.deepEqual(result.promoted, [], 'no promotion when hash is stale');
  assert.equal(spy.calls, 1, 'redoItem should be called as the fallback path');
  console.log('  ✓ stale preview hash falls back to redoItem');
}

async function testVideoOnlyFieldWithFreshVideoPreviewPromotesNoRedo(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'apply-video-promote-'));
  const qm = new QueueManager('run-1', '(test)', dir);
  // Canonical analysis already reflects the post-edit shot (durationSeconds=6),
  // matching what the user previewed before applying.
  const editedShot: Shot = { ...makeShot(), durationSeconds: 6 };
  qm.setStoryAnalysis(makeAnalysis(editedShot));
  // Active video item ready to be superseded by promotion.
  qm.addItem({
    type: 'generate_video', queue: 'video', itemKey: 'video:scene:1:shot:1',
    inputs: { shot: editedShot, startFramePath: 'frames/1.png' },
  });

  const sandboxRel = 'chat-sandbox/shot/1-1/preview.mp4';
  mkdirSync(join(dir, 'chat-sandbox/shot/1-1'), { recursive: true });
  writeFileSync(join(dir, sandboxRel), 'fake-video-bytes');

  const draft: ShotDraft = {
    shotFields: { durationSeconds: 6 },
    pendingImageReplacements: [],
    previewArtifacts: {
      video: {
        sandboxPath: sandboxRel,
        createdAt: new Date().toISOString(),
        inputsHash: shotVideoInputsHash({ artStyle: 'cinematic', shot: editedShot }),
      },
    },
  };

  const spy: RedoSpy = { calls: 0, redoneItemKeys: [] };
  const runManager = makeStubRunManager(qm, 'run-1', spy);
  const result = await applyShotDraft(runManager, 'run-1', 1, 1, draft);

  assert.equal(result.ok, true);
  assert.deepEqual(result.promoted, ['video'], 'video should have been promoted');
  assert.equal(spy.calls, 0, 'video-only field with fresh video preview must not call redoItem');
  console.log('  ✓ video-only field + fresh video preview promotes; no redoItem');
}

async function testVideoOnlyFieldWithoutPreviewRedosVideoOnly(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'apply-video-redo-'));
  const qm = new QueueManager('run-1', '(test)', dir);
  const shot = makeShot();
  qm.setStoryAnalysis(makeAnalysis(shot));
  // Both frame and video items active. Only the video should be redone.
  qm.addItem({ type: 'generate_frame', queue: 'image', itemKey: 'frame:scene:1:shot:1', inputs: { shot } });
  qm.addItem({
    type: 'generate_video', queue: 'video', itemKey: 'video:scene:1:shot:1',
    inputs: { shot, startFramePath: 'frames/1.png' },
  });

  const draft: ShotDraft = {
    shotFields: { durationSeconds: 7 },
    pendingImageReplacements: [],
  };

  const spy: RedoSpy = { calls: 0, redoneItemKeys: [] };
  const runManager = makeStubRunManager(qm, 'run-1', spy);
  const result = await applyShotDraft(runManager, 'run-1', 1, 1, draft);

  assert.equal(result.ok, true);
  assert.deepEqual(result.promoted, [], 'no promotion when no preview is provided');
  assert.equal(spy.calls, 1, 'exactly one redoItem call expected');
  assert.deepEqual(spy.redoneItemKeys, ['video:scene:1:shot:1'], 'only the video item should be redone');
  console.log('  ✓ video-only field without preview redoes the video item only');
}

async function testFrameAffectingFieldRedosFrame(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'apply-frame-redo-'));
  const qm = new QueueManager('run-1', '(test)', dir);
  const shot = makeShot();
  qm.setStoryAnalysis(makeAnalysis(shot));
  qm.addItem({ type: 'generate_frame', queue: 'image', itemKey: 'frame:scene:1:shot:1', inputs: { shot } });
  qm.addItem({
    type: 'generate_video', queue: 'video', itemKey: 'video:scene:1:shot:1',
    inputs: { shot, startFramePath: 'frames/1.png' },
  });

  const draft: ShotDraft = {
    shotFields: { composition: 'wide_shot' },
    pendingImageReplacements: [],
  };

  const spy: RedoSpy = { calls: 0, redoneItemKeys: [] };
  const runManager = makeStubRunManager(qm, 'run-1', spy);
  const result = await applyShotDraft(runManager, 'run-1', 1, 1, draft);

  assert.equal(result.ok, true);
  assert.deepEqual(result.promoted, [], 'no promotion when no preview is provided');
  assert.equal(spy.calls, 1, 'exactly one redoItem call expected on the frame');
  assert.deepEqual(spy.redoneItemKeys, ['frame:scene:1:shot:1'], 'frame item must be the redo target');
  console.log('  ✓ frame-affecting field redoes the frame');
}

async function testPreviewOnlyDraftPromotesWithoutFieldEdits(): Promise<void> {
  // Reproduces the user's exact path: agent calls previewVideo, never calls
  // proposeApply, and never edits any fields. The user clicks Apply directly.
  // The draft has only previewArtifacts populated. Apply must run the smart
  // promote path, NOT short-circuit as a no-op and NOT call redoItem.
  const dir = mkdtempSync(join(tmpdir(), 'apply-preview-only-'));
  const qm = new QueueManager('run-1', '(test)', dir);
  const shot = makeShot();
  qm.setStoryAnalysis(makeAnalysis(shot));
  qm.addItem({
    type: 'generate_video', queue: 'video', itemKey: 'video:scene:1:shot:1',
    inputs: { shot, startFramePath: 'frames/1.png' },
  });

  const sandboxRel = 'chat-sandbox/shot/1-1/preview.mp4';
  mkdirSync(join(dir, 'chat-sandbox/shot/1-1'), { recursive: true });
  writeFileSync(join(dir, sandboxRel), 'fake-video-bytes');

  const draft: ShotDraft = {
    shotFields: {},
    pendingImageReplacements: [],
    previewArtifacts: {
      video: {
        sandboxPath: sandboxRel,
        createdAt: new Date().toISOString(),
        inputsHash: shotVideoInputsHash({ artStyle: 'cinematic', shot }),
      },
    },
  };

  // Route-handler gate: a draft carrying only a fresh preview must NOT be
  // treated as empty, otherwise handleChatApply short-circuits and the smart
  // promote path is never reached.
  assert.equal(
    isShotDraftEmpty(draft), false,
    'preview-only draft must not be considered empty (else apply short-circuits)',
  );

  const spy: RedoSpy = { calls: 0, redoneItemKeys: [] };
  const runManager = makeStubRunManager(qm, 'run-1', spy);
  const result = await applyShotDraft(runManager, 'run-1', 1, 1, draft);

  assert.equal(result.ok, true);
  assert.deepEqual(result.promoted, ['video'], 'video should have been promoted');
  assert.equal(spy.calls, 0, 'redoItem must not be called for preview-only apply');
  assert.equal(result.regeneratedItemIds.length, 1);

  const promotedId = result.regeneratedItemIds[0];
  const promoted = qm.getItem(promotedId);
  assert.ok(promoted);
  assert.equal(promoted.status, 'completed');
  const canonicalAbs = join(dir, promoted.outputs.path as string);
  assert.ok(existsSync(canonicalAbs), 'canonical video file should exist on disk');
  assert.equal(readFileSync(canonicalAbs, 'utf-8'), 'fake-video-bytes');
  console.log('  ✓ preview-only draft (no field edits, no proposeApply) promotes; no redoItem');
}

async function testFieldEditsThenVideoPreviewPromotesNoRedo(): Promise<void> {
  // Reproduces run 6695c2fc / shot 1-10. Agent staged several updateShotFields
  // (durationSeconds + startFramePrompt + videoPrompt + soundEffects +
  // cameraDirection + dialogue) and finished with previewVideo. The user
  // never asked for a frame regen, so no previewFrame ran. Apply must promote
  // the video and not trigger a video regen via the frame-redo cascade.
  const dir = mkdtempSync(join(tmpdir(), 'apply-fields-then-preview-'));
  const qm = new QueueManager('run-1', '(test)', dir);
  const liveShot = makeShot();
  qm.setStoryAnalysis(makeAnalysis(liveShot));
  qm.addItem({ type: 'generate_frame', queue: 'image', itemKey: 'frame:scene:1:shot:1', inputs: { shot: liveShot } });
  qm.addItem({
    type: 'generate_video', queue: 'video', itemKey: 'video:scene:1:shot:1',
    inputs: { shot: liveShot, startFramePath: 'frames/1.png' },
  });

  // Accumulated draft fields, including the frame-affecting startFramePrompt.
  const draftFields: Partial<Shot> = {
    durationSeconds: 12,
    startFramePrompt: 'Medium shot inside the cab, door closing',
    videoPrompt: 'Frank slams door, camera sweeps to windshield, starts the truck',
    soundEffects: 'Door slam, engine roar',
    cameraDirection: 'Side then sweep to front windshield',
    dialogue: "Don't hang up, Emma. I'm calling the police on another phone.",
  };
  // previewVideo's hash uses the merged shot (live + draft), exactly as
  // shot-editor.ts builds it via mergedShot().
  const mergedShot = { ...liveShot, ...draftFields } as Shot;
  const previewHash = shotVideoInputsHash({ artStyle: 'cinematic', shot: mergedShot });

  const sandboxRel = 'chat-sandbox/shot/1-1/preview.mp4';
  mkdirSync(join(dir, 'chat-sandbox/shot/1-1'), { recursive: true });
  writeFileSync(join(dir, sandboxRel), 'fake-video-bytes');

  const draft: ShotDraft = {
    shotFields: draftFields,
    pendingImageReplacements: [],
    previewArtifacts: {
      video: { sandboxPath: sandboxRel, createdAt: new Date().toISOString(), inputsHash: previewHash },
    },
  };

  const spy: RedoSpy = { calls: 0, redoneItemKeys: [] };
  const runManager = makeStubRunManager(qm, 'run-1', spy);
  const result = await applyShotDraft(runManager, 'run-1', 1, 1, draft);

  assert.equal(result.ok, true);
  assert.deepEqual(result.promoted, ['video'], 'video should have been promoted');
  assert.equal(spy.calls, 0,
    `redoItem must not run when video preview is promoted (got redos on: ${spy.redoneItemKeys.join(', ') || '<none>'})`);
  console.log('  ✓ field edits + fresh video preview promotes; no redoItem cascade');
}

async function testExtendPreviewPromotionUpdatesShotDuration(): Promise<void> {
  // Wave 2.P: an extend-mode video preview is promoted, and apply.ts
  // re-probes the canonical clip to set shot.durationSeconds to the actual
  // returned duration. The hash check uses sourceVideoSha + continuationPrompt,
  // not the shot itself, so promotion succeeds even when durationSeconds
  // hasn't been staged on the draft.
  const dir = mkdtempSync(join(tmpdir(), 'apply-extend-promote-'));
  const qm = new QueueManager('run-1', '(test)', dir);
  const shot = makeShot(); // durationSeconds=4 in canonical state
  qm.setStoryAnalysis(makeAnalysis(shot));
  qm.addItem({
    type: 'generate_video', queue: 'video', itemKey: 'video:scene:1:shot:1',
    inputs: { shot, startFramePath: 'frames/1.png' },
  });

  const sandboxRel = 'chat-sandbox/shot/1-1/extend.mp4';
  mkdirSync(join(dir, 'chat-sandbox/shot/1-1'), { recursive: true });
  writeFileSync(join(dir, sandboxRel), 'fake-extended-video-bytes');

  const sourceVideoSha = 'deadbeef'.repeat(8);
  const continuationPrompt = 'He walks to the door and opens it slowly.';
  const draft: ShotDraft = {
    shotFields: {},
    pendingImageReplacements: [],
    previewArtifacts: {
      video: {
        sandboxPath: sandboxRel,
        createdAt: new Date().toISOString(),
        inputsHash: shotExtendVideoInputsHash({ sourceVideoSha, continuationPrompt }),
        mode: 'extend',
        extendMeta: { sourceVideoSha, continuationPrompt },
      },
    },
  };

  // Stub probe — production would call ffprobe; tests must not touch the
  // filesystem with a binary they don't control.
  let probeCalls = 0;
  const probedDuration = 14;
  const probeStub = async (_path: string): Promise<number> => {
    probeCalls += 1;
    return probedDuration;
  };

  const spy: RedoSpy = { calls: 0, redoneItemKeys: [] };
  const runManager = makeStubRunManager(qm, 'run-1', spy);
  const result = await applyShotDraft(
    runManager, 'run-1', 1, 1, draft, { probeDuration: probeStub },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.promoted, ['video'], 'extend video should have been promoted');
  assert.equal(spy.calls, 0, 'no redoItem call when extend preview promotes');
  assert.equal(probeCalls, 1, 'probeDuration must run exactly once for extend mode');

  const updatedShot = qm.getState().storyAnalysis!.scenes[0].shots[0];
  assert.equal(updatedShot.durationSeconds, probedDuration,
    'shot.durationSeconds must be updated to the probed duration');

  // Idempotency: re-applying the same draft against the now-promoted state
  // should still find the active video item and re-promote (hash check uses
  // sourceVideoSha + prompt, not durationSeconds, so it stays valid).
  const spy2: RedoSpy = { calls: 0, redoneItemKeys: [] };
  const runManager2 = makeStubRunManager(qm, 'run-1', spy2);
  const result2 = await applyShotDraft(
    runManager2, 'run-1', 1, 1, draft, { probeDuration: probeStub },
  );
  assert.equal(result2.ok, true);
  assert.deepEqual(result2.promoted, ['video'], 're-promotion stays a no-op for the cascade (no redos)');
  assert.equal(spy2.calls, 0, 're-promote must not trigger any redoItem');

  console.log('  ✓ extend-mode video preview promotes and updates shot.durationSeconds via probe');
}

async function main(): Promise<void> {
  console.log('Apply promotion tests:');
  await testPromotionTakesOverWhenPreviewIsFresh();
  await testStaleHashFallsBackToRedo();
  await testVideoOnlyFieldWithFreshVideoPreviewPromotesNoRedo();
  await testVideoOnlyFieldWithoutPreviewRedosVideoOnly();
  await testFrameAffectingFieldRedosFrame();
  await testPreviewOnlyDraftPromotesWithoutFieldEdits();
  await testFieldEditsThenVideoPreviewPromotesNoRedo();
  await testExtendPreviewPromotionUpdatesShotDuration();
  console.log('\nAll tests passed ✓');
}

main().catch((err) => { console.error(err); process.exit(1); });
