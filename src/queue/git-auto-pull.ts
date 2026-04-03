import { execSync, spawn } from "child_process";
import type { Server } from "http";
import type { RunManager } from "./run-manager.js";

// ---------------------------------------------------------------------------
// Git auto-pull & local-change detection: periodically pull when idle,
// and restart whenever the local HEAD sha changes (pull, commit, checkout…).
// ---------------------------------------------------------------------------

export const POLL_INTERVAL_MS = Number(process.env.GIT_PULL_INTERVAL_MS ?? 60_000); // default 60s

/** Check whether the current working directory is inside a git repository. */
export function isGitRepo(): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Return the current HEAD commit hash. */
export function currentHead(): string {
  return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
}

/** Run `git pull --ff-only`. Errors are logged but not thrown. */
export function gitPull(): void {
  try {
    execSync("git pull --ff-only", { stdio: "inherit" });
  } catch (err) {
    console.error("[git-auto-pull] git pull failed:", err);
  }
}

/** Returns true when no run is actively processing. */
export function isIdle(runManager: RunManager): boolean {
  const runs = runManager.listRuns();
  return runs.every((r) => r.status !== "running" && r.status !== "stopping");
}


/**
 * Close the HTTP server, then spawn a replacement process that inherits
 * the terminal (not detached). The parent waits for the child to exit
 * and forwards its exit code, so the shell never reclaims the prompt.
 *
 * Used in non-cluster (standalone) mode only.
 */
function restart(httpServer: Server): void {
  const args = [...process.execArgv, ...process.argv.slice(1)];
  console.log(`[git-auto-pull] Restarting: ${process.execPath} ${args.join(" ")}`);

  // Close the server so the port is freed before the child starts listening.
  httpServer.close(() => {
    const child = spawn(process.execPath, args, { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
  });

  // Force-close idle keep-alive connections so .close() doesn't hang.
  httpServer.closeAllConnections?.();
}


/**
 * Start the auto-pull loop. Call once at server startup.
 *
 * On every tick:
 *  1. If idle, run `git pull --ff-only`.
 *  2. Compare current HEAD sha to the one recorded at startup (or last check).
 *     If it changed — from a pull, a local commit, a checkout, etc. — restart.
 *
 * NOTE: When running under the cluster primary (cluster-entry.ts), the primary
 * handles git polling directly and this function is NOT called from the worker.
 */
export function startGitAutoPull(runManager: RunManager, httpServer: Server): void {
  if (!isGitRepo()) {
    console.log("[git-auto-pull] Not a git repository — auto-pull disabled.");
    return;
  }

  let knownHead = currentHead();
  console.log(
    `[git-auto-pull] Enabled — polling every ${POLL_INTERVAL_MS / 1000}s. Current HEAD: ${knownHead.slice(0, 8)}`,
  );

  const timer = setInterval(() => {
    if (!isIdle(runManager)) return; // busy — skip everything

    gitPull();

    // Check for ANY head change — pull, local commit, checkout, rebase, etc.
    const head = currentHead();
    if (head !== knownHead) {
      console.log(
        `[git-auto-pull] HEAD changed: ${knownHead.slice(0, 8)} → ${head.slice(0, 8)} — restarting…`,
      );
      clearInterval(timer);
      restart(httpServer);
    }
  }, POLL_INTERVAL_MS);

  // Don't prevent the process from exiting naturally.
  timer.unref();
}
