import type { Agent, ToolSet, UIMessage, UIMessageChunk } from "ai";
import { createAgentUIStream } from "ai";

import type { RunManager } from "../queue/run-manager.js";
import { appendEvent, clearEvents } from "./event-log.js";
import { getScopeRegistration } from "./scope-registry.js";
import { ChatSessionStore } from "./session-store.js";
import type { ChatScope } from "./types.js";

/**
 * Owns one in-progress agent run for a (runId, scope, scopeKey). Lives
 * independently of any HTTP request so closing a takeover/reloading the page
 * does not interrupt the agent loop.
 *
 * Responsibilities:
 *  - Drive the agent stream and broadcast each UIMessageChunk to subscribers
 *    (HTTP responses tailing the live stream).
 *  - Persist each chunk to the events log so a reconnecting client can replay
 *    everything emitted during the current turn.
 *  - Persist the final UIMessage[] to the session JSON via ChatSessionStore.
 *  - Queue additional user-message batches that arrive while a turn is
 *    running, then run them sequentially.
 */

export interface ChatSessionRunnerOptions {
  runId: string;
  scope: ChatScope;
  scopeKey: string;
  sceneNumber: number;
  shotInScene: number;
  outputDir: string;
  store: ChatSessionStore;
  runManager: RunManager;
  onFinished: () => void;
}

export interface ActiveChatInfo {
  scope: ChatScope;
  scopeKey: string;
  startedAt: string;
  lastEventAt: string;
  currentToolName: string | null;
  queueDepth: number;
}

type Subscriber = {
  controller: ReadableStreamDefaultController<UIMessageChunk>;
  closed: boolean;
};

export class ChatSessionRunner {
  readonly runId: string;
  readonly scope: ChatScope;
  readonly scopeKey: string;
  readonly sceneNumber: number;
  readonly shotInScene: number;

  private readonly outputDir: string;
  private readonly store: ChatSessionStore;
  private readonly runManager: RunManager;
  private readonly onFinished: () => void;

  private subscribers = new Set<Subscriber>();
  /** Buffer of all chunks emitted for the current turn (cleared between turns). */
  private buffer: UIMessageChunk[] = [];
  private pending: UIMessage[][] = [];
  private currentMessages: UIMessage[] = [];
  private abortController: AbortController | null = null;

  private status: "idle" | "running" = "idle";
  private startedAt: string = new Date().toISOString();
  private lastEventAt: string = this.startedAt;
  private currentToolName: string | null = null;
  private loopRunning = false;

  constructor(opts: ChatSessionRunnerOptions) {
    this.runId = opts.runId;
    this.scope = opts.scope;
    this.scopeKey = opts.scopeKey;
    this.sceneNumber = opts.sceneNumber;
    this.shotInScene = opts.shotInScene;
    this.outputDir = opts.outputDir;
    this.store = opts.store;
    this.runManager = opts.runManager;
    this.onFinished = opts.onFinished;
    // Seed history from the persisted session so a fresh runner picks up
    // wherever the prior process left off.
    this.currentMessages = this.store.load(this.scope, this.scopeKey, this.runId).messages;
  }

  isRunning(): boolean {
    return this.status === "running" || this.loopRunning || this.pending.length > 0;
  }

  /**
   * The current message history known to this runner. Equal to the persisted
   * session messages when idle, and ahead of disk during a turn (the runner
   * persists the new user batch, then the assistant message at turn finish).
   */
  getHistory(): UIMessage[] {
    return this.currentMessages;
  }

  getInfo(): ActiveChatInfo {
    return {
      scope: this.scope,
      scopeKey: this.scopeKey,
      startedAt: this.startedAt,
      lastEventAt: this.lastEventAt,
      currentToolName: this.currentToolName,
      queueDepth: this.pending.length,
    };
  }

  /** Append a user-message batch to the queue and start the run loop if idle. */
  enqueue(messages: UIMessage[]): void {
    if (messages.length > 0) this.pending.push(messages);
    if (!this.loopRunning && this.pending.length > 0) {
      void this.runLoop();
    }
  }

  /** Subscribe to the runner's chunk stream. Replays current-turn buffer first. */
  subscribe(): ReadableStream<UIMessageChunk> {
    const buffered = [...this.buffer];
    let sub: Subscriber | null = null;
    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        for (const chunk of buffered) controller.enqueue(chunk);
        if (!this.isRunning() && this.buffer.length === buffered.length) {
          controller.close();
          return;
        }
        sub = { controller, closed: false };
        this.subscribers.add(sub);
      },
      cancel: () => {
        if (sub) {
          sub.closed = true;
          this.subscribers.delete(sub);
        }
      },
    });
  }

  cancel(): void {
    this.abortController?.abort();
    this.pending = [];
    // Persist a synthetic terminal marker so the client knows the stream ended.
    this.broadcastClose();
    this.store.setRunStatus(this.scope, this.scopeKey, this.runId, "cancelled");
  }

  private broadcast(chunk: UIMessageChunk): void {
    this.buffer.push(chunk);
    this.lastEventAt = new Date().toISOString();
    try {
      appendEvent(this.outputDir, this.scope, this.scopeKey, chunk);
    } catch (err) {
      console.error("[ChatSessionRunner] appendEvent failed:", err);
    }
    this.updateToolName(chunk);
    for (const sub of this.subscribers) {
      if (sub.closed) continue;
      try { sub.controller.enqueue(chunk); }
      catch { sub.closed = true; this.subscribers.delete(sub); }
    }
  }

  private broadcastClose(): void {
    for (const sub of this.subscribers) {
      try { sub.controller.close(); } catch { /* ignore */ }
    }
    this.subscribers.clear();
  }

  private updateToolName(chunk: UIMessageChunk): void {
    const c = chunk as { type?: string; toolName?: string; state?: string };
    if (!c.type) return;
    if (c.type === "tool-input-start" || c.type === "tool-input-available") {
      if (typeof c.toolName === "string") this.currentToolName = c.toolName;
    } else if (c.type === "tool-output-available" || c.type === "tool-output-error") {
      this.currentToolName = null;
    }
  }

  private async runLoop(): Promise<void> {
    this.loopRunning = true;
    try {
      while (this.pending.length > 0) {
        const userBatch = this.pending.shift()!;
        this.currentMessages = [...this.currentMessages, ...userBatch];
        // Persist user messages immediately so a refresh restores their input.
        this.store.setMessages(this.scope, this.scopeKey, this.runId, this.currentMessages);
        await this.runOneTurn();
      }
    } finally {
      this.loopRunning = false;
      this.status = "idle";
      this.broadcastClose();
      this.onFinished();
    }
  }

  private buildAgent(): Agent<never, ToolSet> {
    const reg = getScopeRegistration(this.scope);
    if (!reg) throw new Error(`Unknown chat scope: ${this.scope}`);
    const qm = this.runManager.getQueueManager(this.runId);
    if (!qm) throw new Error(`Run has no queue manager: ${this.runId}`);
    return reg.agentFactory({
      runId: this.runId,
      scope: this.scope,
      scopeKey: this.scopeKey,
      sceneNumber: this.sceneNumber,
      shotInScene: this.shotInScene,
      store: this.store,
      runManager: this.runManager,
      queueManager: qm,
    });
  }

  private async runOneTurn(): Promise<void> {
    this.status = "running";
    this.startedAt = new Date().toISOString();
    this.lastEventAt = this.startedAt;
    this.currentToolName = null;
    this.buffer = [];
    try { clearEvents(this.outputDir, this.scope, this.scopeKey); } catch { /* ignore */ }
    this.store.setRunStatus(this.scope, this.scopeKey, this.runId, "running", {
      lastRunStartedAt: this.startedAt,
    });

    this.abortController = new AbortController();
    const agent = this.buildAgent();

    let finalMessages: UIMessage[] = this.currentMessages;
    let terminalStatus: "completed" | "cancelled" | "interrupted" = "completed";
    try {
      const stream = await createAgentUIStream({
        agent,
        uiMessages: this.currentMessages as unknown[],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        originalMessages: this.currentMessages as any,
        abortSignal: this.abortController.signal,
        onFinish: ({ messages }: { messages: unknown }) => {
          finalMessages = messages as UIMessage[];
        },
      });
      for await (const chunk of stream as AsyncIterable<UIMessageChunk>) {
        this.broadcast(chunk);
      }
    } catch (err) {
      if (this.abortController.signal.aborted) {
        terminalStatus = "cancelled";
      } else {
        terminalStatus = "interrupted";
        console.error("[ChatSessionRunner] turn failed:", err);
      }
    } finally {
      this.currentMessages = finalMessages;
      try {
        this.store.setMessages(this.scope, this.scopeKey, this.runId, finalMessages);
      } catch (err) {
        console.error("[ChatSessionRunner] persist final messages failed:", err);
      }
      // If more pending turns are queued, keep status as "running"; the loop
      // will set running again at the top. Otherwise reflect terminal state.
      if (this.pending.length === 0) {
        this.store.setRunStatus(this.scope, this.scopeKey, this.runId, terminalStatus);
      }
      this.abortController = null;
      this.currentToolName = null;
    }
  }
}
