import { appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

export interface ToolCallEntry {
  toolName: string;
  args?: unknown;
  result?: unknown;
}

export class PromptLogger {
  private logPath: string;

  constructor(outputDir: string) {
    this.logPath = join(outputDir, "prompts.log");
    mkdirSync(dirname(this.logPath), { recursive: true });
  }

  log(itemKey: string, category: string, prompt: string, metadata?: Record<string, unknown>): void {
    const timestamp = new Date().toISOString();
    const metaStr = metadata ? ` | ${JSON.stringify(metadata)}` : "";
    const entry = `\n${"=".repeat(80)}\n[${timestamp}] ${category} | ${itemKey}${metaStr}\n${"=".repeat(80)}\n${prompt}\n`;
    this.write(entry);
  }

  logResponse(itemKey: string, category: string, response: string, metadata?: Record<string, unknown>): void {
    const timestamp = new Date().toISOString();
    const metaStr = metadata ? ` | ${JSON.stringify(metadata)}` : "";
    const entry = `\n${"-".repeat(80)}\n[${timestamp}] RESPONSE ${category} | ${itemKey}${metaStr}\n${"-".repeat(80)}\n${response}\n`;
    this.write(entry);
  }

  logToolCalls(itemKey: string, category: string, toolCalls: ToolCallEntry[]): void {
    if (toolCalls.length === 0) return;
    const timestamp = new Date().toISOString();
    const lines = toolCalls.map((tc, i) => {
      const argsStr = tc.args ? JSON.stringify(tc.args, null, 2) : "(no args)";
      const resultStr = tc.result !== undefined ? `\n    Result: ${JSON.stringify(tc.result, null, 2)}` : "";
      return `  [${i + 1}] ${tc.toolName}\n    Args: ${argsStr}${resultStr}`;
    });
    const entry = `\n${"~".repeat(80)}\n[${timestamp}] TOOL_CALLS ${category} | ${itemKey} (${toolCalls.length} calls)\n${"~".repeat(80)}\n${lines.join("\n")}\n`;
    this.write(entry);
  }

  private write(entry: string): void {
    try {
      appendFileSync(this.logPath, entry, "utf-8");
    } catch (err) {
      console.error("[PromptLogger] Failed to write:", err);
    }
  }
}
