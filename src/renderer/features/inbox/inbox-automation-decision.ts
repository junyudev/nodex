import { useQuery } from "@tanstack/react-query";
import type { InboxAgentChoice, InboxItem } from "../../../shared/inbox";
import type { Automation } from "../../../shared/types";
import { agentRuntimeProviderId } from "../../../shared/agent-runtime-provider";
import { automationsListQueryOptions } from "@/lib/query-options";

/** A saved `default` means the Agent's own choice, which an Inbox Agent choice spells as null. */
const chosen = (value: string | null): string | null =>
  value === null || value === "default" ? null : value;

/** What an automation runs on, in the Inbox's terms; null when its Agent cannot be named. */
export function automationChatAgent(
  task: Pick<Automation, "backendBinding" | "model" | "reasoningEffort" | "serviceTier">,
): InboxAgentChoice | null {
  const instanceId = agentRuntimeProviderId(task.backendBinding);
  if (!instanceId) return null;
  return {
    instanceId,
    model: chosen(task.model),
    reasoningEffort: chosen(task.reasoningEffort),
    serviceTier: chosen(task.serviceTier),
  };
}

/** The automation behind an automationDecision message, from the Automations list the Inbox keeps fresh. */
export function useInboxAutomationDecisionTask(item: InboxItem): Automation | null {
  const automationId = item.automationDecision?.automationId ?? null;
  const tasks = useQuery({
    ...automationsListQueryOptions(),
    enabled: automationId !== null,
  });
  if (automationId === null) return null;
  return tasks.data?.find((task) => task.id === automationId && task.status !== "DELETED") ?? null;
}
