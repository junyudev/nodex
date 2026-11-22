import { queryOptions } from "@tanstack/react-query";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";

/** Where a conversation's answer comes from: its own choice, or the Settings choice it follows. */
export interface SubagentDelegationState {
  readonly allowed: boolean;
  readonly source: "conversation" | "settings";
}

export const resolveSubagentDelegation = (
  settings: boolean,
  chosen: boolean | null,
): SubagentDelegationState =>
  chosen === null || chosen === settings
    ? { allowed: chosen ?? settings, source: "settings" }
    : { allowed: chosen, source: "conversation" };

/**
 * A conversation keeps a choice only while it differs from Settings, so turning it back to the
 * Settings answer follows Settings again rather than pinning today's value.
 */
export const conversationChoiceFor = (settings: boolean, allowed: boolean): boolean | null =>
  allowed === settings ? null : allowed;

export const subagentDelegationQueryOptions = (sessionId: string) =>
  queryOptions({
    queryKey: ["agent-runtime", "subagent-delegation", sessionId],
    queryFn: () => agentRuntimeRuntime.delegation({ sessionId }),
  });
