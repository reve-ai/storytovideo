import { execSync } from "child_process";
import type { RunManager } from "./run-manager.js";

// ---------------------------------------------------------------------------
// Git auto-pull & local-change detection: periodically pull when idle,
// and restart whenever the local HEAD sha changes (pull, commit, checkout…).
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

/** Run `git pull --ff-only`. Errors are logged but not thrown. */
function gitPull(): void {
  try {
    execSync("git pull --ff-only", { stdio: "inherit" });
  } catch (err) {
    console.error("[git-auto-pull] git pull failed:", err);
  }
}

/** Returns true when no run is actively processing. */
function isIdle(runManager: RunManager): boolean {
  const runs = runManager.listRuns();
  return runs.every((r) => r.status !== "running" && r.status !== "stopping");
}

/** Restart the process by spawning a replacement and exiting. */
function restart(): never {
  const { spawn } = require("child_process") as typeof import("child_process");
  const child = spawn(process.argv[0], process.argv.slice(1), {
    stdio: "inherit",
    detached: true,
  });
  child.unref();
  process.exit(0);
}

/**
 * Start the auto-pull loop. Call once at server startup.
 *
 * On every tick:
 *  1. If idle, run `git pull --ff-only`.
 *  2. Compare current HEAD sha to the one recorded at startup (or last check).
 *     If it changed — from a pull, a local commit, a checkout, etc. — restart.
 */
export function startGitAutoPull(runManager: RunManager): void {
  if (!isGitRepo()) {
    console.log("[git-auto-pull] Not a git repository — auto-pull disabled.");
    return;
  }

  let knownHead = currentHead();
  console.log(
    `[git-auto-pull] Enabled — polling every ${POLL_INTERVAL_MS / 1000}s. Current HEAD: ${knownHead.slice(0, 8)}`,
  );

  const timer = setInterval(() => {
    // Always pull when idle (safe no-op if already up to date)
    if (isIdle(runManager)) {
      gitPull();
    }

    // Check for ANY head change — pull, local commit, checkout, rebase, etc.
    const head = currentHead();
    if (head !== knownHead) {
      console.log(
        `[git-auto-pull] HEAD changed: ${knownHead.slice(0, 8)} → ${head.slice(0, 8)} — restarting…`,
      );
      clearInterval(timer);
      restart();
    }
  }, POLL_INTERVAL_MS);

  // Don't prevent the process from exiting naturally.
  timer.unref();
}
