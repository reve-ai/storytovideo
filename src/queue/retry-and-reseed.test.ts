import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QueueManager } from './queue-manager.js';
import type { Shot, StoryAnalysis } from '../types.js';

function makeQueueManager(): QueueManager {
  const dir = mkdtempSync(join(tmpdir(), 'retry-reseed-'));
  return new QueueManager('run-1', '(test)', dir);
}

function makeShot(shotNumber: number, shotInScene: number): Shot {
  return {
    shotNumber,
    sceneNumber: 1,
    shotInScene,
    durationSeconds: 4,
    shotType: 'first_last_frame',
    composition: 'medium_shot',
    startFramePrompt: `start ${shotNumber}`,
    dialogue: '',
    speaker: '',
    soundEffects: '',
    cameraDirection: '',
    videoPrompt: '',
    charactersPresent: [],
    objectsPresent: [],
    location: 'Studio',
    continuousFromPrevious: false,
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
      estimatedDurationSeconds: 8,
      shots,
      transition: 'cut',
    }],
  };
}

function testRetryAllowsCancelledItems(): void {
  const qm = makeQueueManager();
  const item = qm.addItem({ type: 'artifact', queue: 'llm', itemKey: 'artifact:a' });

  assert.equal(qm.markInProgress(item.id), true);
  assert.equal(qm.cancelItem(item.id), true);

  const retried = qm.retryItem(item.id);
  assert.equal(retried.status, 'pending');
  assert.equal(retried.retryCount, 1);
  assert.equal(retried.error, null);
  assert.equal(retried.startedAt, null);
  assert.equal(retried.completedAt, null);
  console.log('  ✓ cancelled items can be retried back to pending');
}

function testReseededAssembleSupersedesExistingItem(): void {
  const qm = makeQueueManager();
  const shots = [makeShot(1, 1), makeShot(2, 2)];
  qm.setStoryAnalysis(makeAnalysis(shots));

  const videoKeys = shots.map(shot => `video:scene:${shot.sceneNumber}:shot:${shot.shotInScene}`);
  const original = qm.addItem({
    type: 'assemble',
    queue: 'llm',
    itemKey: 'assemble',
    dependencies: videoKeys,
  });
  qm.markInProgress(original.id);
  qm.markCompleted(original.id, { path: 'videos/assembled-v1.mp4' });

  const reseeded = qm.addItem({
    type: 'assemble',
    queue: 'llm',
    itemKey: 'assemble',
    dependencies: videoKeys,
  });
  qm.supersedeItem(original.id, reseeded.id);

  const current = qm.getItem(original.id);
  assert.equal(current?.status, 'superseded');
  assert.equal(current?.supersededBy, reseeded.id);
  assert.equal(reseeded.version, 2);
  assert.deepEqual(reseeded.dependencies, videoKeys);
  console.log('  ✓ reseeded assemble can supersede an older assemble item');
}

function main(): void {
  console.log('Retry/reseed queue tests:');
  testRetryAllowsCancelledItems();
  testReseededAssembleSupersedesExistingItem();
  console.log('\nAll tests passed ✓');
}

main();
