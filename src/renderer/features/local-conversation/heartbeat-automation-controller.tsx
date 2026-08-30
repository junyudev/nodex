import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CodexConversationSnapshot,
  CodexHeartbeatAutomationPermissions,
  CodexHeartbeatAutomationThreadStateChangedInput,
  CodexPermissionState,
  CodexScheduledAutomation,
} from "../../../shared/types";
import {
  publishCodexHeartbeatEnabled,
  publishCodexHeartbeatThreadState,
} from "../../lib/codex-automation-runtime";
import { useCodexScheduledAutomations } from "../../lib/use-codex-scheduled-automations";
import {
  useConversationSubset,
  useDefaultCodexAppServerManager,
  useLocalConversationConnection,
} from "./local-conversation-store";

const HEARTBEAT_RESUME_RETRY_MS = 750;

export function listHeartbeatAutomationTargetThreadIds(
  automations: readonly CodexScheduledAutomation[],
): string[] {
  return Array.from(
    new Set(
      automations.flatMap((automation) => {
        if (automation.kind !== "heartbeat") return [];
        if (automation.status !== "ACTIVE") return [];
        const targetThreadId = automation.targetThreadId?.trim() ?? "";
        return targetThreadId ? [targetThreadId] : [];
      }),
    ),
  );
}

export function shouldResumeHeartbeatAutomationTarget(
  conversation: CodexConversationSnapshot | null,
): boolean {
  if (!conversation) return true;
  return conversation.resumeState === "needs_resume";
}

export function buildHeartbeatAutomationPermissions(
  permissionState: CodexPermissionState | null,
): CodexHeartbeatAutomationPermissions | null {
  if (!permissionState || permissionState.effectivePreset === "custom") return null;

  return {
    approvalPolicy: permissionState.approvalPolicy,
    approvalsReviewer: permissionState.approvalsReviewer,
    sandboxPolicy: permissionState.sandbox,
  };
}

export function buildHeartbeatAutomationThreadState(input: {
  threadId: string;
  conversation: CodexConversationSnapshot | null;
  permissionState: CodexPermissionState | null;
  streamRole: "owner" | "follower" | null;
}): CodexHeartbeatAutomationThreadStateChangedInput {
  const eligibility =
    input.streamRole === "owner"
      ? resolveHeartbeatAutomationEligibility(input.conversation)
      : { isEligible: false, reason: "not_conversation_owner" };
  return {
    threadId: input.threadId,
    streamRole: input.streamRole,
    isEligible: eligibility.isEligible,
    reason: eligibility.reason,
    collaborationMode: input.conversation?.latestCollaborationMode ?? null,
    permissions: buildHeartbeatAutomationPermissions(input.permissionState),
  };
}

export function HeartbeatAutomationController() {
  const electronAvailable = typeof window !== "undefined" && Boolean(window.api);
  const manager = useDefaultCodexAppServerManager();
  const connection = useLocalConversationConnection();
  const automationsQuery = useCodexScheduledAutomations();
  const targetThreadIds = useMemo(
    () => listHeartbeatAutomationTargetThreadIds(automationsQuery.data ?? []),
    [automationsQuery.data],
  );
  const targetThreadIdsKey = targetThreadIds.join("\n");
  const conversations = useConversationSubset(targetThreadIds);
  const inFlightResumeThreadIds = useRef(new Set<string>());
  const failedResumeThreadIds = useRef(new Set<string>());
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPublishedStateByThreadId = useRef(new Map<string, string>());
  const [resumeRetryTick, setResumeRetryTick] = useState(0);

  useEffect(() => {
    if (!electronAvailable) return;
    void publishCodexHeartbeatEnabled({ enabled: true });
  }, [electronAvailable]);

  useEffect(
    () => () => {
      if (retryTimerRef.current === null) return;
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!electronAvailable || connection.status !== "connected") return;

    const scheduleRetry = () => {
      if (retryTimerRef.current !== null) return;
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        setResumeRetryTick((tick) => tick + 1);
      }, HEARTBEAT_RESUME_RETRY_MS);
    };

    for (const threadId of targetThreadIds) {
      const conversation = conversations[threadId] ?? null;
      if (!shouldResumeHeartbeatAutomationTarget(conversation)) continue;
      if (inFlightResumeThreadIds.current.has(threadId)) continue;
      if (failedResumeThreadIds.current.has(threadId)) continue;

      inFlightResumeThreadIds.current.add(threadId);
      void manager
        .requestThreadStreamResume(threadId)
        .then((resumedConversation) => {
          if (resumedConversation) failedResumeThreadIds.current.delete(threadId);
        })
        .catch((error) => {
          if (isNoRolloutFoundError(error)) {
            failedResumeThreadIds.current.add(threadId);
            return;
          }
          scheduleRetry();
        })
        .finally(() => {
          inFlightResumeThreadIds.current.delete(threadId);
        });
    }
  }, [
    connection.status,
    conversations,
    electronAvailable,
    manager,
    resumeRetryTick,
    targetThreadIds,
    targetThreadIdsKey,
  ]);

  useEffect(() => {
    if (!electronAvailable) return;

    const nextPublishedStateByThreadId = new Map<string, string>();
    for (const threadId of targetThreadIds) {
      const conversation = conversations[threadId] ?? null;
      const permissionState = manager.readPermissionState(conversation?.projectId ?? null);
      const state = buildHeartbeatAutomationThreadState({
        threadId,
        conversation,
        permissionState,
        streamRole: manager.readConversationStreamRole(threadId),
      });
      const serialized = JSON.stringify(state);
      nextPublishedStateByThreadId.set(threadId, serialized);
      if (lastPublishedStateByThreadId.current.get(threadId) === serialized) continue;

      void publishCodexHeartbeatThreadState(state);
    }
    lastPublishedStateByThreadId.current = nextPublishedStateByThreadId;
  }, [conversations, electronAvailable, manager, targetThreadIds, targetThreadIdsKey]);

  return null;
}

function resolveHeartbeatAutomationEligibility(conversation: CodexConversationSnapshot | null): {
  isEligible: boolean;
  reason: string | null;
} {
  if (!conversation) {
    return { isEligible: false, reason: "conversation_missing" };
  }
  if (conversation.resumeState !== "resumed") {
    return { isEligible: false, reason: conversation.resumeState };
  }
  if (conversation.statusActiveFlags.includes("waitingOnUserInput")) {
    return { isEligible: false, reason: "waiting_on_user_input" };
  }
  if (conversation.statusActiveFlags.includes("waitingOnApproval")) {
    return { isEligible: false, reason: "waiting_on_approval" };
  }
  if (conversation.statusActiveFlags.length > 0) {
    return { isEligible: false, reason: "active_with_flags" };
  }
  if (conversation.threadRuntimeStatus?.type === "active") {
    return { isEligible: false, reason: "active_thread" };
  }
  if (conversation.turns.some((turn) => turn.status === "inProgress")) {
    return { isEligible: false, reason: "turn_in_progress" };
  }

  return { isEligible: true, reason: null };
}

function isNoRolloutFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("no rollout found for thread id");
}
