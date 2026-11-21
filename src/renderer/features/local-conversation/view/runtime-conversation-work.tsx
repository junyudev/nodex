import {
  Profiler,
  useEffectEvent,
  useLayoutEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { rendererRuntimeWork } from "../../../lib/runtime-work";
import { scheduleAfterPaint } from "../../../lib/schedule-after-paint";
import {
  agentRuntimeConversationWork,
  isAgentRuntimeConversationResident,
} from "../agent-runtime-conversation-owner";
import { useConversationRuntimeOverride, type ConversationRuntime } from "../conversation-runtime";
import { runtimeConversationNavigation } from "../runtime-conversation-navigation";

type CurrentProjection = "pending" | "empty" | "content";

const noSubscription = () => () => {};

/** Whether the conversation's current projection is installed, and whether it has any item. */
function readCurrentProjection(
  runtime: ConversationRuntime | null,
  threadId: string | null,
): CurrentProjection {
  if (!runtime || !threadId || !runtime.contentSource?.(threadId)) return "pending";
  const structure = runtime.transcriptReadOwner?.(threadId)?.readStructure();
  if (!structure) return "pending";
  return structure.turns.some((turn) => turn.itemIds.some((itemId) => itemId !== undefined))
    ? "content"
    : "empty";
}

/**
 * The ordinary Runtime conversation surface owns its navigation's route lifetime and the moment
 * its current projection, with content or without, has painted.
 */
export function RuntimeConversationNavigationMarker({
  threadId,
  isSideChat,
}: {
  readonly threadId: string | null;
  readonly isSideChat: boolean;
}) {
  const runtime = useConversationRuntimeOverride();
  const sessionId = isSideChat ? null : (runtime?.sessionId ?? null);
  const provider = runtime?.kind ?? "unknown";
  const measured = sessionId !== null && threadId !== null ? runtime : null;
  // Outside a pending navigation the projection is never read, so streaming costs one check.
  const projection = useSyncExternalStore(
    measured ? (listener) => measured.subscribe(threadId, listener) : noSubscription,
    () =>
      sessionId !== null &&
      threadId !== null &&
      runtimeConversationNavigation.isPending({ sessionId, threadId })
        ? readCurrentProjection(measured, threadId)
        : "pending",
  );

  // The provider names the measurement; learning it later does not re-enter the route.
  const enterRoute = useEffectEvent((target: { sessionId: string; threadId: string }) =>
    runtimeConversationNavigation.enter(target, {
      resident: isAgentRuntimeConversationResident(target),
      provider,
    }),
  );
  useLayoutEffect(() => {
    if (sessionId === null || threadId === null) return;
    return enterRoute({ sessionId, threadId });
  }, [sessionId, threadId]);

  useLayoutEffect(() => {
    if (sessionId === null || threadId === null || projection === "pending") return;
    const target = { sessionId, threadId };
    runtimeConversationNavigation.committed(target, projection === "empty");
    return scheduleAfterPaint(() => runtimeConversationNavigation.visible(target), {
      requireVisibleAtPaint: true,
    });
  }, [projection, sessionId, threadId]);

  return null;
}

/** Counts a Runtime transcript's React commits under its conversation's current work. */
export function RuntimeTranscriptWork({
  threadId,
  children,
}: {
  readonly threadId: string | null;
  readonly children: ReactNode;
}) {
  const sessionId = useConversationRuntimeOverride()?.sessionId ?? null;
  const ledger = rendererRuntimeWork();
  if (!ledger || sessionId === null || threadId === null) return children;
  return (
    <Profiler
      id="runtime-transcript"
      onRender={() => {
        const work = agentRuntimeConversationWork({ sessionId, threadId });
        if (work !== null) ledger.record(work, "renderer.commit");
      }}
    >
      {children}
    </Profiler>
  );
}
