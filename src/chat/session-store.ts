import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join, resolve, isAbsolute } from "path";
import { randomUUID } from "crypto";
import type { UIMessage } from "ai";
import {
  emptyChatSession,
  type ChatScope,
  type ChatSession,
  type ChatIntermediate,
  type ShotDraft,
} from "./types.js";

function resolveOutputDir(outputDir: string): string {
  return isAbsolute(outputDir) ? outputDir : resolve(process.cwd(), outputDir);
}

export function chatSessionPath(outputDir: string, scope: ChatScope, scopeKey: string): string {
  return join(resolveOutputDir(outputDir), "chats", scope, `${scopeKey}.json`);
}

export function chatPreviewDir(outputDir: string, scope: ChatScope, scopeKey: string): string {
  return join(resolveOutputDir(outputDir), "chats", scope, `${scopeKey}.previews`);
}

/**
 * Path inside the run's outputDir (relative) for a chat sandbox preview.
 * Used by the media route which serves files relative to the run's outputDir.
 */
export function chatPreviewRelative(scope: ChatScope, scopeKey: string, ...segments: string[]): string {
  return ["chats", scope, `${scopeKey}.previews`, ...segments].join("/");
}

export class ChatSessionStore {
  constructor(private readonly outputDir: string) {}

  private filePath(scope: ChatScope, scopeKey: string): string {
    return chatSessionPath(this.outputDir, scope, scopeKey);
  }

  load(scope: ChatScope, scopeKey: string, runId: string): ChatSession {
    const path = this.filePath(scope, scopeKey);
    if (!existsSync(path)) {
      return emptyChatSession(runId, scope, scopeKey);
    }
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as ChatSession;
      // Defensive: backfill missing fields for old sessions
      return {
        scope,
        scopeKey,
        runId,
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        draft: parsed.draft ?? null,
        intermediates: Array.isArray(parsed.intermediates) ? parsed.intermediates : [],
        lastSavedAt: parsed.lastSavedAt ?? new Date().toISOString(),
      };
    } catch (err) {
      console.error(`[ChatSessionStore] Failed to load ${path}:`, err);
      return emptyChatSession(runId, scope, scopeKey);
    }
  }

  save(session: ChatSession): void {
    const path = this.filePath(session.scope, session.scopeKey);
    const dir = resolve(path, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const next: ChatSession = { ...session, lastSavedAt: new Date().toISOString() };
    const tmp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), "utf-8");
    renameSync(tmp, path);
  }

  setMessages(scope: ChatScope, scopeKey: string, runId: string, messages: UIMessage[]): ChatSession {
    const current = this.load(scope, scopeKey, runId);
    const next: ChatSession = { ...current, messages };
    this.save(next);
    return next;
  }

  setDraft(scope: ChatScope, scopeKey: string, runId: string, draft: ShotDraft | null): ChatSession {
    const current = this.load(scope, scopeKey, runId);
    const next: ChatSession = { ...current, draft };
    this.save(next);
    return next;
  }

  appendIntermediate(scope: ChatScope, scopeKey: string, runId: string, intermediate: ChatIntermediate): ChatSession {
    const current = this.load(scope, scopeKey, runId);
    const next: ChatSession = { ...current, intermediates: [...current.intermediates, intermediate] };
    this.save(next);
    return next;
  }

  clearDraft(scope: ChatScope, scopeKey: string, runId: string): ChatSession {
    return this.setDraft(scope, scopeKey, runId, null);
  }
}
