import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";

// ---------------------------------------------------------------------------
// Types — intentionally mirrors Vercel AI SDK CoreMessage shapes so saved
// conversations can be fed straight back into generateText / generateObject.
// ---------------------------------------------------------------------------

export interface ConversationMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ConversationToolCall {
  toolName: string;
  args?: unknown;
  result?: unknown;
}

export interface ConversationTurn {
  timestamp: string;
  messages: ConversationMessage[];
  toolCalls?: ConversationToolCall[];
  usage?: { promptTokens: number; completionTokens: number };
  metadata?: Record<string, unknown>;
}

export interface ConversationFile {
  itemKey: string;
  category: string;
  model: string;
  provider: string;
  turns: ConversationTurn[];
}

// ---------------------------------------------------------------------------
// ConversationLogger
// ---------------------------------------------------------------------------

export class ConversationLogger {
  private conversationsDir: string;

  constructor(outputDir: string) {
    this.conversationsDir = join(outputDir, "conversations");
    mkdirSync(this.conversationsDir, { recursive: true });
  }

  /**
   * Record a complete LLM turn (prompt + response) for a given item.
   *
   * If a conversation file already exists for this itemKey the new turn is
   * appended — this is the mechanism that enables multi-turn continuation.
   */
  logTurn(params: {
    itemKey: string;
    category: string;
    model: string;
    provider: string;
    userMessage: string;
    assistantMessage: string;
    systemMessage?: string;
    toolCalls?: ConversationToolCall[];
    usage?: { promptTokens: number; completionTokens: number };
    metadata?: Record<string, unknown>;
  }): void {
    const {
      itemKey,
      category,
      model,
      provider,
      userMessage,
      assistantMessage,
      systemMessage,
      toolCalls,
      usage,
      metadata,
    } = params;

    const filePath = this.filePath(itemKey);

    // Load existing or create new conversation file
    let conversation: ConversationFile;
    if (existsSync(filePath)) {
      try {
        conversation = JSON.parse(readFileSync(filePath, "utf-8"));
      } catch {
        conversation = { itemKey, category, model, provider, turns: [] };
      }
    } else {
      conversation = { itemKey, category, model, provider, turns: [] };
    }

    // Always update model/provider to latest (in case provider changed between turns)
    conversation.model = model;
    conversation.provider = provider;

    // Build the messages array for this turn
    const messages: ConversationMessage[] = [];
    if (systemMessage) {
      messages.push({ role: "system", content: systemMessage });
    }
    messages.push({ role: "user", content: userMessage });
    messages.push({ role: "assistant", content: assistantMessage });

    conversation.turns.push({
      timestamp: new Date().toISOString(),
      messages,
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
      ...(usage ? { usage } : {}),
      ...(metadata ? { metadata } : {}),
    });

    this.write(filePath, conversation);
  }

  /**
   * Load a saved conversation for an item key (returns null if not found).
   */
  load(itemKey: string): ConversationFile | null {
    const filePath = this.filePath(itemKey);
    if (!existsSync(filePath)) return null;
    try {
      return JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
      return null;
    }
  }

  /**
   * Flatten all turns into a single messages array suitable for passing to
   * the AI SDK as conversation history.
   */
  static flattenMessages(conversation: ConversationFile): ConversationMessage[] {
    return conversation.turns.flatMap(turn => turn.messages);
  }

  // --- Internals ---

  private filePath(itemKey: string): string {
    // Sanitize itemKey for filesystem: replace colons/slashes with underscores
    const sanitized = itemKey.replace(/[:/\\]/g, "_").replace(/\s+/g, "_");
    return join(this.conversationsDir, `${sanitized}.json`);
  }

  private write(filePath: string, data: ConversationFile): void {
    try {
      const dir = dirname(filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error("[ConversationLogger] Failed to write:", err);
    }
  }
}
