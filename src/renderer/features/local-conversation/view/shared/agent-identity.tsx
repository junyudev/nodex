import { useSyncExternalStore } from "react";
import { AgentProviderIcon } from "@/components/shared/icons/provider-icons";
import { cn } from "@/lib/utils";
import type { ConversationAgent } from "../../../../../shared/conversation-identity";
import { agentRuntimeDelegatedTasks } from "../../agent-runtime-delegated-tasks";
import {
  agentIdentitySpokenText,
  agentIdentityText,
  presentAgentIdentity,
  type AgentIdentityDetail,
  type AgentIdentityPresentation,
} from "../../agent-identity-presentation";

/** Configured Agent names load with their catalogs; a later load renames the Agent in place. */
export function useAgentIdentity(
  agent: ConversationAgent | null | undefined,
): AgentIdentityPresentation | null {
  const labels = useSyncExternalStore(
    agentRuntimeDelegatedTasks.subscribe,
    agentRuntimeDelegatedTasks.readLabels,
  );
  return agent ? presentAgentIdentity(agent, labels) : null;
}

/**
 * The Agent behind a conversation's work: its harness mark, then its model. Cards spell the
 * Agent's name too, a conversation's own settings add its effort, and assistive text always
 * names the Agent.
 */
export function AgentIdentity({
  agent,
  detail = "model",
  className,
  markClassName = "size-3",
}: {
  readonly agent: ConversationAgent | null | undefined;
  readonly detail?: AgentIdentityDetail;
  readonly className?: string;
  readonly markClassName?: string;
}) {
  const identity = useAgentIdentity(agent);
  if (!identity) return null;
  const text = agentIdentityText(identity, detail);
  if (!text) return null;
  const spoken = agentIdentitySpokenText(identity, detail);
  return (
    <span
      className={cn("inline-flex min-w-0 items-center gap-1.5", className)}
      data-agent-identity={identity.kind ?? "unknown"}
    >
      {identity.kind ? (
        <AgentProviderIcon kind={identity.kind} className={cn("shrink-0", markClassName)} />
      ) : null}
      <span className="truncate" aria-hidden={spoken !== text ? true : undefined}>
        {text}
      </span>
      {spoken !== text ? <span className="sr-only">{spoken}</span> : null}
    </span>
  );
}
