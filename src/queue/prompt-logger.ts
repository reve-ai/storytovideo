import { appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

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
    try {
      appendFileSync(this.logPath, entry, "utf-8");
    } catch (err) {
      console.error("[PromptLogger] Failed to write:", err);
    }
  }
}
