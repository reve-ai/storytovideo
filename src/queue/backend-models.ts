import type { ImageBackend, VideoBackend } from '../types.js';

/**
 * Single source of truth for backend → pricing-model name mapping.
 * Both the queue processors and the chat preview cost recorders go through
 * these helpers so the cost ledger stays consistent.
 */

export function imageBackendToModel(backend: ImageBackend): string {
  return backend === 'grok' ? 'grok-imagine-image'
    : backend === 'nano-banana' ? 'gemini-3.1-flash-image-preview'
    : 'reve';
}

export function videoBackendToModel(backend: VideoBackend): string {
  return backend === 'grok' ? 'grok-imagine-video'
    : backend === 'veo' ? 'veo-3.1-generate-preview'
    : backend === 'veo-reve' ? 'veo-3.1-generate-001'
    : 'ltx';
}
