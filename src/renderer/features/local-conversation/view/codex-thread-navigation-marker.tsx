import { useEffectEvent, useLayoutEffect } from "react";
import { scheduleAfterPaint } from "../../../lib/schedule-after-paint";
import { useConversationRuntimeOverride } from "../conversation-runtime";
import { codexThreadNavigation } from "../codex-thread-navigation";

/** Only the ordinary Codex Thread surface owns navigation visibility and route lifetime. */
export function CodexThreadNavigationMarker({
  threadId,
  isSideChat,
  contentReady,
}: {
  readonly threadId: string | null;
  readonly isSideChat: boolean;
  readonly contentReady: boolean;
}) {
  const override = useConversationRuntimeOverride();
  const navigationThreadId = !isSideChat && !override ? threadId : null;
  const enterRoute = useEffectEvent((id: string) => {
    codexThreadNavigation.routeChanged(id);
    codexThreadNavigation.start(id, contentReady ? "warm" : "cold", "local", "route_entered");
  });

  useLayoutEffect(() => {
    if (navigationThreadId === null) return;
    enterRoute(navigationThreadId);
    return () => codexThreadNavigation.abort(navigationThreadId);
  }, [navigationThreadId]);

  useLayoutEffect(() => {
    if (navigationThreadId === null) return;
    return codexThreadNavigation.viewEntered(navigationThreadId, {
      kind: "thread",
      state: contentReady ? "ready" : "hydrating",
    });
  }, [contentReady, navigationThreadId]);

  useLayoutEffect(() => {
    if (navigationThreadId === null || !contentReady) return;
    // Ready history can paint before execution attachment finishes, or require no attachment.
    codexThreadNavigation.hydrationFinished(navigationThreadId);
    const traceparent = codexThreadNavigation.getTrace(navigationThreadId)?.traceparent;
    return scheduleAfterPaint(
      () => {
        if (!codexThreadNavigation.isPending(navigationThreadId)) return;
        if (codexThreadNavigation.getTrace(navigationThreadId)?.traceparent !== traceparent) return;
        codexThreadNavigation.complete(navigationThreadId);
      },
      { requireVisibleAtPaint: true },
    );
  }, [contentReady, navigationThreadId]);

  return navigationThreadId !== null && contentReady ? (
    <span className="hidden" aria-hidden="true" />
  ) : null;
}
