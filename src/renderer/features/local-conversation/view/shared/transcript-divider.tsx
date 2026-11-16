import { defineMessage, useIntl, type MessageDescriptor } from "@/lib/i18n";
import { Fragment, type ReactNode } from "react";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type {
  CodexRuntimeNotice,
  CodexRuntimeNoticeAgent,
} from "../../../../../shared/codex-conversation-state/codex-conversation-state";
import { agentIdentityText } from "../../agent-identity-presentation";
import { AgentIdentity, useAgentIdentity } from "./agent-identity";

/** A conversation-level event between Turns, centered on a rule across the transcript. */
export function TranscriptDivider({
  children,
  ...props
}: { readonly children: ReactNode } & { readonly [data: `data-${string}`]: string }) {
  return (
    <div
      className="text-size-chat my-2 flex items-center gap-2 text-token-text-secondary"
      {...props}
    >
      <div className="flex-1 border-t border-current/20" />
      <div className="flex min-w-0 items-center gap-1 whitespace-nowrap">{children}</div>
      <div className="flex-1 border-t border-current/20" />
    </div>
  );
}

/** The Agent's mark and model; a catalog that loads later renames it in place. */
function HandoffAgent({ agent }: { readonly agent: CodexRuntimeNoticeAgent }) {
  const intl = useIntl();
  const identity = { kind: null, ...agent, effort: null };
  const known = useAgentIdentity(identity);
  return known && agentIdentityText(known, "model") ? (
    <AgentIdentity agent={identity} className="gap-1 text-token-text-primary" />
  ) : (
    <span className="text-token-text-primary">
      {intl.formatMessage({ id: "conversation.transcriptDivider.agent", defaultMessage: "Agent" })}
    </span>
  );
}

type AgentHandoffNotice = Extract<CodexRuntimeNotice, { kind: "agentHandoff" }>;

const HANDOFF_CARRIED: Record<AgentHandoffNotice["carried"], MessageDescriptor> = {
  conversation: defineMessage({
    id: "conversation.transcriptDivider.carriedConversation",
    defaultMessage: "Carried the conversation so far.",
  }),
  missed: defineMessage({
    id: "conversation.transcriptDivider.carriedMissed",
    defaultMessage: "Carried only the turns this Agent missed.",
  }),
  fork: defineMessage({
    id: "conversation.transcriptDivider.carriedFork",
    defaultMessage: "Carried the fork's work since it branched from this chat.",
  }),
  checkpoint: defineMessage({
    id: "conversation.transcriptDivider.carriedCheckpoint",
    defaultMessage: "Carried a summary of the conversation so far.",
  }),
  imported: defineMessage({
    id: "conversation.transcriptDivider.carriedImported",
    defaultMessage: "Carried the imported conversation history.",
  }),
};

/**
 * Where the chat continued on another Agent. What was carried explains itself on hover and to
 * screen readers; the carried history stays with the Agent Runtime and the transcript shows it.
 */
export function AgentHandoffDivider({ notice }: { readonly notice: AgentHandoffNotice }) {
  const intl = useIntl();
  const { to } = notice;
  const from = notice.from.filter(
    (agent) => agent.providerInstanceId !== to.providerInstanceId || agent.model !== to.model,
  );
  const label =
    notice.carried === "fork"
      ? intl.formatMessage({
          id: "conversation.transcriptDivider.forkMerged",
          defaultMessage: "Fork merged back",
        })
      : intl.formatMessage({
          id: "conversation.transcriptDivider.handoff",
          defaultMessage: "Context handoff",
        });
  const detail = notice.failed
    ? intl.formatMessage({
        id: "conversation.transcriptDivider.handoffError",
        defaultMessage: "The handoff failed; the Agent may not have the earlier conversation.",
      })
    : intl.formatMessage(
        {
          id: "conversation.transcriptDivider.carriedDetail",
          defaultMessage: "{carried} Longer history stays readable to the Agent.",
        },
        { carried: intl.formatMessage(HANDOFF_CARRIED[notice.carried]) },
      );
  return (
    <TranscriptDivider data-runtime-notice="agentHandoff">
      <NodexTooltip tooltipContent={detail}>
        <span
          tabIndex={0}
          className={cn(
            "inline-flex min-w-0 items-center gap-1 rounded-sm focus-visible:outline-2",
            notice.failed && "text-token-charts-red",
          )}
        >
          <span>
            {notice.failed
              ? intl.formatMessage(
                  {
                    id: "conversation.transcriptDivider.failedLabel",
                    defaultMessage: "{label} failed",
                  },
                  { label },
                )
              : label}
          </span>
          <span aria-hidden="true">·</span>
          {from.map((agent, index) => (
            <Fragment key={`${agent.providerInstanceId}\0${agent.model ?? ""}`}>
              {index > 0 ? <span aria-hidden="true">,</span> : null}
              <HandoffAgent agent={agent} />
            </Fragment>
          ))}
          {from.length > 0 ? (
            <>
              <span aria-hidden="true">→</span>
              <span className="sr-only">
                {intl.formatMessage({
                  id: "conversation.transcriptDivider.to",
                  defaultMessage: "to",
                })}
              </span>
            </>
          ) : null}
          <HandoffAgent agent={to} />
          <span className="sr-only">{detail}</span>
        </span>
      </NodexTooltip>
    </TranscriptDivider>
  );
}

/**
 * Where the chat's context was cleared. Later messages start every Agent fresh; the earlier
 * conversation stays readable here but no Agent receives it.
 */
export function ContextClearedDivider() {
  const intl = useIntl();
  const detail = intl.formatMessage({
    id: "conversation.transcriptDivider.clearedHint",
    defaultMessage:
      "Messages after this start with a fresh context. Agents no longer receive the conversation above.",
  });
  return (
    <TranscriptDivider data-runtime-notice="contextCleared">
      <NodexTooltip tooltipContent={detail}>
        <span tabIndex={0} className="rounded-sm focus-visible:outline-2">
          {intl.formatMessage({
            id: "conversation.transcriptDivider.contextCleared",
            defaultMessage: "Context cleared",
          })}
          <span className="sr-only">{detail}</span>
        </span>
      </NodexTooltip>
    </TranscriptDivider>
  );
}
