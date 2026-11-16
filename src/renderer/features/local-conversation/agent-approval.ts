import { defineMessage, defineMessages, getIntl, type IntlShape } from "@/lib/i18n";
import type {
  AgentApprovalDecision,
  AgentApprovalOption,
} from "../../../shared/agent-approval-options";

export {
  agentApprovalOptionKey,
  resolveAgentApprovalOptions,
  splitAgentApprovalOptions,
} from "../../../shared/agent-approval-options";
export type {
  AgentApprovalDecision,
  AgentApprovalOption,
} from "../../../shared/agent-approval-options";

/**
 * A native execution approval awaiting the person, as the conversation presents it.
 * Runtime turn items and requests project into this shape; presentation never reads
 * provider payloads.
 */
export type AgentApprovalKind =
  | "command"
  | "file-read"
  | "file-change"
  | "permission"
  | "mcp-elicitation";

export interface AgentPendingApproval {
  readonly requestId: string;
  /** Null when the provider cannot prove which Run asked. */
  readonly runId: string | null;
  readonly kind: AgentApprovalKind;
  /** The exact action awaiting approval: a command, file list, or requested access. */
  readonly detail: string;
  readonly reason: string | null;
  readonly appName: string | null;
  readonly options: readonly AgentApprovalOption[];
  readonly fullAccessOverride: "ask_rule" | "provider_check" | null;
  /** The asking provider process can still receive an answer. */
  readonly live: boolean;
  /** A decline can carry feedback back to the asking Agent. */
  readonly supportsFeedback: boolean;
  readonly createdAt: number;
  /** When an unanswered request is declined for the person, so an unattended turn carries on. */
  readonly autoDeclineAt: number | null;
}

export interface AgentApprovalResponse {
  readonly decision: AgentApprovalDecision;
  readonly optionId?: string;
  readonly feedback?: string;
}

export const AGENT_APPROVAL_KIND_MESSAGES = defineMessages({
  command: {
    id: "conversation.agentApproval.commandApproval",
    defaultMessage: "Command approval",
  },
  "file-read": {
    id: "conversation.agentApproval.fileReadApproval",
    defaultMessage: "File read approval",
  },
  "file-change": {
    id: "conversation.agentApproval.fileChangeApproval",
    defaultMessage: "File change approval",
  },
  permission: {
    id: "conversation.agentApproval.permissionApproval",
    defaultMessage: "Permission approval",
  },
  "mcp-elicitation": {
    id: "conversation.agentApproval.appAccessApproval",
    defaultMessage: "App access approval",
  },
});

export const FULL_ACCESS_OVERRIDE_QUESTION = defineMessage({
  id: "conversation.agentApproval.overrideQuestion",
  defaultMessage: "Why am I being asked?",
});

export function fullAccessOverrideExplanation(
  override: "ask_rule" | "provider_check",
  autoDeclines = false,
  intl: IntlShape = getIntl(),
): string {
  if (override === "ask_rule")
    return intl.formatMessage({
      id: "conversation.agentApproval.askRule",
      defaultMessage:
        "Full access skips approvals, but an ask rule in the Agent's own settings matches this action. Remove or narrow that rule to stop these prompts.",
    });
  return autoDeclines
    ? intl.formatMessage({
        id: "conversation.agentApproval.providerCheckAutoDeclines",
        defaultMessage:
          "Full access skips approvals, but the Agent still stops for a few safety checks of its own that no setting can skip. Check the request and approve it if it's what you expect. If no one answers, it is declined and the Agent finds another way.",
      })
    : intl.formatMessage({
        id: "conversation.agentApproval.providerCheck",
        defaultMessage:
          "Full access skips approvals, but the Agent still stops for a few safety checks of its own that no setting can skip. Check the request and approve it if it's what you expect.",
      });
}

const MINUTE_MS = 60_000;

/**
 * What a waiting approval says about its deadline, and when that wording next changes. Whole
 * minutes keep the row still: it reads as a deadline, not a countdown to race.
 */
export function agentApprovalWaitingStatus(
  autoDeclineAt: number | null,
  now: number,
  intl: IntlShape = getIntl(),
): { readonly label: string; readonly nextChangeAt: number | null } {
  if (autoDeclineAt === null)
    return {
      label: intl.formatMessage({
        id: "conversation.agentApproval.waitingForApproval",
        defaultMessage: "Waiting for approval",
      }),
      nextChangeAt: null,
    };
  const remaining = autoDeclineAt - now;
  if (remaining <= 0)
    return {
      label: intl.formatMessage({
        id: "conversation.agentApproval.noAnswer",
        defaultMessage: "No answer, declining",
      }),
      nextChangeAt: null,
    };
  const minutes = Math.ceil(remaining / MINUTE_MS);
  return {
    label:
      minutes <= 1
        ? intl.formatMessage({
            id: "conversation.agentApproval.declinesUnderMinute",
            defaultMessage: "Waiting for approval · declines in under a minute",
          })
        : intl.formatMessage(
            {
              id: "conversation.agentApproval.declinesInMinutes",
              defaultMessage: "Waiting for approval · declines in {minutes} min",
            },
            { minutes },
          ),
    nextChangeAt: autoDeclineAt - (minutes - 1) * MINUTE_MS,
  };
}

/** The composer stays usable while approvals wait: a message declines them and redirects. */
export function agentApprovalComposerPlaceholder(
  approvals: readonly AgentPendingApproval[],
  intl: IntlShape = getIntl(),
): string | null {
  const answerable = approvals.filter((approval) => approval.live);
  if (answerable.length === 0) return null;
  const only = answerable.length === 1 ? answerable[0]! : null;
  return only?.supportsFeedback && only.options.some((option) => option.decision === "decline")
    ? intl.formatMessage({
        id: "conversation.agentApproval.tellAgentInstead",
        defaultMessage: "Tell the Agent what to do instead",
      })
    : intl.formatMessage({
        id: "conversation.agentApproval.declineBySendingMessage",
        defaultMessage: "Send a message to decline and redirect the Agent",
      });
}

/**
 * Sending while approvals wait refuses each answerable one with the refusal it offers. A single
 * plain decline that accepts feedback receives the message itself; otherwise the message follows,
 * steering the waiting turn unless a refusal had to stop it.
 */
export function planAgentApprovalDeclineOnSend(
  approvals: readonly AgentPendingApproval[],
  message: string,
): {
  readonly responses: readonly { requestId: string; response: AgentApprovalResponse }[];
  readonly steerMessage: string | null;
  /** The turn keeps running after these refusals, so the message steers it. */
  readonly steer: boolean;
} {
  const text = message.trim();
  const refusals = approvals.flatMap((approval) => {
    if (!approval.live) return [];
    const offers = (decision: AgentApprovalDecision) =>
      approval.options.some((option) => option.decision === decision);
    const decision: AgentApprovalDecision | null = offers("decline")
      ? "decline"
      : offers("cancel")
        ? "cancel"
        : null;
    return decision ? [{ approval, decision }] : [];
  });
  const steer = refusals.every((refusal) => refusal.decision === "decline");
  const only = refusals.length === 1 ? refusals[0]! : null;
  if (only?.decision === "decline" && only.approval.supportsFeedback && text) {
    return {
      responses: [
        { requestId: only.approval.requestId, response: { decision: "decline", feedback: text } },
      ],
      steerMessage: null,
      steer,
    };
  }
  return {
    responses: refusals.map(({ approval, decision }) => ({
      requestId: approval.requestId,
      response: { decision },
    })),
    steerMessage: text || null,
    steer,
  };
}
