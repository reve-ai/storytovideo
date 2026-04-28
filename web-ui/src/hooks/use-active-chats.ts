import { useCallback, useEffect, useRef, useState } from "react";

export type ActiveChatScope = "shot" | "location" | "story";

export interface ActiveChat {
  scope: ActiveChatScope;
  scopeKey: string;
  startedAt: string;
  lastEventAt: string;
  currentToolName: string | null;
  queueDepth: number;
}

interface ActiveChatsResponse {
  runId: string;
  chats: ActiveChat[];
}

export interface UseActiveChatsResult {
  chats: ActiveChat[];
  refresh: () => void;
}

/**
 * Polls `/api/runs/:runId/chats/active` every `intervalMs` (default 2s) so the
 * TopBar can render a live indicator of in-flight chat agents. Polling is
 * cheap and avoids piggy-backing on the pipeline SSE. Callers can also force
 * an immediate refresh (e.g. after cancelling a chat).
 */
export function useActiveChats(runId: string | null, intervalMs = 2000): UseActiveChatsResult {
  const [chats, setChats] = useState<ActiveChat[]>([]);
  const inflight = useRef<AbortController | null>(null);
  const tickRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!runId) {
      setChats([]);
      tickRef.current = () => {};
      return;
    }
    let cancelled = false;
    const tick = async () => {
      inflight.current?.abort();
      const ctrl = new AbortController();
      inflight.current = ctrl;
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/chats/active`, {
          signal: ctrl.signal,
        });
        if (!res.ok) {
          if (!cancelled) setChats([]);
          return;
        }
        const data = (await res.json()) as ActiveChatsResponse;
        if (!cancelled) setChats(Array.isArray(data.chats) ? data.chats : []);
      } catch {
        // network error / aborted — keep previous state
      }
    };
    tickRef.current = () => { void tick(); };
    void tick();
    const t = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(t);
      inflight.current?.abort();
    };
  }, [runId, intervalMs]);

  const refresh = useCallback(() => tickRef.current(), []);
  return { chats, refresh };
}
