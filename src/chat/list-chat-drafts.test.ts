import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listChatDrafts } from './session-store.js';
import {
  emptyChatSession,
  type ChatSession,
  type LocationDraft,
  type ShotDraft,
  type StoryDraft,
} from './types.js';

function writeSession(outputDir: string, session: ChatSession): void {
  const dir = join(outputDir, 'chats', session.scope);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${session.scopeKey}.json`), JSON.stringify(session, null, 2), 'utf-8');
}

function makeSession(scope: ChatSession['scope'], scopeKey: string, draft: ChatSession['draft'], lastSavedAt: string): ChatSession {
  const empty = emptyChatSession('run-1', scope, scopeKey);
  return { ...empty, draft, lastSavedAt };
}

function testReturnsRowsForScopesWithNonNullDrafts(): void {
  const outputDir = mkdtempSync(join(tmpdir(), 'chat-drafts-'));

  const shotDraftFields: ShotDraft = {
    shotFields: { startFramePrompt: 'updated' },
    pendingImageReplacements: [],
  };
  const shotDraftPreviewOnly: ShotDraft = {
    shotFields: {},
    pendingImageReplacements: [],
    previewArtifacts: { video: { sandboxPath: 'p.mp4', createdAt: 't', inputsHash: 'h' } },
  };
  const locationDraftPreviewOnly: LocationDraft = {
    locationFields: {},
    pendingReferenceImage: null,
    previewArtifacts: { referenceImage: { sandboxPath: 'p.png', createdAt: 't', inputsHash: 'h' } },
  };
  const storyDraftFields: StoryDraft = {
    storyFields: { title: 'New Title' },
  };

  writeSession(outputDir, makeSession('shot', '1-10', shotDraftFields, '2025-01-01T00:00:00.000Z'));
  writeSession(outputDir, makeSession('shot', '2-3', shotDraftPreviewOnly, '2025-01-02T00:00:00.000Z'));
  writeSession(outputDir, makeSession('location', 'diner', locationDraftPreviewOnly, '2025-01-03T00:00:00.000Z'));
  writeSession(outputDir, makeSession('story', 'main', storyDraftFields, '2025-01-04T00:00:00.000Z'));
  // Sessions without drafts should not appear.
  writeSession(outputDir, makeSession('shot', '1-1', null, '2025-01-05T00:00:00.000Z'));
  writeSession(outputDir, makeSession('location', 'park', null, '2025-01-06T00:00:00.000Z'));

  const drafts = listChatDrafts(outputDir);
  const byKey = new Map(drafts.map((d) => [`${d.scope}::${d.scopeKey}`, d]));

  assert.equal(drafts.length, 4, `expected 4 drafts, got ${drafts.length}`);

  const shotFields = byKey.get('shot::1-10');
  assert.ok(shotFields, 'shot 1-10 row missing');
  assert.equal(shotFields!.hasFieldEdits, true);
  assert.equal(shotFields!.hasPreview, false);
  assert.equal(shotFields!.lastSavedAt, '2025-01-01T00:00:00.000Z');

  const shotPreview = byKey.get('shot::2-3');
  assert.ok(shotPreview, 'shot 2-3 row missing');
  assert.equal(shotPreview!.hasFieldEdits, false);
  assert.equal(shotPreview!.hasPreview, true);

  const loc = byKey.get('location::diner');
  assert.ok(loc, 'location diner row missing');
  assert.equal(loc!.hasFieldEdits, false);
  assert.equal(loc!.hasPreview, true);

  const story = byKey.get('story::main');
  assert.ok(story, 'story main row missing');
  assert.equal(story!.hasFieldEdits, true);
  assert.equal(story!.hasPreview, false);

  assert.ok(!byKey.has('shot::1-1'), 'shot with null draft should not appear');
  assert.ok(!byKey.has('location::park'), 'location with null draft should not appear');

  console.log('  ✓ returns rows only for sessions with non-null drafts');
}

function testReturnsEmptyWhenNoChatsDir(): void {
  const outputDir = mkdtempSync(join(tmpdir(), 'chat-drafts-empty-'));
  const drafts = listChatDrafts(outputDir);
  assert.deepEqual(drafts, []);
  console.log('  ✓ returns [] when no chats directory exists');
}

function testIgnoresNonJsonAndMalformed(): void {
  const outputDir = mkdtempSync(join(tmpdir(), 'chat-drafts-junk-'));
  const shotDir = join(outputDir, 'chats', 'shot');
  mkdirSync(shotDir, { recursive: true });
  writeFileSync(join(shotDir, 'README.txt'), 'not json', 'utf-8');
  writeFileSync(join(shotDir, '5-5.json'), '{not valid json', 'utf-8');
  writeSession(outputDir, makeSession('shot', '6-6', { shotFields: { startFramePrompt: 'x' }, pendingImageReplacements: [] }, '2025-02-01T00:00:00.000Z'));

  const drafts = listChatDrafts(outputDir);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].scopeKey, '6-6');
  console.log('  ✓ skips non-json and malformed json without throwing');
}

async function main(): Promise<void> {
  console.log('listChatDrafts tests:');
  testReturnsRowsForScopesWithNonNullDrafts();
  testReturnsEmptyWhenNoChatsDir();
  testIgnoresNonJsonAndMalformed();
  console.log('\nAll tests passed ✓');
}

main().catch((err) => { console.error(err); process.exit(1); });
