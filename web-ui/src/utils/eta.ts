import type {
  QueueName,
  QueueSnapshot,
  WorkItem,
} from "../stores/pipeline-store";

/** Format seconds into a human-readable duration string. */
export function fmtDuration(seconds: number): string {
  const s = Math.floor(seconds);
  if (s < 0) return "0s";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/**
 * Compute total active processing time in seconds by merging
 * [startedAt, completedAt|now] intervals across all items.
 * Overlapping intervals are merged so parallel work isn't double-counted.
 */
export function computeActiveElapsed(
  queues: Record<QueueName, QueueSnapshot | null>,
  now: number,
): number {
  const intervals: [number, number][] = [];

  for (const qName of ["llm", "image", "video"] as QueueName[]) {
    const q = queues[qName];
    if (!q) continue;
    for (const group of [q.inProgress, q.completed]) {
      if (!group) continue;
      for (const item of group) {
        if (!item.startedAt) continue;
        const start = new Date(item.startedAt).getTime();
        const end = item.completedAt
          ? new Date(item.completedAt).getTime()
          : now;
        if (end > start) {
          intervals.push([start, end]);
        }
      }
    }
  }

  if (intervals.length === 0) return 0;

  // Sort by start time, then merge overlapping intervals
  intervals.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [intervals[0]];
  for (let i = 1; i < intervals.length; i++) {
    const last = merged[merged.length - 1];
    const cur = intervals[i];
    if (cur[0] <= last[1]) {
      last[1] = Math.max(last[1], cur[1]);
    } else {
      merged.push(cur);
    }
  }

  let totalMs = 0;
  for (const [s, e] of merged) {
    totalMs += e - s;
  }
  return totalMs / 1000;
}

/** Collect all work items across all queues. */
export function getAllItems(
  queues: Record<QueueName, QueueSnapshot | null>,
): WorkItem[] {
  const items: WorkItem[] = [];
  for (const qName of ["llm", "image", "video"] as QueueName[]) {
    const q = queues[qName];
    if (!q) continue;
    for (const group of [
      q.inProgress,
      q.pending,
      q.completed,
      q.failed,
    ]) {
      if (group) items.push(...group);
    }
  }
  return items;
}

/**
 * Compute estimated remaining time in seconds.
 * Queues run in parallel so ETA is the max across queues.
 * Returns null when there's not enough data to estimate.
 */
export function computeETA(
  queues: Record<QueueName, QueueSnapshot | null>,
): number | null {
  const allItems = getAllItems(queues);
  if (allItems.length === 0) return null;

  // Average processing time per type from completed items
  const completedByType: Record<string, number[]> = {};
  const videoTimings: { elapsed: number; durationSeconds: number }[] = [];

  for (const item of allItems) {
    if (item.status !== "completed" || !item.startedAt || !item.completedAt)
      continue;
    const elapsed =
      (new Date(item.completedAt).getTime() -
        new Date(item.startedAt).getTime()) /
      1000;
    if (elapsed <= 0) continue;

    if (item.type === "generate_video") {
      const dur = (item.inputs as Record<string, unknown>)?.shot as
        | { durationSeconds?: number }
        | undefined;
      if (dur?.durationSeconds && dur.durationSeconds > 0) {
        videoTimings.push({ elapsed, durationSeconds: dur.durationSeconds });
      }
    }

    if (!completedByType[item.type]) completedByType[item.type] = [];
    completedByType[item.type].push(elapsed);
  }

  const avgByType: Record<string, number> = {};
  for (const [type, times] of Object.entries(completedByType)) {
    avgByType[type] = times.reduce((a, b) => a + b, 0) / times.length;
  }

  let avgTimePerDurSec: number | null = null;
  if (videoTimings.length > 0) {
    const rates = videoTimings.map((v) => v.elapsed / v.durationSeconds);
    avgTimePerDurSec = rates.reduce((a, b) => a + b, 0) / rates.length;
  }

  const perQueueRemaining: Record<string, number> = {};
  for (const qName of ["llm", "image", "video"] as QueueName[]) {
    const q = queues[qName];
    if (!q) continue;
    const remaining = [...(q.inProgress || []), ...(q.pending || [])];
    let queueEst = 0;
    let hasEstimate = false;
    for (const item of remaining) {
      if (item.type === "generate_video" && avgTimePerDurSec !== null) {
        const dur = (item.inputs as Record<string, unknown>)?.shot as
          | { durationSeconds?: number }
          | undefined;
        queueEst += avgTimePerDurSec * (dur?.durationSeconds || 0);
        hasEstimate = true;
      } else if (avgByType[item.type]) {
        queueEst += avgByType[item.type];
        hasEstimate = true;
      }
    }
    if (hasEstimate) perQueueRemaining[qName] = queueEst;
  }

  const estimates = Object.values(perQueueRemaining);
  if (estimates.length === 0) return null;
  return Math.max(...estimates);
}

