import { useQuery } from "@tanstack/react-query";
import type { InboxChatAgent, InboxItem } from "../../../shared/inbox";
import type { CodexScheduledAutomation } from "../../../shared/types";
import { agentRuntimeProviderId } from "../../../shared/agent-runtime-provider";
import { codexScheduledAutomationsListQueryOptions } from "@/lib/query-options";

/** A saved `default` means the Agent's own choice, which an Inbox Agent choice spells as null. */
const chosen = (value: string | null): string | null =>
  value === null || value === "default" ? null : value;

/** What a scheduled task runs on, in the Inbox's terms; null when its Agent cannot be named. */
export function scheduledTaskChatAgent(
  task: Pick<
    CodexScheduledAutomation,
    "backendBinding" | "model" | "reasoningEffort" | "serviceTier"
  >,
): InboxChatAgent | null {
  const instanceId = agentRuntimeProviderId(task.backendBinding);
  if (!instanceId) return null;
  return {
    instanceId,
    model: chosen(task.model),
    reasoningEffort: chosen(task.reasoningEffort),
    serviceTier: chosen(task.serviceTier),
  };
}

/** The scheduled task behind a firing message, from the Scheduled list the Inbox keeps fresh. */
export function useInboxFiringTask(item: InboxItem): CodexScheduledAutomation | null {
  const automationId = item.firing?.automationId ?? null;
  const tasks = useQuery({
    ...codexScheduledAutomationsListQueryOptions(),
    enabled: automationId !== null,
  });
  if (automationId === null) return null;
  return tasks.data?.find((task) => task.id === automationId && task.status !== "DELETED") ?? null;
}
