import { projectAutomationPromptPreview } from "../../shared/automation-heartbeat";
import { queryOptions } from "@tanstack/react-query";
import { isAgentExecutionThreadId } from "../../shared/agent-runtime-api";
import type { ConversationIdentity } from "../../shared/conversation-identity";
import type { CodexExecutionHostSettings, CodexThreadSummary } from "../../shared/types";
import { DEFAULT_CODEX_HOST_ID } from "../../shared/codex-host";
import { agentRuntimeRuntime } from "./agent-runtime-runtime";
import { readCodexThreadSummary } from "./codex-thread-summary";
import { managedWorktreeSettingsService } from "./managed-worktree-runtime";
import { queryKeys } from "./query-keys";

/**
 * A native Codex conversation, named as the sidebar names it. A conversation on an SSH
 * execution host carries that host's name.
 */
export function nativeConversationIdentity(
  summary: CodexThreadSummary,
  hosts: CodexExecutionHostSettings | null,
): ConversationIdentity {
  const hostId = summary.executionHostId ?? DEFAULT_CODEX_HOST_ID;
  const host =
    hostId === DEFAULT_CODEX_HOST_ID
      ? null
      : {
          id: hostId,
          name: hosts?.sshHosts.find((candidate) => candidate.id === hostId)?.displayName ?? hostId,
        };
  const subagent = Boolean(summary.agentPath || summary.agentNickname);
  const title =
    summary.threadName?.trim() ||
    (subagent ? summary.agentNickname?.trim() : null) ||
    projectAutomationPromptPreview(summary.threadPreview).trim() ||
    "Untitled chat";
  return {
    threadId: summary.threadId,
    sessionId: summary.sessionId ?? null,
    title,
    role: subagent ? "subagent" : "chat",
    agent: {
      kind: "codex",
      providerInstanceId: null,
      model: summary.executionProfile?.modelId ?? null,
      effort: summary.executionProfile?.reasoningEffort ?? null,
    },
    archived: summary.archived,
    host,
  };
}

async function readConversationIdentity(threadId: string): Promise<ConversationIdentity | null> {
  if (isAgentExecutionThreadId(threadId)) return agentRuntimeRuntime.identify(threadId);
  const summary = await readCodexThreadSummary(threadId);
  if (!summary) return null;
  const remote = (summary.executionHostId ?? DEFAULT_CODEX_HOST_ID) !== DEFAULT_CODEX_HOST_ID;
  const hosts = remote
    ? await managedWorktreeSettingsService.getExecutionHosts().catch(() => null)
    : null;
  return nativeConversationIdentity(summary, hosts);
}

/**
 * Names another conversation where work is attributed to it. Unknown and deleted conversations
 * resolve to null; Session changes refresh what is shown.
 */
export function conversationIdentityQueryOptions(threadId: string) {
  return queryOptions({
    queryKey: queryKeys.conversationIdentity.thread(threadId),
    queryFn: () => readConversationIdentity(threadId),
    staleTime: 60_000,
    retry: false,
  });
}
