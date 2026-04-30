import type { RunManager } from "../queue/run-manager.js";
import { ChatSessionRunner, type ActiveChatInfo } from "./session-runner.js";
import { ChatSessionStore } from "./session-store.js";
import type { ChatScope } from "./types.js";

/**
 * Process-global registry of in-flight chat agent runners. Keyed by
 * `${runId}::${scope}::${scopeKey}`. Used by the route handler to find or
 * create a runner for a (run, scope, scopeKey), by the active-chats endpoint,
 * and by the cancel endpoint.
 */

function key(runId: string, scope: ChatScope, scopeKey: string): string {
  return `${runId}::${scope}::${scopeKey}`;
}

const runners = new Map<string, ChatSessionRunner>();

export interface GetOrCreateOptions {
  runId: string;
  scope: ChatScope;
  scopeKey: string;
  sceneNumber: number;
  shotInScene: number;
  outputDir: string;
  store: ChatSessionStore;
  runManager: RunManager;
}

export function getRunner(
  runId: string,
  scope: ChatScope,
  scopeKey: string,
): ChatSessionRunner | null {
  return runners.get(key(runId, scope, scopeKey)) ?? null;
}

export function getOrCreateRunner(opts: GetOrCreateOptions): ChatSessionRunner {
  const k = key(opts.runId, opts.scope, opts.scopeKey);
  const existing = runners.get(k);
  if (existing) return existing;
  const runner = new ChatSessionRunner({
    ...opts,
    onFinished: () => {
      // Only remove if it's still us (a later runner could in theory replace,
      // though we never recreate while one exists).
      if (runners.get(k) === runner) runners.delete(k);
    },
  });
  runners.set(k, runner);
  return runner;
}

export function listActiveChats(runId: string): ActiveChatInfo[] {
  const out: ActiveChatInfo[] = [];
  for (const r of runners.values()) {
    if (r.runId !== runId) continue;
    if (!r.isRunning()) continue;
    out.push(r.getInfo());
  }
  // Stable order: started-at ascending.
  out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return out;
}

export function hasRunner(
  runId: string,
  scope: ChatScope,
  scopeKey: string,
): boolean {
  const r = runners.get(key(runId, scope, scopeKey));
  return !!r && r.isRunning();
}

/**
 * Remove a runner from the registry without waiting for its onFinished
 * callback. Used by the reset endpoint after calling cancel() so the next
 * POST creates a brand-new runner with no carried-over history or pending
 * approval state.
 */
export function removeRunner(
  runId: string,
  scope: ChatScope,
  scopeKey: string,
): boolean {
  return runners.delete(key(runId, scope, scopeKey));
}
