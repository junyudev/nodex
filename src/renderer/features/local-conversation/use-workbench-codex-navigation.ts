import { useEffectEvent, useLayoutEffect } from "react";
import type { ProjectSession } from "../../../shared/types";
import { isCodexAgentBackendBinding } from "../../../shared/agent-backend";
import { CODEX_CLIENT_THREAD_ID_PREFIX } from "../../../shared/codex-client-thread";
import { registerAppCloseFlushHandler } from "../../lib/app-close-flush";
import type { WorkbenchWindowOwner } from "../../lib/workbench-window-owner";
import { areWorkbenchLocationsEqual } from "../../lib/workbench-window-state";
import { readLocalConversation } from "./local-conversation-store";
import { codexThreadNavigation } from "./codex-thread-navigation";
import { isAgentRuntimeConversationResident } from "./agent-runtime-conversation-owner";
import { runtimeConversationNavigation } from "./runtime-conversation-navigation";

/** A known native Thread starts before its Session route is committed or mounted. */
export function dispatchWorkbenchCodexNavigation(thread: ProjectSession["thread"]): void {
  if (
    !thread ||
    !isCodexAgentBackendBinding(thread.backendBinding) ||
    thread.threadId.startsWith(CODEX_CLIENT_THREAD_ID_PREFIX)
  )
    return;
  const conversation = readLocalConversation(thread.threadId, thread.executionHostId);
  if (conversation?.source?.sideConversation) return;
  codexThreadNavigation.start(thread.threadId, conversation?.canonicalState ? "warm" : "cold");
}

/**
 * One Window subscription covers history/deep-link routes and its close-before-flush lifetime,
 * for native Threads and Runtime conversations alike.
 */
export function useWorkbenchCodexNavigation(
  owner: WorkbenchWindowOwner,
  resolveSession: (sessionId: string) => Pick<ProjectSession, "thread" | "executionRef"> | null,
): void {
  const dispatch = useEffectEvent(() => {
    const location = owner.read().windowState.location;
    if (location.kind !== "session") {
      codexThreadNavigation.routeChanged(null);
      runtimeConversationNavigation.routeChanged(null);
      return;
    }
    const session = resolveSession(location.sessionId);
    const runtimeThreadId = session?.executionRef?.threadId;
    if (runtimeThreadId) {
      codexThreadNavigation.routeChanged(null);
      const target = { sessionId: location.sessionId, threadId: runtimeThreadId };
      runtimeConversationNavigation.dispatch(target, {
        resident: isAgentRuntimeConversationResident(target),
      });
      return;
    }
    runtimeConversationNavigation.routeChanged(null);
    const thread = session?.thread;
    if (!thread || !isCodexAgentBackendBinding(thread.backendBinding)) {
      codexThreadNavigation.routeChanged(null);
      return;
    }
    dispatchWorkbenchCodexNavigation(thread);
  });
  useLayoutEffect(() => {
    let location = owner.read().windowState.location;
    const unsubscribe = owner.subscribe(() => {
      const next = owner.read().windowState.location;
      if (areWorkbenchLocationsEqual(location, next)) return;
      location = next;
      dispatch();
    });
    const dispose = () => {
      codexThreadNavigation.dispose();
      runtimeConversationNavigation.dispose();
    };
    const unregisterClose = registerAppCloseFlushHandler(dispose);
    return () => {
      unsubscribe();
      unregisterClose();
      dispose();
    };
  }, [owner]);
}
