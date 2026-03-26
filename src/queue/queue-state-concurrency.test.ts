import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QueueManager } from './queue-manager.js';

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

function makeQueueManager(): QueueManager {
  const dir = mkdtempSync(join(tmpdir(), 'queue-state-'));
  return new QueueManager('run-1', '(test)', dir);
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
  await testConcurrentResumeIsSerialized();
  console.log('\nAll tests passed ✓');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});