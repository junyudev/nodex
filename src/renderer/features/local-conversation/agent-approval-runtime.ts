import {
  AGENT_APPROVAL_TYPING_IDLE_MS,
  initialAgentApprovalTypingGuard,
  reduceAgentApprovalTypingGuard,
  type AgentApprovalTypingEvent,
} from "@/lib/agent-approval-typing-guard";
import type { AgentApprovalResponse, AgentPendingApproval } from "./agent-approval";

export interface AgentApprovalSnapshot {
  readonly pending: readonly AgentPendingApproval[];
  readonly held: ReadonlySet<string>;
  readonly responding: ReadonlySet<string>;
  readonly suppressedItemIds: ReadonlySet<string>;
}
export const EMPTY_AGENT_APPROVAL_SNAPSHOT: AgentApprovalSnapshot = {
  pending: [],
  held: new Set(),
  responding: new Set(),
  suppressedItemIds: new Set(),
};

/**
 * The approvals a Send refuses: those the person can see and answer now. A request held while
 * they typed was never seen, and one already being answered has its answer in flight.
 */
export function approvalsRefusedBySend(
  snapshot: AgentApprovalSnapshot,
): readonly AgentPendingApproval[] {
  return snapshot.pending.filter(
    (approval) =>
      !snapshot.responding.has(approval.requestId) && !snapshot.held.has(approval.requestId),
  );
}

/** Conversation-local interaction state; responses still enter Main's single command owner. */
export function createAgentApprovalRuntime(
  deliver: (approval: AgentPendingApproval, response: AgentApprovalResponse) => Promise<void>,
) {
  let snapshot = EMPTY_AGENT_APPROVAL_SNAPSHOT;
  let guard = initialAgentApprovalTypingGuard();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let projectionIdentity = "";
  const listeners = new Set<() => void>();
  const publish = () => {
    for (const listener of listeners) listener();
  };
  const interact = (event: AgentApprovalTypingEvent) => {
    guard = reduceAgentApprovalTypingGuard(guard, event);
    const heldChanged =
      snapshot.held.size !== guard.held.size ||
      [...snapshot.held].some((id) => !guard.held.has(id));
    if (heldChanged) snapshot = { ...snapshot, held: guard.held };
    clearTimeout(idleTimer);
    if (guard.held.size > 0)
      idleTimer = setTimeout(
        () => interact({ type: "idle" }),
        Math.max(0, guard.lastTypedAt + AGENT_APPROVAL_TYPING_IDLE_MS - Date.now()),
      );
    if (heldChanged) publish();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    interact,
    update: (input: Pick<AgentApprovalSnapshot, "pending" | "suppressedItemIds">) => {
      const identity = JSON.stringify([input.pending, [...input.suppressedItemIds]]);
      if (identity === projectionIdentity) return;
      projectionIdentity = identity;
      snapshot = { ...snapshot, ...input };
      interact({
        type: "requests",
        ids: input.pending.map((approval) => approval.requestId),
        now: Date.now(),
      });
      publish();
    },
    respond: async (requestId: string, response: AgentApprovalResponse) => {
      const approval = snapshot.pending.find((entry) => entry.requestId === requestId);
      if (!approval?.live || snapshot.held.has(requestId))
        throw new Error("This approval cannot be answered now");
      if (snapshot.responding.has(requestId))
        throw new Error("This approval is already being answered");
      if (
        !approval.options.some(
          (option) =>
            option.decision === response.decision &&
            (response.optionId === undefined || option.optionId === response.optionId),
        )
      )
        throw new Error("This approval does not offer that decision");
      snapshot = { ...snapshot, responding: new Set([...snapshot.responding, requestId]) };
      publish();
      try {
        await deliver(approval, response);
      } finally {
        snapshot = {
          ...snapshot,
          responding: new Set([...snapshot.responding].filter((id) => id !== requestId)),
        };
        publish();
      }
    },
    clear: () => {
      clearTimeout(idleTimer);
      projectionIdentity = "";
      guard = initialAgentApprovalTypingGuard();
      snapshot = EMPTY_AGENT_APPROVAL_SNAPSHOT;
      publish();
    },
  };
}
export type AgentApprovalRuntime = ReturnType<typeof createAgentApprovalRuntime>;
