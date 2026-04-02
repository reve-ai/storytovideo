import { execSync } from "child_process";
import type { RunManager } from "./run-manager.js";

// ---------------------------------------------------------------------------
// Git auto-pull: when the server is idle, periodically pull and restart
// on changes.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = Number(process.env.GIT_PULL_INTERVAL_MS ?? 60_000); // default 60s

/** Check whether the current working directory is inside a git repository. */
function isGitRepo(): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Return the current HEAD commit hash. */
function currentHead(): string {
  return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
}

/** Run `git pull` and return true if the HEAD changed (i.e. new commits). */
function pullAndCheck(): boolean {
  const before = currentHead();
  try {
    execSync("git pull --ff-only", { stdio: "inherit" });
  } catch (err) {
    console.error("[git-auto-pull] git pull failed:", err);
    return false;
  }
  const after = currentHead();
  return before !== after;
}

/** Returns true when no run is actively processing. */
function isIdle(runManager: RunManager): boolean {
  const runs = runManager.listRuns();
  return runs.every((r) => r.status !== "running" && r.status !== "stopping");
}

/**
 * Start the auto-pull loop. Call once at server startup.
 * When changes are detected during an idle period the process re-executes
 * itself so the new code is loaded.
 */
export function startGitAutoPull(runManager: RunManager): void {
  if (!isGitRepo()) {
    console.log("[git-auto-pull] Not a git repository — auto-pull disabled.");
    return;
  }

  console.log(
    `[git-auto-pull] Enabled — polling every ${POLL_INTERVAL_MS / 1000}s when idle.`,
  );

  const timer = setInterval(() => {
    if (!isIdle(runManager)) return; // busy — skip this tick

    console.log("[git-auto-pull] Server is idle — checking for updates…");
    const changed = pullAndCheck();

    if (changed) {
      console.log("[git-auto-pull] New commits pulled — restarting…");
      clearInterval(timer);

      // Re-exec the current process so the updated code is loaded.
      // `process.argv` preserves the original command (e.g. tsx src/queue/queue-server.ts).
      const { execv } = (() => {
        try {
          // Node ≥ 21.7 exposes process.execv, but for portability we
          // fall back to spawning a replacement process and exiting.
          return { execv: null };
        } catch {
          return { execv: null };
        }
      })();

      if (execv) {
        // Not reachable in practice today, but future-proofed.
        (execv as (path: string, args: string[]) => never)(
          process.argv[0],
          process.argv.slice(1),
        );
      } else {
        // Portable restart: spawn the same command detached then exit.
        const { spawn } = require("child_process") as typeof import("child_process");
        const child = spawn(process.argv[0], process.argv.slice(1), {
          stdio: "inherit",
          detached: true,
        });
        child.unref();
        process.exit(0);
      }
    }
  }, POLL_INTERVAL_MS);

  // Don't prevent the process from exiting naturally.
  timer.unref();
}
