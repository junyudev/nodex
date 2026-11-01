import { useQuery } from "@tanstack/react-query";
import { AgentProviderIcon } from "@/components/shared/icons/provider-icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { conversationIdentityQueryOptions } from "@/lib/conversation-identity";
import type { ConversationIdentity } from "../../../../../shared/conversation-identity";
import type { ThreadStageActions } from "../../thread-stage-types";
import { AgentIdentity, useAgentIdentity } from "./agent-identity";

/** Opens a named conversation where it lives: a chat in its Session, a subagent beside its parent. */
function openConversation(
  identity: ConversationIdentity,
  onOpenThread: ThreadStageActions["onOpenThread"],
) {
  return onOpenThread(
    identity.threadId,
    identity.host
      ? { hostId: identity.host.id }
      : identity.sessionId
        ? { runtimeSessionId: identity.sessionId }
        : undefined,
  );
}

function ConversationReferenceDetails({ identity }: { readonly identity: ConversationIdentity }) {
  const note = identity.archived
    ? "Archived"
    : identity.host
      ? `On ${identity.host.name}`
      : identity.role === "subagent"
        ? "Subagent"
        : null;
  return (
    <span className="flex flex-col gap-0.5">
      <AgentIdentity agent={identity.agent} detail="agent" />
      {note ? <span className="opacity-70">{note}</span> : null}
    </span>
  );
}

/**
 * Another conversation, named inline by its Agent's mark and its title. An archived one stays
 * named but no longer opens.
 */
function ConversationReference({
  identity,
  onOpenThread,
}: {
  readonly identity: ConversationIdentity;
  readonly onOpenThread?: ThreadStageActions["onOpenThread"];
}) {
  const agent = useAgentIdentity(identity.agent);
  const reference = (
    <>
      {agent?.kind ? <AgentProviderIcon kind={agent.kind} className="size-3 shrink-0" /> : null}
      <span className="min-w-0 truncate">{identity.title}</span>
    </>
  );
  const className = "inline-flex max-w-64 min-w-0 items-center gap-1 rounded-sm align-bottom";
  const open = onOpenThread && !identity.archived ? onOpenThread : undefined;
  return (
    <NodexTooltip tooltipContent={<ConversationReferenceDetails identity={identity} />}>
      {open ? (
        <button
          type="button"
          aria-label={`Open ${identity.title}`}
          className={cn(
            className,
            "cursor-interaction hover:text-token-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2",
          )}
          data-conversation-reference={identity.role}
          onClick={() => void openConversation(identity, open)}
        >
          {reference}
        </button>
      ) : (
        <span
          tabIndex={0}
          className={cn(className, "focus-visible:outline-2 focus-visible:outline-offset-2")}
          data-conversation-reference={identity.archived ? "archived" : identity.role}
        >
          {reference}
        </span>
      )}
    </NodexTooltip>
  );
}

/**
 * Names another conversation as the source of a message, an answer or a fork: "Sent by", then
 * the conversation's Agent mark and title, resolved live. It stays out of sight until the name
 * resolves, so a known sender never flashes as anonymous; an unknown or deleted conversation
 * reads as the fallback.
 */
export function ConversationAttribution({
  label,
  fallback = "another agent",
  threadId,
  onOpenThread,
}: {
  readonly label: string;
  readonly fallback?: string;
  readonly threadId: string | null;
  readonly onOpenThread?: ThreadStageActions["onOpenThread"];
}) {
  const { data: identity, isPending } = useQuery({
    ...conversationIdentityQueryOptions(threadId ?? ""),
    enabled: threadId !== null,
  });
  const resolving = threadId !== null && isPending;
  return (
    <span
      className={cn("inline-flex min-w-0 items-center gap-1", resolving && "invisible")}
      data-conversation-attribution={label}
    >
      <span className="shrink-0">{label}</span>
      {identity ? (
        <ConversationReference identity={identity} onOpenThread={onOpenThread} />
      ) : (
        <span data-conversation-reference="unknown">{fallback}</span>
      )}
    </span>
  );
}
