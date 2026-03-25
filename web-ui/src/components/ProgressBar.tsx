import { useEffect, useState } from "react";
import type { QueueName, QueueSnapshot } from "../stores/pipeline-store";
import { computeActiveElapsed, computeETA, fmtDuration } from "../utils/eta";

interface ProgressBarProps {
  queues: Record<QueueName, QueueSnapshot | null>;
  runStartTime: number | null;
}

export default function ProgressBar({ queues, runStartTime }: ProgressBarProps) {
  const [now, setNow] = useState(Date.now());

  // Tick every second while there's a run in progress
  useEffect(() => {
    if (!runStartTime) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [runStartTime]);

  let totalItems = 0;
  let completedItems = 0;
  for (const qName of ["llm", "image", "video"] as QueueName[]) {
    const q = queues[qName];
    if (!q) continue;
    for (const g of [q.inProgress, q.pending, q.completed, q.failed]) {
      if (g) totalItems += g.length;
    }
    completedItems += (q.completed || []).length;
  }

  if (totalItems === 0) {
    return (
      <div className="px-4 py-2 text-xs text-[--muted]">No run selected</div>
    );
  }

  const pct = Math.round((completedItems / totalItems) * 100);
  const allDone = completedItems === totalItems;
  const elapsedSec = runStartTime ? computeActiveElapsed(queues, now) : 0;
  const eta = allDone ? null : computeETA(queues);

  let text = `${completedItems} / ${totalItems} items completed (${pct}%)`;
  if (runStartTime) {
    text += ` · Elapsed: ${fmtDuration(elapsedSec)}`;
    if (!allDone) {
      text += eta !== null ? ` · ETA: ~${fmtDuration(eta)}` : ` · ETA: calculating…`;
    }
  }

  return (
    <div className="px-4 py-2">
      <div className="mb-1 text-xs text-[--muted]">{text}</div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[--surface2]">
        <div
          className="h-full rounded-full bg-[--accent] transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

