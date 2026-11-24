import { projectAutomationPromptPreview } from "../../shared/automation-heartbeat";
import { DEFAULT_CODEX_HOST_ID } from "../../shared/codex-host";
import type { ConversationIdentity } from "../../shared/conversation-identity";
import type { CodexExecutionHostSettings, CodexThreadSummary } from "../../shared/types";

/** Presentation never decides ownership: even a local native chat retains its native host. */
export function nativeConversationIdentity(
  summary: CodexThreadSummary,
  hosts: CodexExecutionHostSettings | null,
): ConversationIdentity {
  const hostId = summary.executionHostId ?? DEFAULT_CODEX_HOST_ID;
  const subagent = Boolean(summary.agentPath || summary.agentNickname);
  return {
    execution: "native-codex",
    executionHostId: hostId,
    threadId: summary.threadId,
    sessionId: summary.sessionId ?? null,
    title:
      summary.threadName?.trim() ||
      (subagent ? summary.agentNickname?.trim() : null) ||
      projectAutomationPromptPreview(summary.threadPreview).trim() ||
      "Untitled chat",
    role: subagent ? "subagent" : "chat",
    agent: {
      kind: "codex",
      providerInstanceId: null,
      model: summary.executionProfile?.modelId ?? null,
      effort: summary.executionProfile?.reasoningEffort ?? null,
    },
    archived: summary.archived,
    host:
      hostId === DEFAULT_CODEX_HOST_ID
        ? null
        : {
            id: hostId,
            name:
              hosts?.sshHosts.find((candidate) => candidate.id === hostId)?.displayName ?? hostId,
          },
  };
}
