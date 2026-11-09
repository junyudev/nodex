import type { AgentRuntimeSessionEvent } from "../../shared/agent-runtime-api";
import type { ProjectSessionsChangeEvent } from "../../shared/ipc-api";
import { resolveRendererTransport } from "./renderer-transport";

/** Metadata invalidations coalesce into one refresh; a sparse repair covers provider-only deltas. */
export function createHostSessionObservation(
  subscribeChanges?: (listener: (event: ProjectSessionsChangeEvent) => void) => () => void,
) {
  const targets = new Map<
    string,
    {
      sessionId: string;
      threadId: string;
      dirty: boolean;
      refreshedAt: number;
      listeners: Set<(event: AgentRuntimeSessionEvent) => void>;
    }
  >();
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopChanges: (() => void) | undefined;
  return (
    target: { readonly sessionId: string; readonly threadId: string },
    listener: (event: AgentRuntimeSessionEvent) => void,
  ) => {
    const key = JSON.stringify([target.sessionId, target.threadId]);
    if (!targets.has(key) && targets.size >= 8)
      throw new Error("Observe at most eight hosted chats at once");
    const entry = targets.get(key) ?? {
      ...target,
      dirty: false,
      refreshedAt: Date.now(),
      listeners: new Set(),
    };
    targets.set(key, entry);
    entry.listeners.add(listener);
    stopChanges ??= subscribeChanges?.((event) => {
      const detail = event.detailInvalidation;
      for (const entry of targets.values())
        if (detail.kind === "all" || detail.sessionIds.includes(entry.sessionId))
          entry.dirty = true;
    });
    timer ??= setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      for (const entry of targets.values()) {
        if (!entry.dirty && Date.now() - entry.refreshedAt < 15_000) continue;
        entry.dirty = false;
        entry.refreshedAt = Date.now();
        for (const notify of entry.listeners)
          notify({
            type: "reset-required",
            sessionId: entry.sessionId,
            threadId: entry.threadId,
            reason: "host-refresh",
          });
      }
    }, 1_000);
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) targets.delete(key);
      if (targets.size > 0) return;
      clearInterval(timer);
      timer = undefined;
      stopChanges?.();
      stopChanges = undefined;
    };
  };
}

export const observeHostSession = createHostSessionObservation((listener) =>
  resolveRendererTransport().subscribeProjectSessionChanges(listener),
);
