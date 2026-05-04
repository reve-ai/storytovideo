import { randomUUID } from 'node:crypto';
import type { QueueManager } from '../queue/queue-manager.js';
import type { RunManager } from '../queue/run-manager.js';
import type { CostEntry } from '../queue/cost-tracker.js';
import { computeImageCost, computeVideoCost } from '../queue/cost-tracker.js';
import { imageBackendToModel, videoBackendToModel } from '../queue/backend-models.js';
import type { ImageBackend, VideoBackend } from '../types.js';

/** Chat-scope identifier ("shot" / "location" / "object") used in
 *  CostEntry.itemKey so preview costs can be filtered out of the per-item
 *  breakdown that drives the canonical cost view. */
export type PreviewScope = 'shot' | 'location' | 'object' | 'character';
export type PreviewImageKind = 'frame' | 'referenceImage';
export type PreviewVideoKind = 'video' | 'extendedVideo';

function emitCostUpdated(runManager: RunManager, qm: QueueManager, runId: string): void {
  runManager.emit('cost:updated', { runId, summary: qm.getCostSummary() });
}

function appendCost(qm: QueueManager, runManager: RunManager, runId: string, entry: CostEntry): void {
  qm.recordCost(entry);
  qm.save();
  emitCostUpdated(runManager, qm, runId);
}

/** Record a CostEntry for a chat-driven preview image generation
 *  (previewFrame / previewReferenceImage). */
export function recordPreviewImageCost(
  qm: QueueManager,
  runManager: RunManager,
  runId: string,
  scope: PreviewScope,
  scopeKey: string,
  kind: PreviewImageKind,
  backend: ImageBackend,
): CostEntry {
  const model = imageBackendToModel(backend);
  const entry: CostEntry = {
    itemId: `preview-${randomUUID()}`,
    itemKey: `preview:${kind}:${scope}:${scopeKey}`,
    model,
    category: 'image',
    costUsd: computeImageCost(model),
    timestamp: new Date().toISOString(),
  };
  appendCost(qm, runManager, runId, entry);
  return entry;
}

/** Record a CostEntry for a chat-driven preview video generation
 *  (previewVideo / previewExtendedVideo). */
export function recordPreviewVideoCost(
  qm: QueueManager,
  runManager: RunManager,
  runId: string,
  scope: PreviewScope,
  scopeKey: string,
  kind: PreviewVideoKind,
  backend: VideoBackend,
  durationSeconds: number,
): CostEntry {
  const model = videoBackendToModel(backend);
  const entry: CostEntry = {
    itemId: `preview-${randomUUID()}`,
    itemKey: `preview:${kind}:${scope}:${scopeKey}`,
    model,
    category: 'video',
    durationSeconds,
    costUsd: computeVideoCost(model, durationSeconds),
    timestamp: new Date().toISOString(),
  };
  appendCost(qm, runManager, runId, entry);
  return entry;
}
