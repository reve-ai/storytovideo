import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QueueManager } from './queue-manager.js';
import { QueueProcessor } from './processors.js';
import type { Shot, StoryAnalysis } from '../types.js';

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

function makeQueueManager(): QueueManager {
  const dir = mkdtempSync(join(tmpdir(), 'queue-state-'));
  return new QueueManager('run-1', '(test)', dir);
}

function makeShot(shotNumber: number, shotInScene: number, continuousFromPrevious = false): Shot {
  return {
    shotNumber,
    sceneNumber: 1,
    shotInScene,
    durationSeconds: 4,
    shotType: 'first_last_frame',
    composition: 'medium_shot',
    startFramePrompt: `shot ${shotNumber}`,
    actionPrompt: `action ${shotNumber}`,
    dialogue: '',
    speaker: '',
    soundEffects: '',
    cameraDirection: '',
    videoPrompt: '',
    charactersPresent: [],
    objectsPresent: [],
    location: 'Studio',
    continuousFromPrevious,
  };
}

function makeAnalysis(shots: Shot[]): StoryAnalysis {
  return {
    title: 'Test Story',
    artStyle: 'cinematic',
    characters: [],
    locations: [{ name: 'Studio', visualDescription: 'A sound stage' }],
    objects: [],
    scenes: [{
      sceneNumber: 1,
      title: 'Scene 1',
      narrativeSummary: 'Test scene',
      charactersPresent: [],
      location: 'Studio',
      estimatedDurationSeconds: 12,
      shots,
      transition: 'cut',
    }],
  };
}

function testClaimNextReady(): void {
  const qm = makeQueueManager();
  qm.addItem({ type: 'artifact', queue: 'llm', itemKey: 'artifact:a' });

  const claimed = qm.claimNextReady('llm');

  assert.ok(claimed);
  assert.equal(claimed.status, 'in_progress');
  assert.equal(qm.claimNextReady('llm'), null);
  console.log('  ✓ claimNextReady claims only once');
}

function testReadSnapshotsAreIsolated(): void {
  const qm = makeQueueManager();
  const item = qm.addItem({
    type: 'artifact',
    queue: 'llm',
    itemKey: 'artifact:a',
    inputs: { nested: { prompt: 'hello' } },
  });

  const state = qm.getState();
  const snapshot = qm.getItem(item.id);
  assert.ok(snapshot);

  assert.throws(() => {
    state.workItems[0].status = 'completed';
  }, /read only|frozen|extensible|assign/i);
  assert.throws(() => {
    (snapshot!.inputs.nested as { prompt: string }).prompt = 'changed';
  }, /read only|frozen|extensible|assign/i);

  assert.equal(qm.getItem(item.id)?.status, 'pending');
  assert.equal(((qm.getItem(item.id)?.inputs.nested as { prompt: string }).prompt), 'hello');
  console.log('  ✓ read APIs return frozen snapshots');
}

function testCancelledItemsStayCancelled(): void {
  const qm = makeQueueManager();
  const item = qm.addItem({ type: 'artifact', queue: 'llm', itemKey: 'artifact:a' });
  assert.equal(qm.markInProgress(item.id), true);
  assert.equal(qm.cancelItem(item.id), true);

  assert.equal(qm.markCompleted(item.id, { ok: true }), false);
  assert.equal(qm.markFailed(item.id, 'boom'), false);
  assert.equal(qm.requeueForRetry(item.id), false);
  assert.equal(qm.getItem(item.id)?.status, 'cancelled');
  console.log('  ✓ cancelled items cannot be resurrected');
}

function testRedoRejectsInProgress(): void {
  const qm = makeQueueManager();
  const item = qm.addItem({ type: 'artifact', queue: 'llm', itemKey: 'artifact:a' });
  qm.markInProgress(item.id);

  assert.throws(() => qm.redoItem(item.id), /in_progress/);
  console.log('  ✓ redo rejects in-progress items');
}

function testPendingOnlyMutations(): void {
  const qm = makeQueueManager();
  const item = qm.addItem({
    type: 'artifact',
    queue: 'llm',
    itemKey: 'artifact:a',
    inputs: { a: 1 },
  });

  qm.updateItemInputs(item.id, { b: 2 });
  qm.setItemPriority(item.id, 'high');
  qm.markInProgress(item.id);

  assert.throws(() => qm.updateItemInputs(item.id, { c: 3 }), /expected 'pending'/);
  assert.throws(() => qm.setItemPriority(item.id, 'normal'), /expected 'pending'/);
  console.log('  ✓ edit and priority updates re-check pending status');
}

function testAnalyzeMutationsAreGuarded(): void {
  const qm = makeQueueManager();
  const item = qm.addItem({ type: 'analyze_video', queue: 'llm', itemKey: 'analyze:1' });
  qm.markInProgress(item.id);

  assert.throws(() => qm.deleteAnalyzeItems(), /in progress/);
  qm.cancelItem(item.id);
  assert.equal(qm.deleteAnalyzeItems(), 1);

  const reviewed = qm.addItem({ type: 'analyze_video', queue: 'llm', itemKey: 'analyze:2' });
  qm.setReviewStatus(reviewed.id, 'accepted');
  assert.throws(() => qm.setReviewStatus(reviewed.id, 'rejected'), /already set/);
  console.log('  ✓ analyze-item deletion and review decisions are guarded');
}

function testRedoDoesNotCascadeOutputDerivedItemsFromFrame(): void {
  const qm = makeQueueManager();
  const frame = qm.addItem({
    type: 'generate_frame',
    queue: 'image',
    itemKey: 'frame:scene:1:shot:1',
    inputs: { prompt: 'frame prompt' },
  });
  const video = qm.addItem({
    type: 'generate_video',
    queue: 'video',
    itemKey: 'video:scene:1:shot:1',
    dependencies: [frame.id],
    inputs: { shot: { sceneNumber: 1, shotInScene: 1 }, startFramePath: 'frames/original.png' },
  });
  const analyze = qm.addItem({
    type: 'analyze_video',
    queue: 'llm',
    itemKey: 'analyze_video:scene:1:shot:1',
    dependencies: [video.id],
    inputs: { videoPath: 'videos/original.mp4' },
  });

  qm.redoItem(frame.id);

  const videoItems = qm.getItemsByKey('video:scene:1:shot:1');
  assert.equal(videoItems.length, 1);
  assert.equal(videoItems[0].id, video.id);
  assert.equal(videoItems[0].status, 'superseded');

  const analyzeItems = qm.getItemsByKey('analyze_video:scene:1:shot:1');
  assert.equal(analyzeItems.length, 1);
  assert.equal(analyzeItems[0].id, analyze.id);
  assert.equal(analyzeItems[0].status, 'superseded');
  assert.equal(
    videoItems.some(item => item.status !== 'superseded' && item.status !== 'cancelled'),
    false
  );
  assert.equal(
    analyzeItems.some(item => item.status !== 'superseded' && item.status !== 'cancelled'),
    false
  );
  console.log('  ✓ frame redo supersedes stale video and analyze items without cascading replacements');
}

function testRedoDoesNotCascadeAnalyzeVideo(): void {
  const qm = makeQueueManager();
  const video = qm.addItem({
    type: 'generate_video',
    queue: 'video',
    itemKey: 'video:scene:1:shot:1',
    inputs: { shot: { sceneNumber: 1, shotInScene: 1 }, startFramePath: 'frames/original.png' },
  });
  const analyze = qm.addItem({
    type: 'analyze_video',
    queue: 'llm',
    itemKey: 'analyze_video:scene:1:shot:1',
    dependencies: [video.id],
    inputs: { videoPath: 'videos/original.mp4' },
  });

  qm.redoItem(video.id);

  const analyzeItems = qm.getItemsByKey('analyze_video:scene:1:shot:1');
  assert.equal(analyzeItems.length, 1);
  assert.equal(analyzeItems[0].id, analyze.id);
  assert.equal(analyzeItems[0].status, 'superseded');
  assert.equal(
    analyzeItems.some(item => item.status !== 'superseded' && item.status !== 'cancelled'),
    false
  );
  console.log('  ✓ redo supersedes analyze_video without cascading a stale replacement');
}

function testRedoVideoRemapsKeyBasedContinuityDependency(): void {
  const qm = makeQueueManager();
  const shot1 = makeShot(1, 1, false);
  const shot2 = makeShot(2, 2, true);

  const video1 = qm.addItem({
    type: 'generate_video',
    queue: 'video',
    itemKey: 'video:scene:1:shot:1',
    inputs: { shot: shot1, startFramePath: 'frames/1.png' },
  });
  qm.addItem({
    type: 'generate_frame',
    queue: 'image',
    itemKey: 'frame:scene:1:shot:2',
    dependencies: [video1.itemKey],
    inputs: { shot: shot2 },
  });

  const newVideo1 = qm.redoItem(video1.id);

  const frame2Items = qm.getItemsByKey('frame:scene:1:shot:2');
  const activeFrame2 = frame2Items.find(item => item.status !== 'superseded' && item.status !== 'cancelled');
  assert.equal(frame2Items.length, 2);
  assert.ok(activeFrame2);
  assert.deepEqual(activeFrame2.dependencies, [newVideo1.id]);
  console.log('  ✓ video redo remaps key-based continuity dependencies to the new video id');
}

function testFrameRedoRebuildsContinuityChainAfterReplacementVideosComplete(): void {
  const qm = makeQueueManager();
  const shot1 = makeShot(1, 1, false);
  const shot2 = makeShot(2, 2, true);
  const shot3 = makeShot(3, 3, true);
  qm.setStoryAnalysis(makeAnalysis([shot1, shot2, shot3]));

  const frame1 = qm.addItem({
    type: 'generate_frame',
    queue: 'image',
    itemKey: 'frame:scene:1:shot:1',
    inputs: { shot: shot1 },
  });
  const video1 = qm.addItem({
    type: 'generate_video',
    queue: 'video',
    itemKey: 'video:scene:1:shot:1',
    dependencies: [frame1.id],
    inputs: { shot: shot1, startFramePath: 'frames/1.png' },
  });
  const frame2 = qm.addItem({
    type: 'generate_frame',
    queue: 'image',
    itemKey: 'frame:scene:1:shot:2',
    dependencies: [video1.itemKey],
    inputs: { shot: shot2 },
  });
  const video2 = qm.addItem({
    type: 'generate_video',
    queue: 'video',
    itemKey: 'video:scene:1:shot:2',
    dependencies: [frame2.id],
    inputs: { shot: shot2, startFramePath: 'frames/2.png' },
  });
  qm.addItem({
    type: 'generate_frame',
    queue: 'image',
    itemKey: 'frame:scene:1:shot:3',
    dependencies: [video2.itemKey],
    inputs: { shot: shot3 },
  });

  const processor = new QueueProcessor('video', qm, 'run-1', 1);
  const newFrame1 = qm.redoItem(frame1.id);

  const frame2Items = qm.getItemsByKey('frame:scene:1:shot:2');
  assert.equal(frame2Items.length, 1);
  assert.equal(frame2Items[0].status, 'superseded');

  const video2Items = qm.getItemsByKey('video:scene:1:shot:2');
  assert.equal(video2Items.length, 1);
  assert.equal(video2Items[0].status, 'superseded');

  const frame3Items = qm.getItemsByKey('frame:scene:1:shot:3');
  assert.equal(frame3Items.length, 1);
  assert.equal(frame3Items[0].status, 'superseded');

  (processor as any).seedAfterGenerateFrame(newFrame1, { startPath: 'frames/1-v2.png' });

  const video1Items = qm.getItemsByKey('video:scene:1:shot:1');
  const activeVideo1 = video1Items.find(item => item.status !== 'superseded' && item.status !== 'cancelled');
  assert.ok(activeVideo1);
  assert.deepEqual(activeVideo1.dependencies, [newFrame1.id]);

  (processor as any).seedAfterGenerateVideo(activeVideo1, {
    shotNumber: 1,
    path: 'videos/1-v2.mp4',
  });

  const recreatedFrame2 = qm.getItemsByKey('frame:scene:1:shot:2')
    .find(item => item.status !== 'superseded' && item.status !== 'cancelled');
  assert.ok(recreatedFrame2);
  assert.deepEqual(recreatedFrame2.dependencies, [activeVideo1.id]);

  (processor as any).seedAfterGenerateFrame(recreatedFrame2, { startPath: 'frames/2-v2.png' });

  const recreatedVideo2 = qm.getItemsByKey('video:scene:1:shot:2')
    .find(item => item.status !== 'superseded' && item.status !== 'cancelled');
  assert.ok(recreatedVideo2);
  assert.deepEqual(recreatedVideo2.dependencies, [recreatedFrame2.id]);

  (processor as any).seedAfterGenerateVideo(recreatedVideo2, {
    shotNumber: 2,
    path: 'videos/2-v2.mp4',
  });

  const recreatedFrame3 = qm.getItemsByKey('frame:scene:1:shot:3')
    .find(item => item.status !== 'superseded' && item.status !== 'cancelled');
  assert.ok(recreatedFrame3);
  assert.deepEqual(recreatedFrame3.dependencies, [recreatedVideo2.id]);
  console.log('  ✓ frame redo rebuilds the continuity chain after replacement videos complete');
}

function testGenerateVideoSeedsMissingContinuityFrame(): void {
  const qm = makeQueueManager();
  const shot1 = makeShot(1, 1, false);
  const shot2 = makeShot(2, 2, true);
  qm.setStoryAnalysis(makeAnalysis([shot1, shot2]));

  const video = qm.addItem({
    type: 'generate_video',
    queue: 'video',
    itemKey: 'video:scene:1:shot:1',
    inputs: { shot: shot1, startFramePath: 'frames/1.png' },
    priority: 'high',
  });

  const processor = new QueueProcessor('video', qm, 'run-1', 1);
  (processor as any).seedAfterGenerateVideo(video, {
    shotNumber: 1,
    path: 'videos/1.mp4',
  });

  const frameItems = qm.getItemsByKey('frame:scene:1:shot:2');
  assert.equal(frameItems.length, 1);
  assert.deepEqual(frameItems[0].dependencies, [video.id]);
  assert.equal(frameItems[0].priority, 'high');
  console.log('  ✓ completed videos seed a missing downstream continuity frame');
}

function testGenerateVideoSeedsAssembleWithVideoKeys(): void {
  const qm = makeQueueManager();
  const shot1 = makeShot(1, 1, false);
  const shot2 = makeShot(2, 2, false);
  qm.setStoryAnalysis(makeAnalysis([shot1, shot2]));

  const video1 = qm.addItem({
    type: 'generate_video',
    queue: 'video',
    itemKey: 'video:scene:1:shot:1',
    inputs: { shot: shot1, startFramePath: 'frames/1.png' },
  });
  const video2 = qm.addItem({
    type: 'generate_video',
    queue: 'video',
    itemKey: 'video:scene:1:shot:2',
    inputs: { shot: shot2, startFramePath: 'frames/2.png' },
  });

  qm.markInProgress(video1.id);
  qm.markCompleted(video1.id, { path: 'videos/1.mp4' });

  const processor = new QueueProcessor('video', qm, 'run-1', 1);
  (processor as any).seedAfterGenerateVideo(video1, {
    shotNumber: 1,
    path: 'videos/1.mp4',
  });

  qm.markInProgress(video2.id);
  qm.markCompleted(video2.id, { path: 'videos/2.mp4' });
  (processor as any).seedAfterGenerateVideo(video2, {
    shotNumber: 2,
    path: 'videos/2.mp4',
  });

  const assembleItems = qm.getItemsByKey('assemble');
  assert.equal(assembleItems.length, 1);
  assert.deepEqual(assembleItems[0].dependencies, [
    'video:scene:1:shot:1',
    'video:scene:1:shot:2',
  ]);
  console.log('  ✓ completed videos seed assemble with key-based video dependencies');
}

async function testConcurrentResumeIsSerialized(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'run-manager-'));
  process.env.STORYTOVIDEO_RUN_DB_DIR = join(root, 'db');
  process.env.STORYTOVIDEO_RUN_OUTPUT_ROOT = join(root, 'runs');

  const { RunManager } = await import('./run-manager.js');
  const { QueueProcessor } = await import('./processors.js');

  const originalStart = QueueProcessor.prototype.start;
  const originalStop = QueueProcessor.prototype.stop;
  let startCount = 0;

  QueueProcessor.prototype.start = function startStub(): void {
    startCount += 1;
  };
  QueueProcessor.prototype.stop = async function stopStub(): Promise<void> {
    await sleep(10);
  };

  try {
    const rm = new RunManager();
    const run = rm.createRun('hello world');
    await rm.stopRun(run.id);
    startCount = 0;

    const results = await Promise.all([rm.resumeRun(run.id), rm.resumeRun(run.id)]);

    assert.equal(startCount, 3, 'only one processor batch should start');
    assert.deepEqual(results.sort(), [false, true]);
    console.log('  ✓ concurrent resume is serialized');
  } finally {
    QueueProcessor.prototype.start = originalStart;
    QueueProcessor.prototype.stop = originalStop;
  }
}

async function main(): Promise<void> {
  console.log('Queue state concurrency tests:');
  testClaimNextReady();
  testReadSnapshotsAreIsolated();
  testCancelledItemsStayCancelled();
  testRedoRejectsInProgress();
  testPendingOnlyMutations();
  testAnalyzeMutationsAreGuarded();
  testRedoDoesNotCascadeOutputDerivedItemsFromFrame();
  testRedoDoesNotCascadeAnalyzeVideo();
  testRedoVideoRemapsKeyBasedContinuityDependency();
  testFrameRedoRebuildsContinuityChainAfterReplacementVideosComplete();
  testGenerateVideoSeedsMissingContinuityFrame();
  testGenerateVideoSeedsAssembleWithVideoKeys();
  await testConcurrentResumeIsSerialized();
  console.log('\nAll tests passed ✓');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});