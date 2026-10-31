import { useMemo } from "react";
import type { PromptTurnTarget } from "../../../shared/prompt-turn";
import type { AgentRuntimeInspection } from "../../../shared/agent-runtime-api";
import { agentRuntimeRuntime } from "../../lib/agent-runtime-runtime";
import { useWorkbenchWindowOwner } from "../../lib/use-workbench-window-state";

export interface ChatMessageReveal extends PromptTurnTarget {
  readonly threadId: string;
}

/** A single window-local navigation intent; a later destination supersedes the previous one. */
export function createChatMessageRevealStore() {
  let pending: ChatMessageReveal | null = null;
  const listeners = new Set<() => void>();
  const publish = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    read: () => pending,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    request: (target: ChatMessageReveal) => {
      pending = target;
      publish();
    },
    consume: (target: ChatMessageReveal) => {
      if (pending !== target) return;
      pending = null;
      publish();
    },
  };
}

export const chatMessageRevealStore = createChatMessageRevealStore();

export function createOpenChatAtMessage(ports: {
  readonly inspect: (target: PromptTurnTarget) => Promise<AgentRuntimeInspection>;
  readonly openSession: (session: {
    readonly id: string;
    readonly projectId: string | null;
  }) => void;
  readonly reveal: (target: ChatMessageReveal) => void;
}) {
  let request = 0;
  /** Returns false when the Session no longer exists or a later navigation superseded this one. */
  return async (target: PromptTurnTarget): Promise<boolean> => {
    const generation = ++request;
    const chat = await ports.inspect(target).catch(() => null);
    if (!chat || generation !== request) return false;
    ports.reveal({ ...target, threadId: chat.threadId });
    ports.openSession({ id: chat.sessionId, projectId: chat.projectId });
    return true;
  };
}

/** Opens the receiving chat and asks its transcript owner to reveal the exact user message. */
export function useOpenChatAtMessage(): (target: PromptTurnTarget) => Promise<boolean> {
  const owner = useWorkbenchWindowOwner();
  return useMemo(
    () =>
      createOpenChatAtMessage({
        inspect: (target) => agentRuntimeRuntime.inspect({ sessionId: target.sessionId }),
        openSession: owner.selectSession,
        reveal: chatMessageRevealStore.request,
      }),
    [owner],
  );
}
