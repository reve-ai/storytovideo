import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QueueManager } from './queue-manager.js';
import { seedDownstream } from './seed-downstream.js';
import type { Shot, StoryAnalysis } from '../types.js';

function makeQueueManager(): QueueManager {
  const dir = mkdtempSync(join(tmpdir(), 'queue-promotion-'));
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

function testAddItemAcceptsCompletedInitialStatus(): void {
  const qm = makeQueueManager();
  const item = qm.addItem({
    type: 'artifact',
    queue: 'llm',
    itemKey: 'artifact:demo',
    inputs: { artifactType: 'pacing' },
    initialStatus: 'completed',
    initialOutputs: { foo: 'bar' },
  });

  assert.equal(item.status, 'completed');
  assert.deepEqual(item.outputs, { foo: 'bar' });
  assert.ok(item.completedAt, 'completedAt should be set');
  assert.ok(item.startedAt, 'startedAt should be set');
  assert.equal(item.retryCount, 0);
  assert.equal(item.error, null);

  const reread = qm.getItem(item.id);
  assert.ok(reread);
  assert.equal(reread.status, 'completed');
  assert.deepEqual(reread.outputs, { foo: 'bar' });
  console.log('  ✓ addItem honors initialStatus=completed and initialOutputs');
}

function testPromoteCompletedSupersedesPriorAndPreservesInputs(): void {
  const qm = makeQueueManager();
  const shot = makeShot(1, 1, false);
  qm.setStoryAnalysis(makeAnalysis([shot]));

  const original = qm.addItem({
    type: 'generate_frame',
    queue: 'image',
    itemKey: 'frame:scene:1:shot:1',
    inputs: { shot },
    priority: 'high',
  });

  const result = qm.promoteCompleted({
    itemKey: 'frame:scene:1:shot:1',
    outputs: { startPath: 'frames/promoted.png' },
  });
  const promoted = result.newItem;

  assert.equal(promoted.status, 'completed');
  assert.equal(promoted.version, 2);
  assert.equal(promoted.priority, 'high');
  assert.deepEqual(promoted.outputs, { startPath: 'frames/promoted.png' });
  assert.deepEqual((promoted.inputs.shot as Shot).shotNumber, shot.shotNumber);
  assert.equal(result.supersededId, original.id, 'returned supersededId should match the prior active item');

  const items = qm.getItemsByKey('frame:scene:1:shot:1');
  const originalAfter = items.find(i => i.id === original.id);
  assert.ok(originalAfter);
  assert.equal(originalAfter.status, 'superseded');
  assert.equal(originalAfter.supersededBy, promoted.id);
  console.log('  ✓ promoteCompleted supersedes prior, bumps version, preserves inputs/priority');
}

function testPromoteCompletedFrameReseedsDownstreamVideo(): void {
  const qm = makeQueueManager();
  const shot = makeShot(1, 1, false);
  qm.setStoryAnalysis(makeAnalysis([shot]));

  const frame = qm.addItem({
    type: 'generate_frame',
    queue: 'image',
    itemKey: 'frame:scene:1:shot:1',
    inputs: { shot },
  });
  const video = qm.addItem({
    type: 'generate_video',
    queue: 'video',
    itemKey: 'video:scene:1:shot:1',
    dependencies: [frame.id],
    inputs: { shot, startFramePath: 'frames/original.png' },
  });

  const promotedFrame = qm.promoteCompleted({
    itemKey: 'frame:scene:1:shot:1',
    outputs: { startPath: 'frames/promoted.png' },
  }).newItem;
  seedDownstream(qm, promotedFrame, { startPath: 'frames/promoted.png' });

  const videoItems = qm.getItemsByKey('video:scene:1:shot:1');
  const oldVideo = videoItems.find(i => i.id === video.id);
  assert.ok(oldVideo);
  assert.equal(oldVideo.status, 'superseded');

  const activeVideos = videoItems.filter(
    i => i.status !== 'superseded' && i.status !== 'cancelled'
  );
  assert.equal(activeVideos.length, 1, 'exactly one active video should exist');
  assert.deepEqual(activeVideos[0].dependencies, [promotedFrame.id]);
  assert.equal(activeVideos[0].inputs.startFramePath, 'frames/promoted.png');
  console.log('  ✓ promoting a generate_frame supersedes the old video and seeds a fresh one');
}

function testPromoteCompletedVideoReseedsAnalyzeAndContinuity(): void {
  const qm = makeQueueManager();
  const shot1 = makeShot(1, 1, false);
  const shot2 = makeShot(2, 2, true);
  qm.setStoryAnalysis(makeAnalysis([shot1, shot2]));

  const video1 = qm.addItem({
    type: 'generate_video',
    queue: 'video',
    itemKey: 'video:scene:1:shot:1',
    inputs: { shot: shot1, startFramePath: 'frames/1.png' },
  });
  const analyze = qm.addItem({
    type: 'analyze_video',
    queue: 'llm',
    itemKey: 'analyze_video:scene:1:shot:1',
    dependencies: [video1.id],
    inputs: { videoPath: 'videos/1.mp4' },
  });

  const promotedVideo = qm.promoteCompleted({
    itemKey: 'video:scene:1:shot:1',
    outputs: { shotNumber: 1, path: 'videos/promoted.mp4' },
  }).newItem;
  seedDownstream(qm, promotedVideo, { shotNumber: 1, path: 'videos/promoted.mp4' });

  const analyzeItems = qm.getItemsByKey('analyze_video:scene:1:shot:1');
  const oldAnalyze = analyzeItems.find(i => i.id === analyze.id);
  assert.ok(oldAnalyze);
  assert.equal(oldAnalyze.status, 'superseded');

  const activeAnalyze = analyzeItems.filter(
    i => i.status !== 'superseded' && i.status !== 'cancelled'
  );
  assert.equal(activeAnalyze.length, 1);
  assert.deepEqual(activeAnalyze[0].dependencies, [promotedVideo.id]);
  assert.equal(activeAnalyze[0].inputs.videoPath, 'videos/promoted.mp4');

  const continuityFrame = qm.getItemsByKey('frame:scene:1:shot:2')
    .find(i => i.status !== 'superseded' && i.status !== 'cancelled');
  assert.ok(continuityFrame, 'continuity frame for shot 2 should be seeded');
  assert.deepEqual(continuityFrame.dependencies, [promotedVideo.id]);
  console.log('  ✓ promoting a generate_video re-seeds analyze_video and continuity frame');
}

function testPromoteCompletedThrowsWhenNoActiveItem(): void {
  const qm = makeQueueManager();
  assert.throws(
    () => qm.promoteCompleted({
      itemKey: 'frame:scene:1:shot:99',
      outputs: { startPath: 'x.png' },
    }),
    /no active item found/,
  );
  console.log('  ✓ promoteCompleted throws when no item exists for the key');
}

function testPromoteCompletedAcceptsExplicitSupersedeId(): void {
  const qm = makeQueueManager();
  const shot = makeShot(1, 1, false);
  qm.setStoryAnalysis(makeAnalysis([shot]));

  const original = qm.addItem({
    type: 'generate_frame',
    queue: 'image',
    itemKey: 'frame:scene:1:shot:1',
    inputs: { shot },
  });

  const result = qm.promoteCompleted({
    itemKey: 'frame:scene:1:shot:1',
    supersedeId: original.id,
    outputs: { startPath: 'frames/explicit.png' },
  });
  const promoted = result.newItem;

  assert.equal(promoted.status, 'completed');
  assert.equal(result.supersededId, original.id);
  assert.equal(qm.getItem(original.id)?.status, 'superseded');
  assert.equal(qm.getItem(original.id)?.supersededBy, promoted.id);
  console.log('  ✓ promoteCompleted honors explicit supersedeId');
}

function testCompletedItemPersistsAcrossSaveAndLoad(): void {
  const dir = mkdtempSync(join(tmpdir(), 'queue-promotion-rt-'));
  const qm = new QueueManager('run-rt', '(test)', dir);
  const item = qm.addItem({
    type: 'artifact',
    queue: 'llm',
    itemKey: 'artifact:rt',
    inputs: { artifactType: 'pacing' },
    initialStatus: 'completed',
    initialOutputs: { foo: 'bar', n: 7 },
  });
  qm.save();

  const reloaded = QueueManager.load(join(dir, 'queue_state.json'));
  const restored = reloaded.getItem(item.id);
  assert.ok(restored);
  assert.equal(restored.status, 'completed');
  assert.deepEqual(restored.outputs, { foo: 'bar', n: 7 });
  assert.ok(restored.completedAt);
  assert.ok(restored.startedAt);
  console.log('  ✓ completed-on-add items round-trip through save/load');
}

function main(): void {
  console.log('Queue promotion primitive tests:');
  testAddItemAcceptsCompletedInitialStatus();
  testCompletedItemPersistsAcrossSaveAndLoad();
  testPromoteCompletedSupersedesPriorAndPreservesInputs();
  testPromoteCompletedFrameReseedsDownstreamVideo();
  testPromoteCompletedVideoReseedsAnalyzeAndContinuity();
  testPromoteCompletedThrowsWhenNoActiveItem();
  testPromoteCompletedAcceptsExplicitSupersedeId();
  console.log('\nAll tests passed ✓');
}

main();

