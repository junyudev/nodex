import { useLayoutEffect, useSyncExternalStore } from "react";
import type { ThreadSummaryPanelContentProps } from "./thread-floating-summary-panel";

/**
 * The conversation stage owns its summary; the header popover that shows it in a narrow
 * layout presents the same content rather than deriving a second one.
 */
const contents = new Map<string, ThreadSummaryPanelContentProps>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The primary stage publishes its conversation's summary while it is mounted. */
export function usePublishThreadSummaryContent(
  threadId: string | null,
  content: ThreadSummaryPanelContentProps,
  enabled: boolean,
): void {
  useLayoutEffect(() => {
    if (!enabled || !threadId) return;
    contents.set(threadId, content);
    notify();
    return () => {
      if (contents.get(threadId) !== content) return;
      contents.delete(threadId);
      notify();
    };
  }, [content, enabled, threadId]);
}

export function useThreadSummaryContent(
  threadId: string | null,
): ThreadSummaryPanelContentProps | null {
  return useSyncExternalStore(subscribe, () =>
    threadId ? (contents.get(threadId) ?? null) : null,
  );
}
