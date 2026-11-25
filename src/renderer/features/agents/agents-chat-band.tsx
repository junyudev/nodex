import { useIntl } from "@/lib/i18n";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ChatWaitingIcon } from "@/components/shared/chat-waiting-icon";
import { NodexLogoMarkIcon } from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { conversationIdentityQueryOptions } from "@/lib/conversation-identity";
import { cn } from "@/lib/utils";
import type { AgentsMapChat } from "../../../shared/agents-map";
import type { Project } from "../../../shared/types";
import { InboxProjectLabel } from "../inbox/inbox-project-label";
import { agentIdentityText } from "../local-conversation/agent-identity-presentation";
import { projectAgentRuntimeSubagentOverview } from "../local-conversation/agent-runtime-subagent-overview";
import type { ThreadStageActions } from "../local-conversation/thread-stage-types";
import { useAgentRuntimeSubagentStop } from "../local-conversation/use-agent-runtime-subagent-stop";
import { useAgentIdentity } from "../local-conversation/view/shared/agent-identity";
import {
  DelegationMap,
  HarnessMark,
  delegationSummaryText,
} from "../local-conversation/view/subagents-panel/delegation-map";
import { agentsChatDelegation, agentsChatStatus, type AgentsChatTone } from "./agents-chat-status";

/** A stacked lead carries one line more than a conversation's own, so it takes more width. */
const LEAD_WIDTH_REM = 16;

const TONE: Record<AgentsChatTone, string> = {
  plain: "text-token-text-tertiary",
  attention: "text-token-foreground",
  failed: "text-danger",
};

/**
 * One chat and its work tree: the chat's lead on the left, every subagent it delegated to on the
 * right, drawn as the chat's own Subagents map draws them.
 */
export function AgentsChatBand({
  chat,
  project,
  nowMs,
  still,
  onOpenChat,
  onOpenThread,
}: {
  readonly chat: AgentsMapChat;
  /** The chat's Project, named above it while chats from every Project share the view. */
  readonly project: Pick<Project, "id" | "name" | "appearance"> | null;
  readonly nowMs: number;
  readonly still: boolean;
  readonly onOpenChat: (chat: {
    readonly sessionId: string;
    readonly rootThreadId: string;
  }) => void;
  readonly onOpenThread: ThreadStageActions["onOpenThread"];
}) {
  const intl = useIntl();
  const [stopError, setStopError] = useState<string | null>(null);
  const stop = useAgentRuntimeSubagentStop(chat.sessionId, chat.subagents, (cause) =>
    setStopError(cause instanceof Error ? cause.message : String(cause)),
  );
  const overview = chat.subagents
    ? projectAgentRuntimeSubagentOverview(chat.rootThreadId, chat.subagents, stop.canStopRun)
    : null;
  const rows = overview ? [...overview.active.rows, ...overview.done.rows] : [];
  const hidden = chat.subagentCount.total - rows.length;
  const open = () => onOpenChat({ sessionId: chat.sessionId, rootThreadId: chat.rootThreadId });
  return (
    <section className="flex flex-col gap-1.5" data-agents-chat={chat.sessionId}>
      <AgentsChatCaption chat={chat} project={project} />
      <DelegationMap
        rootThreadId={chat.rootThreadId}
        rows={rows}
        lead={<AgentsChatLead chat={chat} nowMs={nowMs} onOpen={open} />}
        leadPlacement="top"
        leadWidthRem={LEAD_WIDTH_REM}
        more={
          hidden > 0
            ? {
                // The chat's own Subagents tab holds the rest; the overview draws the first page.
                label: intl.formatMessage(
                  {
                    id: "agents.agentsChatBand.moreInChat",
                    defaultMessage:
                      "{count, plural, one {# more subagent in this chat} other {# more subagents in this chat}}",
                  },
                  { count: hidden },
                ),
                onClick: open,
              }
            : null
        }
        nowMs={nowMs}
        still={still}
        onSelect={(row) => {
          if (row.identityThreadId)
            void onOpenThread(row.identityThreadId, { runtimeSessionId: chat.sessionId });
        }}
        onStop={stop.stop}
        isStopping={stop.isStopping}
      />
      {stopError ? (
        <p role="alert" className="px-1 text-xs text-token-text-secondary">
          {stopError}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The quiet line above a chat: its Project while chats from every Project share the view, the
 * work Page it is the active chat of, and whether Nodex watches it.
 */
function AgentsChatCaption({
  chat,
  project,
}: {
  readonly chat: AgentsMapChat;
  readonly project: Pick<Project, "id" | "name" | "appearance"> | null;
}) {
  const intl = useIntl();
  if (!project && !chat.page?.key && !chat.managed) return null;
  return (
    <div className="flex h-4 min-w-0 items-center gap-1.5 px-1 text-xs text-token-description-foreground">
      {project ? <InboxProjectLabel project={project} /> : null}
      {chat.page?.key ? (
        <span className="shrink-0 tabular-nums" data-agents-chat-page={chat.page.id}>
          {chat.page.key}
        </span>
      ) : null}
      {chat.managed ? (
        <NodexTooltip
          tooltipContent={intl.formatMessage({
            id: "agents.agentsChatBand.managedByNodex",
            defaultMessage: "Managed by Nodex",
          })}
          side="top"
        >
          <span className="flex shrink-0" tabIndex={0}>
            <NodexLogoMarkIcon monochrome className="icon-xs" />
          </span>
        </NodexTooltip>
      ) : null}
    </div>
  );
}

/**
 * A chat's lead card: its Agent and how its work stands, its title, one line about what it is
 * doing or asking, then its model and how many subagents have reported back.
 */
function AgentsChatLead({
  chat,
  nowMs,
  onOpen,
}: {
  readonly chat: AgentsMapChat;
  readonly nowMs: number;
  readonly onOpen: () => void;
}) {
  const intl = useIntl();
  const conversation = useQuery(conversationIdentityQueryOptions(chat.rootThreadId)).data ?? null;
  const agentBinding = chat.agent ?? conversation?.agent;
  const agent = useAgentIdentity(agentBinding);
  const settings = agent ? agentIdentityText(agent, "settings") : null;
  const status = agentsChatStatus(chat, nowMs, intl);
  const delegation = agentsChatDelegation(chat);
  const title = conversation?.title ?? null;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={intl.formatMessage(
        { id: "agents.agentsChatBand.openChat", defaultMessage: "Open {title}" },
        {
          title:
            title ??
            intl.formatMessage({ id: "agents.agentsChatBand.chat", defaultMessage: "chat" }),
        },
      )}
      data-agents-chat-lead={chat.sessionId}
      data-agents-chat-state={chat.state}
      className={cn(
        "flex size-full min-w-0 cursor-interaction flex-col justify-center gap-1 rounded-xl px-3 py-3 text-left ring-[0.5px] ring-token-border",
        "bg-token-main-surface-primary hover:bg-token-foreground/5 focus-visible:outline-2 focus-visible:outline-offset-2",
        // A chat waiting for the Runtime has not started; it rests flat until it does.
        chat.state === "queued" ? "" : "shadow-[0_8px_24px_-12px_rgb(0_0_0/0.28)]",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-xs/4 text-token-text-tertiary">
        <HarnessMark agent={agentBinding} identity={agent} />
        <span className="truncate">{agent?.agentName}</span>
        <span
          className={cn(
            "ml-auto flex shrink-0 items-center gap-1 pl-2 tabular-nums",
            TONE[status.tone],
          )}
        >
          {status.tone === "attention" ? <ChatWaitingIcon className="icon-2xs" /> : null}
          {status.text}
        </span>
      </span>
      <span className="truncate text-sm/5 font-medium text-token-foreground">{title}</span>
      {chat.line ? (
        <span
          className={cn(
            "truncate text-xs/4",
            chat.state === "waiting" ? "text-token-foreground" : "text-token-text-tertiary",
          )}
        >
          {chat.line}
        </span>
      ) : null}
      <span className="flex min-w-0 items-center gap-1.5 text-xs/4 text-token-text-secondary">
        <span className="truncate">{settings}</span>
        {delegation.total > 0 ? (
          <span className="ml-auto shrink-0 pl-2 text-token-text-tertiary tabular-nums">
            {delegationSummaryText(delegation, intl, "short")}
          </span>
        ) : null}
      </span>
    </button>
  );
}
