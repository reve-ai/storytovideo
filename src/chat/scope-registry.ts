import type { Agent, ToolSet } from "ai";

import type { RunManager } from "../queue/run-manager.js";
import type { QueueManager } from "../queue/queue-manager.js";
import type { ChatDraft, ChatScope } from "./types.js";
import type { ChatSessionStore } from "./session-store.js";

export interface ScopeAgentContext {
  runId: string;
  scope: ChatScope;
  scopeKey: string;
  sceneNumber: number;
  shotInScene: number;
  store: ChatSessionStore;
  runManager: RunManager;
  queueManager: QueueManager;
}

export interface ScopeApplyContext {
  runId: string;
  scope: ChatScope;
  scopeKey: string;
  sceneNumber: number;
  shotInScene: number;
  runManager: RunManager;
}

export interface ScopeContextRequest {
  runId: string;
  scope: ChatScope;
  scopeKey: string;
  sceneNumber: number;
  shotInScene: number;
  runManager: RunManager;
}

export interface ApplyDraftResult {
  ok: boolean;
  regeneratedItemIds: string[];
  imageReplacementsApplied: Array<{ which: "start" | "end"; path: string }>;
  /** Smart-apply: kinds of preview artifacts that were promoted into the
   *  canonical output instead of being regenerated. Optional so callers that
   *  do not implement promotion (story scope) can omit it. */
  promoted?: Array<"frame" | "video" | "referenceImage">;
}

export interface ScopeRegistration {
  agentFactory: (ctx: ScopeAgentContext) => Agent<never, ToolSet>;
  applyDraft: (ctx: ScopeApplyContext, draft: ChatDraft) => Promise<ApplyDraftResult>;
  /**
   * Optional: return scope-specific context the GET handler should attach to
   * the session response (e.g. the live shot for the shot scope). Used to
   * power the form region without an extra round-trip.
   */
  getScopeContext?: (ctx: ScopeContextRequest) => Record<string, unknown> | null;
}

const registry = new Map<ChatScope, ScopeRegistration>();

export function registerScope(scope: ChatScope, registration: ScopeRegistration): void {
  registry.set(scope, registration);
}

export function getScopeRegistration(scope: ChatScope): ScopeRegistration | undefined {
  return registry.get(scope);
}

export function listScopes(): ChatScope[] {
  return [...registry.keys()];
}
