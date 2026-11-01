import type { AgentSubagentOverviewItem, AgentTurnItem } from "@nodex/agent-runtime/contracts";
import { readAgentRuntimeEffort } from "./agent-runtime-provider";
import { projectCodexSubagentPathDisplayName } from "./codex-subagent-display";
import { agentBackendKindOfDriver, type ConversationAgent } from "./conversation-identity";

type SubagentDisplaySource = Pick<
  Extract<AgentTurnItem, { type: "subagent" }>,
  "driver" | "origin" | "title"
>;

/**
 * Codex reports native activity paths as task titles. Keep that path as detail while
 * presenting the same readable name across the transcript, overview and child tabs.
 * Application-authored titles and other providers' names are never interpreted as paths.
 */
export function projectAgentRuntimeSubagentDisplay(source: SubagentDisplaySource): {
  readonly displayName: string | null;
  readonly agentPath: string | null;
} {
  const title = source.title?.trim() || null;
  if (
    source.origin !== "provider_native" ||
    source.driver !== "codex" ||
    title === null ||
    !/^\/root\/[^/\s]+(?:\/[^/\s]+)*$/u.test(title)
  )
    return { displayName: title, agentPath: null };

  return {
    displayName: projectCodexSubagentPathDisplayName(title),
    agentPath: title,
  };
}

/** The Agent a task record says runs it, with the model and effort it was given. */
export function agentRuntimeSubagentAgent(
  task: Pick<
    AgentSubagentOverviewItem,
    "driver" | "providerInstanceId" | "model" | "modelSelection"
  >,
): ConversationAgent {
  return {
    kind: agentBackendKindOfDriver(task.driver),
    providerInstanceId: task.modelSelection?.instanceId ?? task.providerInstanceId,
    model: task.modelSelection?.model ?? task.model,
    effort: readAgentRuntimeEffort(task.modelSelection?.options),
  };
}
