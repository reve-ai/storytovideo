import { useEffect, useRef, useState, type ReactNode } from "react";
import type { QueueName, QueueSnapshot, CostSummary, WorkItem } from "../stores/pipeline-store";
import { computeActiveElapsed, computeETA, fmtDuration } from "../utils/eta";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtCost(usd: number): string {
  if (usd < 0.005) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** Sum wall-clock seconds for completed items (startedAt → completedAt). */
function itemDurationSec(item: WorkItem): number {
  if (!item.startedAt || !item.completedAt) return 0;
  return Math.max(0, (new Date(item.completedAt).getTime() - new Date(item.startedAt).getTime()) / 1000);
}

const QUEUE_LABELS: Record<string, string> = { llm: "LLM", image: "Image", video: "Video" };
const QUEUE_EMOJI: Record<string, string> = { llm: "💬", image: "🖼", video: "🎬" };

const TYPE_LABELS: Record<string, string> = {
  story_to_script: "Story → Script",
  analyze_story: "Analyze Story",
  artifact: "Artifact",
  name_run: "Name Run",
  plan_shots: "Plan Shots",
  generate_asset: "Generate Asset",
  generate_frame: "Generate Frame",
  generate_video: "Generate Video",
  analyze_video: "Analyze Video",
  assemble: "Assemble",
};

const MODEL_LABELS: Record<string, string> = {
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "gpt-5.4": "GPT-5.4",
  "gpt-4.1-mini": "GPT-4.1 Mini",
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro",
  "gemini-3.1-flash-image-preview": "Gemini Flash Image",
  "grok-imagine-image": "Grok Image",
  "reve": "Reve",
  "grok-imagine-video": "Grok Video",
  "veo-3.1-generate-preview": "Veo 3.1",
  "ltx": "LTX (self-hosted)",
};

// ---------------------------------------------------------------------------
// Reusable popover dropdown
// ---------------------------------------------------------------------------

function BreakdownPopover({
  open,
  onToggle,
  label,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  label: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onToggle();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onToggle]);

  return (
    <span className="relative" ref={ref}>
      <button
        type="button"
        onClick={onToggle}
        className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 font-medium text-[--accent] hover:bg-[--surface2] transition-colors"
      >
        {label}
      </button>
      {open && (
        <div
          className="absolute left-0 top-full z-50 mt-1 w-72 rounded-lg border border-[--border] shadow-lg"
          style={{ background: "#0f1117" }}
        >
          {children}
        </div>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Time breakdown content
// ---------------------------------------------------------------------------

function computeTimeBreakdown(queues: Record<QueueName, QueueSnapshot | null>) {
  const byQueue: Record<string, { total: number; count: number }> = {};
  const byType: Record<string, { total: number; count: number }> = {};

  for (const qName of ["llm", "image", "video"] as QueueName[]) {
    const q = queues[qName];
    if (!q) continue;
    for (const item of q.completed) {
      const dur = itemDurationSec(item);
      if (dur <= 0) continue;

      if (!byQueue[qName]) byQueue[qName] = { total: 0, count: 0 };
      byQueue[qName].total += dur;
      byQueue[qName].count += 1;

      if (!byType[item.type]) byType[item.type] = { total: 0, count: 0 };
      byType[item.type].total += dur;
      byType[item.type].count += 1;
    }
  }

  return { byQueue, byType };
}

function TimeBreakdownContent({ queues, elapsedSec }: { queues: Record<QueueName, QueueSnapshot | null>; elapsedSec: number }) {
  const { byQueue, byType } = computeTimeBreakdown(queues);
  const queueEntries = Object.entries(byQueue).sort(([, a], [, b]) => b.total - a.total);
  const typeEntries = Object.entries(byType).sort(([, a], [, b]) => b.total - a.total);
  const totalProcessing = queueEntries.reduce((s, [, v]) => s + v.total, 0);

  return (
    <>
      <div className="border-b border-[--border] px-3 py-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-[--foreground]">Time Breakdown</span>
          <span className="text-sm font-bold text-[--accent]">{fmtDuration(elapsedSec)}</span>
        </div>
        <span className="text-[10px] text-[--muted]">
          {fmtDuration(Math.round(totalProcessing))} total processing time
        </span>
      </div>

      {/* By queue */}
      <div className="px-3 py-2">
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[--muted]">By Queue</div>
        {queueEntries.map(([q, { total, count }]) => (
          <div key={q} className="flex items-center justify-between py-0.5">
            <span className="text-xs text-[--foreground]">
              {QUEUE_EMOJI[q] ?? "·"} {QUEUE_LABELS[q] ?? q}
              <span className="text-[--muted] ml-1">×{count}</span>
            </span>
            <span className="text-xs font-medium tabular-nums text-[--foreground]">
              {fmtDuration(Math.round(total))}
              <span className="text-[10px] text-[--muted] ml-1">
                (avg {fmtDuration(Math.round(total / count))})
              </span>
            </span>
          </div>
        ))}
      </div>

      {/* By step type */}
      {typeEntries.length > 0 && (
        <div className="border-t border-[--border] px-3 py-2">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[--muted]">By Step</div>
          {typeEntries.map(([type, { total, count }]) => {
            const pctOfTotal = totalProcessing > 0 ? Math.round((total / totalProcessing) * 100) : 0;
            return (
              <div key={type} className="flex items-center justify-between py-0.5">
                <span className="text-xs text-[--foreground] truncate mr-2">
                  {TYPE_LABELS[type] ?? type}
                  <span className="text-[--muted] ml-1">×{count}</span>
                </span>
                <span className="text-xs tabular-nums text-[--muted] whitespace-nowrap">
                  {fmtDuration(Math.round(total))} <span className="text-[10px]">({pctOfTotal}%)</span>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Cost breakdown content
// ---------------------------------------------------------------------------

function CostBreakdownContent({ costSummary }: { costSummary: CostSummary }) {
  const categoryEntries = Object.entries(costSummary.byCategory)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a);
  const modelEntries = Object.entries(costSummary.byModel)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a);

  return (
    <>
      <div className="border-b border-[--border] px-3 py-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-[--foreground]">Cost Breakdown</span>
          <span className="text-sm font-bold text-[--accent]">{fmtCost(costSummary.totalUsd)}</span>
        </div>
        <span className="text-[10px] text-[--muted]">{costSummary.entryCount} API calls</span>
      </div>

      <div className="px-3 py-2">
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[--muted]">By Category</div>
        {categoryEntries.map(([cat, cost]) => (
          <div key={cat} className="flex items-center justify-between py-0.5">
            <span className="text-xs text-[--foreground]">
              {QUEUE_EMOJI[cat] ?? "·"} {QUEUE_LABELS[cat] ?? cat}
            </span>
            <span className="text-xs font-medium tabular-nums text-[--foreground]">{fmtCost(cost)}</span>
          </div>
        ))}
      </div>

      {modelEntries.length > 0 && (
        <div className="border-t border-[--border] px-3 py-2">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[--muted]">By Model</div>
          {modelEntries.map(([model, cost]) => {
            const pctOfTotal = Math.round((cost / costSummary.totalUsd) * 100);
            return (
              <div key={model} className="flex items-center justify-between py-0.5">
                <span className="text-xs text-[--foreground] truncate mr-2">{MODEL_LABELS[model] ?? model}</span>
                <span className="text-xs tabular-nums text-[--muted] whitespace-nowrap">
                  {fmtCost(cost)} <span className="text-[10px]">({pctOfTotal}%)</span>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main ProgressBar
// ---------------------------------------------------------------------------

interface ProgressBarProps {
  queues: Record<QueueName, QueueSnapshot | null>;
  runStartTime: number | null;
  costSummary?: CostSummary | null;
}

export default function ProgressBar({ queues, runStartTime, costSummary }: ProgressBarProps) {
  const [now, setNow] = useState(Date.now());
  const [queueConcurrency, setQueueConcurrency] = useState<Record<QueueName, number> | undefined>();
  const [openPopover, setOpenPopover] = useState<"time" | "cost" | null>(null);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    fetch("/api/capabilities")
      .then((r) => r.json())
      .then((data) => { if (data.queueConcurrency) setQueueConcurrency(data.queueConcurrency); })
      .catch(() => {});
  }, []);

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
    return <div className="px-4 py-2 text-xs text-[--muted]">No run selected</div>;
  }

  const pct = Math.round((completedItems / totalItems) * 100);
  const allDone = completedItems === totalItems;
  const elapsedSec = runStartTime ? computeActiveElapsed(queues, now) : 0;
  const eta = allDone ? null : computeETA(queues, queueConcurrency);
  const hasCost = costSummary && costSummary.totalUsd > 0;
  const hasTime = runStartTime && elapsedSec > 0;

  return (
    <div className="px-4 py-2">
      <div className="mb-1 flex items-center gap-1 text-xs text-[--muted]">
        <span>{completedItems} / {totalItems} completed ({pct}%)</span>

        {hasTime && (
          <>
            <span>·</span>
            <BreakdownPopover
              open={openPopover === "time"}
              onToggle={() => setOpenPopover((v) => v === "time" ? null : "time")}
              label={<>⏱ {fmtDuration(elapsedSec)}</>}
            >
              <TimeBreakdownContent queues={queues} elapsedSec={elapsedSec} />
            </BreakdownPopover>
            {!allDone && (
              <span>
                {eta !== null ? `· ETA ~${fmtDuration(eta)}` : "· ETA calculating…"}
              </span>
            )}
          </>
        )}

        {hasCost && (
          <>
            <span>·</span>
            <BreakdownPopover
              open={openPopover === "cost"}
              onToggle={() => setOpenPopover((v) => v === "cost" ? null : "cost")}
              label={<>💰 {fmtCost(costSummary.totalUsd)}</>}
            >
              <CostBreakdownContent costSummary={costSummary} />
            </BreakdownPopover>
          </>
        )}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[--surface2]">
        <div
          className="h-full rounded-full bg-[--accent] transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

