import type {
  CodexConversationChildMembership,
  CodexConversationSnapshot,
} from "../../../shared/types";
import { useExternalSelector } from "../../lib/use-external-store-selector";
import { useCallback } from "react";
import type { ConversationRuntime } from "./conversation-runtime";
import { isVisibleNativeTaskMembership } from "./native-task-presentation";

const EMPTY_MEMBERSHIPS: CodexConversationChildMembership[] = [];

interface ConversationRuntimeTaskObservation {
  readonly membership: CodexConversationChildMembership;
  readonly conversation: CodexConversationSnapshot | null;
}

const EMPTY_TASK_OBSERVATIONS: readonly ConversationRuntimeTaskObservation[] = [];

function subscribeTaskObservations(
  runtime: ConversationRuntime,
  threadId: string | null,
  listener: () => void,
): () => void {
  if (runtime.subscribeChildObservations)
    return runtime.subscribeChildObservations(threadId, listener);

  let disposed = false;
  const childSubscriptions = new Map<string, () => void>();
  const reconcileChildren = () => {
    const childIds = new Set(
      runtime.read(threadId)
        ? runtime
            .children(threadId)
            .filter(isVisibleNativeTaskMembership)
            .map((membership) => membership.threadId)
        : [],
    );
    childIds.delete(threadId ?? "");
    for (const [id, unsubscribe] of childSubscriptions) {
      if (childIds.has(id)) continue;
      unsubscribe();
      childSubscriptions.delete(id);
    }
    for (const id of childIds) {
      if (childSubscriptions.has(id)) continue;
      childSubscriptions.set(
        id,
        runtime.subscribe(id, () => {
          if (!disposed && childSubscriptions.has(id)) listener();
        }),
      );
    }
  };
  const unsubscribeParent = runtime.subscribe(threadId, () => {
    if (disposed) return;
    reconcileChildren();
    listener();
  });
  reconcileChildren();
  return () => {
    disposed = true;
    unsubscribeParent();
    for (const unsubscribe of childSubscriptions.values()) unsubscribe();
    childSubscriptions.clear();
  };
}

/** Rendering consumes actual membership and child snapshots, including child-only publications. */
export function useConversationRuntimeTaskObservations(
  runtime: ConversationRuntime | null,
  threadId: string | null,
): readonly ConversationRuntimeTaskObservation[] {
  const subscribe = useCallback(
    (listener: () => void) =>
      runtime ? subscribeTaskObservations(runtime, threadId, listener) : () => {},
    [runtime, threadId],
  );
  const read = useCallback(() => {
    if (!runtime?.read(threadId)) return EMPTY_TASK_OBSERVATIONS;
    return runtime
      .children(threadId)
      .filter(isVisibleNativeTaskMembership)
      .map((membership) => ({ membership, conversation: runtime.read(membership.threadId) }));
  }, [runtime, threadId]);
  return useExternalSelector(
    subscribe,
    read,
    (left, right) =>
      left.length === right.length &&
      left.every(
        (entry, index) =>
          entry.membership === right[index].membership &&
          entry.conversation === right[index].conversation,
      ),
  );
}

/** Observe the selected provider snapshot rather than rereading it during render. */
export function useConversationRuntimeValue<T>(
  runtime: ConversationRuntime,
  conversationId: string | null,
  selector: (conversation: CodexConversationSnapshot | null) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  return useExternalSelector(
    (listener) => runtime.subscribe(conversationId, listener),
    () => selector(runtime.read(conversationId)),
    isEqual,
  );
}

/** A membership publication is independent of a parent's transcript snapshot. */
export function useConversationRuntimeChildMemberships(
  runtime: ConversationRuntime | null,
  threadId: string | null,
): CodexConversationChildMembership[] {
  return useExternalSelector(
    (listener) => (runtime ? runtime.subscribe(threadId, listener) : () => {}),
    () => (runtime ? [...runtime.children(threadId)] : EMPTY_MEMBERSHIPS),
    (left, right) =>
      left.length === right.length && left.every((entry, index) => entry === right[index]),
  );
}
