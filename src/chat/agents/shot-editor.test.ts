import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QueueManager } from '../../queue/queue-manager.js';
import type { RunManager } from '../../queue/run-manager.js';
import type { Shot, StoryAnalysis } from '../../types.js';
import { ChatSessionStore } from '../session-store.js';
import { isShotDraft, type ShotDraft } from '../types.js';
import { shotFrameInputsHash } from '../preview-hash.js';
import {
  pickVideoStartFrame,
  runFramePreview,
  type ShotEditorContext,
} from './shot-editor.js';

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

function testFreshPreviewBranch(): void {
  const live = makeShot();
  const merged = makeShot({ composition: 'wide_shot' });
  const draft: ShotDraft = {
    shotFields: { composition: 'wide_shot' },
    pendingImageReplacements: [],
    previewArtifacts: {
      frame: {
        sandboxPath: 'chats/shot/1-1.previews/frames/scene_1_shot_1_v1_start.png',
        createdAt: new Date().toISOString(),
        inputsHash: shotFrameInputsHash({ artStyle: 'cinematic', shot: merged }),
      },
    },
  };
  const decision = pickVideoStartFrame({
    artStyle: 'cinematic', mergedShot: merged, liveShot: live, draft,
    generatedOutputs: { 'frame:scene:1:shot:1:start': 'frames/canonical.png' },
  });
  assert.equal(decision.kind, 'fresh-preview');
  if (decision.kind === 'fresh-preview') {
    assert.equal(decision.sandboxRel, draft.previewArtifacts!.frame!.sandboxPath);
  }
  console.log('  ✓ fresh sandbox preview is selected when its hash matches the merged-draft shot');
}

function testDirtyBranch(): void {
  const live = makeShot();
  const merged = makeShot({ composition: 'wide_shot' });
  // Stale preview hash (from a different earlier draft) — should be ignored.
  const stalePreviewHash = shotFrameInputsHash({
    artStyle: 'cinematic', shot: makeShot({ composition: 'closeup' }),
  });
  const draft: ShotDraft = {
    shotFields: { composition: 'wide_shot' },
    pendingImageReplacements: [],
    previewArtifacts: {
      frame: {
        sandboxPath: 'chats/shot/1-1.previews/frames/old.png',
        createdAt: new Date().toISOString(),
        inputsHash: stalePreviewHash,
      },
    },
  };
  const decision = pickVideoStartFrame({
    artStyle: 'cinematic', mergedShot: merged, liveShot: live, draft,
    generatedOutputs: { 'frame:scene:1:shot:1:start': 'frames/canonical.png' },
  });
  assert.equal(decision.kind, 'dirty-needs-preview',
    'frame-affecting field changed and no fresh preview → must trigger auto-regen');
  console.log('  ✓ dirty draft (frame-affecting edit, no fresh preview) selects auto-regen branch');
}

function testCanonicalBranch(): void {
  // No frame-affecting fields edited; only a video-only field differs.
  const live = makeShot();
  const merged = makeShot({ durationSeconds: 7 });
  const draft: ShotDraft = {
    shotFields: { durationSeconds: 7 },
    pendingImageReplacements: [],
  };
  const decision = pickVideoStartFrame({
    artStyle: 'cinematic', mergedShot: merged, liveShot: live, draft,
    generatedOutputs: { 'frame:scene:1:shot:1:start': 'frames/canonical.png' },
  });
  assert.equal(decision.kind, 'canonical');
  if (decision.kind === 'canonical') assert.equal(decision.canonicalRel, 'frames/canonical.png');
  console.log("  ✓ frame matches canonical → uses canonical start frame (today's behavior)");
}

async function testRunFramePreviewPersistsArtifact(): Promise<void> {
  // The dirty branch's contract: runFramePreview must persist
  // previewArtifacts.frame so apply.ts can promote it (no orphan frames),
  // and the recorded inputsHash must match what pickVideoStartFrame
  // recomputes for the same shot (otherwise the very next previewVideo
  // call would re-regenerate).
  const dir = mkdtempSync(join(tmpdir(), 'shot-editor-runframe-'));
  const qm = new QueueManager('run-1', '(test)', dir);
  const shot = makeShot();
  qm.setStoryAnalysis(makeAnalysis(shot));
  qm.setAssetLibrary({ characterImages: {}, locationImages: {}, objectImages: {} });

  const stubRunManager = new EventEmitter() as unknown as RunManager;
  const ctx: ShotEditorContext = {
    runId: 'run-1', sceneNumber: 1, shotInScene: 1, scopeKey: '1-1',
    store: new ChatSessionStore(dir), runManager: stubRunManager, queueManager: qm,
  };
  const stubGenerate = (async (params: { outputDir: string }) =>
    ({ shotNumber: 1, startPath: join(params.outputDir, 'frames/stub.png') })
  ) as unknown as Parameters<typeof runFramePreview>[1] extends infer _ ? typeof import('../../tools/generate-frame.js').generateFrame : never;

  const result = await runFramePreview(ctx, { generate: stubGenerate });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const session = ctx.store.load('shot', '1-1', 'run-1');
  assert.ok(isShotDraft(session.draft));
  const persisted = (session.draft as ShotDraft).previewArtifacts?.frame;
  assert.ok(persisted, 'previewArtifacts.frame must be persisted');
  assert.equal(persisted!.sandboxPath, result.sandboxRel);
  assert.equal(persisted!.inputsHash, shotFrameInputsHash({ artStyle: 'cinematic', shot }));
  assert.equal(session.intermediates.length, 1);
  assert.equal(session.intermediates[0].kind, 'frame');
  console.log('  ✓ runFramePreview persists previewArtifacts.frame with the matching inputs hash');
}

async function main(): Promise<void> {
  console.log('Shot-editor previewVideo start-frame selection:');
  testFreshPreviewBranch();
  testDirtyBranch();
  testCanonicalBranch();
  await testRunFramePreviewPersistsArtifact();
  console.log('\nAll tests passed ✓');
}

main().catch((err) => { console.error(err); process.exit(1); });
