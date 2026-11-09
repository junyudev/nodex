import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { PageAssignee } from "../../shared/work-graph";
import { formatAgentModelName } from "./codex-thread-settings";
type Provider = AgentRuntimeOperations["providers.read"]["output"][number];
/** An Agent Assignee's name is its model; effort is a run setting the picker shows and edits. */
export function agentAssigneeLabel(
  assignee: Extract<PageAssignee, { kind: "agent" }>,
  provider: Provider | undefined,
): string {
  const model = provider?.models.find((model) => model.slug === assignee.model);
  return formatAgentModelName(model?.name ?? "Model unavailable");
}
