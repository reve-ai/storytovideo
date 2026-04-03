/**
 * Zero-downtime restart entrypoint using Node's cluster module.
 *
 * Primary process:
 *   - Long-lived, never restarts
 *   - Runs git polling for auto-pull
 *   - On change: forks a new worker, waits for "ready", then kills the old one
 *
 * Worker process:
 *   - Runs the actual queue-server (HTTP + Vite + SSE)
 *   - Shares the listening socket via the cluster module
 *   - Sends process.send("ready") once the server is listening
 */
import "dotenv/config";
import cluster from "node:cluster";
import { isGitRepo, currentHead, gitPull, POLL_INTERVAL_MS } from "./git-auto-pull.js";

if (cluster.isPrimary) {
  // -----------------------------------------------------------------------
  // PRIMARY: manage workers + git auto-pull
  // -----------------------------------------------------------------------

  let activeWorker = cluster.fork();
  console.log(`[primary] Started, pid ${process.pid}`);

  // --- Git auto-pull (runs in the primary, not in workers) ---------------

  if (isGitRepo()) {
    let knownHead = currentHead();
    console.log(
      `[primary] Git auto-pull enabled — polling every ${POLL_INTERVAL_MS / 1000}s. HEAD: ${knownHead.slice(0, 8)}`,
    );

    const timer = setInterval(() => {
      gitPull();

      const head = currentHead();
      if (head !== knownHead) {
        console.log(
          `[primary] HEAD changed: ${knownHead.slice(0, 8)} → ${head.slice(0, 8)} — rolling restart…`,
        );
        knownHead = head;
        rollRestart();
      }
    }, POLL_INTERVAL_MS);
    timer.unref();
  } else {
    console.log("[primary] Not a git repository — auto-pull disabled.");
  }

  // --- Rolling restart: fork new worker, wait for "ready", kill old ------

  let restartInProgress = false;

  function rollRestart(): void {
    if (restartInProgress) return;
    restartInProgress = true;

    console.log("[primary] Forking new worker...");
    const newWorker = cluster.fork();

    newWorker.on("message", (msg) => {
      if (msg === "ready") {
        console.log(
          `[primary] New worker ${newWorker.process.pid} ready, killing old worker ${activeWorker.process.pid}`,
        );
        const old = activeWorker;
        activeWorker = newWorker;
        restartInProgress = false;

        old.disconnect();
        // Force kill if it doesn't exit within 5s
        const killTimer = setTimeout(() => {
          if (!old.isDead()) old.kill();
        }, 5000);
        killTimer.unref();
      }
    });

    newWorker.on("exit", (code) => {
      // If the new worker crashes before becoming ready, keep the old one
      if (newWorker !== activeWorker) {
        console.error(
          `[primary] New worker failed to start (exit code ${code}), keeping old worker`,
        );
        restartInProgress = false;
      }
    });
  }

  // --- Respawn if the active worker crashes outside of a restart cycle ----

  cluster.on("exit", (worker, code) => {
    if (worker === activeWorker && code !== 0) {
      console.error(`[primary] Active worker died (code ${code}), respawning...`);
      activeWorker = cluster.fork();
    }
  });
} else {
  // -----------------------------------------------------------------------
  // WORKER: run the actual app server
  // -----------------------------------------------------------------------

  import("./queue-server.js").then(async ({ startServer }) => {
    await startServer({ skipGitAutoPull: true });
    // startServer() resolves after the server is listening and all async
    // init (settings, vite) is complete — safe to signal readiness.
    console.log(`[worker ${process.pid}] Ready, signaling primary`);
    process.send!("ready");
  });
}
