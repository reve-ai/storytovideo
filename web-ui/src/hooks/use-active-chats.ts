import { useEffect, useRef, useState } from "react";

export type ActiveChatScope = "shot" | "location" | "story";

export interface ActiveChat {
  scope: ActiveChatScope;
  scopeKey: string;
  startedAt: string;
  lastEventAt: string;
  currentToolName: string | null;
}

interface ActiveChatsResponse {
  runId: string;
  chats: ActiveChat[];
}

/**
 * Polls `/api/runs/:runId/chats/active` every `intervalMs` (default 2s) so the
 * TopBar can render a live indicator of in-flight chat agents. Polling is
 * cheap and avoids piggy-backing on the pipeline SSE.
 */
export function useActiveChats(runId: string | null, intervalMs = 2000): ActiveChat[] {
  const [chats, setChats] = useState<ActiveChat[]>([]);
  const inflight = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!runId) {
      setChats([]);
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
    void tick();
    const t = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(t);
      inflight.current?.abort();
    };
  }, [runId, intervalMs]);

  return chats;
}
