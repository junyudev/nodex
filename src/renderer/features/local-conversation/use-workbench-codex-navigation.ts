import { useEffectEvent, useLayoutEffect } from "react";
import type { ProjectSession } from "../../../shared/types";
import { isCodexAgentBackendBinding } from "../../../shared/agent-backend";
import { CODEX_CLIENT_THREAD_ID_PREFIX } from "../../../shared/codex-client-thread";
import { registerAppCloseFlushHandler } from "../../lib/app-close-flush";
import type { WorkbenchWindowOwner } from "../../lib/workbench-window-owner";
import { areWorkbenchLocationsEqual } from "../../lib/workbench-window-state";
import { readLocalConversation } from "./local-conversation-store";
import { codexThreadNavigation } from "./codex-thread-navigation";

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

/** One Window subscription covers history/deep-link routes and its close-before-flush lifetime. */
export function useWorkbenchCodexNavigation(
  owner: WorkbenchWindowOwner,
  resolveSession: (sessionId: string) => Pick<ProjectSession, "thread"> | null,
): void {
  const dispatch = useEffectEvent(() => {
    const location = owner.read().windowState.location;
    if (location.kind !== "session") {
      codexThreadNavigation.routeChanged(null);
      return;
    }
    const thread = resolveSession(location.sessionId)?.thread;
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
    const unregisterClose = registerAppCloseFlushHandler(() => codexThreadNavigation.dispose());
    return () => {
      unsubscribe();
      unregisterClose();
      codexThreadNavigation.dispose();
    };
  }, [owner]);
}
