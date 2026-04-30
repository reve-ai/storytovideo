import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { join, resolve, isAbsolute } from "path";
import type { UIMessageChunk } from "ai";
import type { ChatScope } from "./types.js";

/**
 * Per-session append-only events log of UI message chunks emitted by an agent
 * run. Allows clients to resume mid-stream and survives server restarts as a
 * forensic record of what the agent produced for the most recent turn.
 */

function resolveOutputDir(outputDir: string): string {
  return isAbsolute(outputDir) ? outputDir : resolve(process.cwd(), outputDir);
}

export function chatEventsPath(
  outputDir: string,
  scope: ChatScope,
  scopeKey: string,
): string {
  return join(resolveOutputDir(outputDir), "chats", scope, `${scopeKey}.events.jsonl`);
}

function ensureDir(filePath: string): void {
  const dir = resolve(filePath, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Append a single UIMessageChunk to the events log. */
export function appendEvent(
  outputDir: string,
  scope: ChatScope,
  scopeKey: string,
  chunk: UIMessageChunk,
): void {
  const path = chatEventsPath(outputDir, scope, scopeKey);
  ensureDir(path);
  appendFileSync(path, JSON.stringify(chunk) + "\n", "utf-8");
}

/** Read all chunks from the events log. Returns [] if file is missing. */
export function readEvents(
  outputDir: string,
  scope: ChatScope,
  scopeKey: string,
): UIMessageChunk[] {
  const path = chatEventsPath(outputDir, scope, scopeKey);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const out: UIMessageChunk[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as UIMessageChunk);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/** Truncate the events log (start of a new turn). */
export function clearEvents(
  outputDir: string,
  scope: ChatScope,
  scopeKey: string,
): void {
  const path = chatEventsPath(outputDir, scope, scopeKey);
  ensureDir(path);
  writeFileSync(path, "", "utf-8");
}
