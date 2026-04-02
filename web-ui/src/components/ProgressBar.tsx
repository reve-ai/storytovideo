import { useEffect, useRef, useState } from "react";
import type { QueueName, QueueSnapshot, CostSummary } from "../stores/pipeline-store";
import { computeActiveElapsed, computeETA, fmtDuration } from "../utils/eta";

function fmtCost(usd: number): string {
  if (usd < 0.005) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

const CATEGORY_LABELS: Record<string, string> = {
  llm: "LLM",
  image: "Image Gen",
  video: "Video Gen",
};

const CATEGORY_EMOJI: Record<string, string> = {
  llm: "💬",
  image: "🖼",
  video: "🎬",
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

interface ProgressBarProps {
  queues: Record<QueueName, QueueSnapshot | null>;
  runStartTime: number | null;
  costSummary?: CostSummary | null;
}

export default function ProgressBar({ queues, runStartTime, costSummary }: ProgressBarProps) {
  const [now, setNow] = useState(Date.now());
  const [queueConcurrency, setQueueConcurrency] = useState<Record<QueueName, number> | undefined>();
  const [showCostBreakdown, setShowCostBreakdown] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const fetchedRef = useRef(false);

  // Fetch queue concurrency once from capabilities endpoint
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    fetch("/api/capabilities")
      .then((r) => r.json())
      .then((data) => {
        if (data.queueConcurrency) setQueueConcurrency(data.queueConcurrency);
      })
      .catch(() => {});
  }, []);

  // Tick every second while there's a run in progress
  useEffect(() => {
    if (!runStartTime) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [runStartTime]);

  // Close popover on outside click
  useEffect(() => {
    if (!showCostBreakdown) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowCostBreakdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showCostBreakdown]);

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
  const eta = allDone ? null : computeETA(queues, queueConcurrency);

  const hasCost = costSummary && costSummary.totalUsd > 0;

  // Sort models by cost descending
  const modelEntries = hasCost
    ? Object.entries(costSummary.byModel)
        .filter(([, v]) => v > 0)
        .sort(([, a], [, b]) => b - a)
    : [];

  const categoryEntries = hasCost
    ? Object.entries(costSummary.byCategory)
        .filter(([, v]) => v > 0)
        .sort(([, a], [, b]) => b - a)
    : [];

  return (
    <div className="px-4 py-2">
      <div className="mb-1 flex items-center gap-1 text-xs text-[--muted]">
        <span>
          {completedItems} / {totalItems} completed ({pct}%)
          {runStartTime ? ` · ${fmtDuration(elapsedSec)}` : ""}
          {runStartTime && !allDone
            ? eta !== null
              ? ` · ETA ~${fmtDuration(eta)}`
              : " · ETA calculating…"
            : ""}
        </span>
        {hasCost && (
          <span className="relative" ref={popoverRef}>
            <button
              type="button"
              onClick={() => setShowCostBreakdown((v) => !v)}
              className="ml-1 inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 font-medium text-[--accent] hover:bg-[--surface2] transition-colors"
              title="Click for cost breakdown"
            >
              💰 {fmtCost(costSummary.totalUsd)}
            </button>
            {showCostBreakdown && (
              <div
                className="absolute left-0 top-full z-50 mt-1 w-72 rounded-lg border border-[--border] shadow-lg"
                style={{ background: "#0f1117" }}
              >
                <div className="border-b border-[--border] px-3 py-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-[--foreground]">Cost Breakdown</span>
                    <span className="text-sm font-bold text-[--accent]">{fmtCost(costSummary.totalUsd)}</span>
                  </div>
                  <span className="text-[10px] text-[--muted]">{costSummary.entryCount} API calls</span>
                </div>

                {/* By category */}
                <div className="px-3 py-2">
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[--muted]">By Category</div>
                  {categoryEntries.map(([cat, cost]) => (
                    <div key={cat} className="flex items-center justify-between py-0.5">
                      <span className="text-xs text-[--foreground]">
                        {CATEGORY_EMOJI[cat] ?? "·"} {CATEGORY_LABELS[cat] ?? cat}
                      </span>
                      <span className="text-xs font-medium tabular-nums text-[--foreground]">{fmtCost(cost)}</span>
                    </div>
                  ))}
                </div>

                {/* By model */}
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
              </div>
            )}
          </span>
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

