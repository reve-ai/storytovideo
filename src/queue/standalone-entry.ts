/**
 * Standalone entrypoint — starts the queue server directly (no cluster).
 * Use this for local development. For zero-downtime restarts, use cluster-entry.ts.
 */
import { startServer } from "./queue-server.js";

void startServer();
