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

export type AgentApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface AgentApprovalOption {
  readonly decision: AgentApprovalDecision;
  readonly label: string;
  readonly warning?: string;
  /** The provider's own choice, when one decision has several native scopes. */
  readonly optionId?: string;
}

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
}

export interface AgentApprovalResponse {
  readonly decision: AgentApprovalDecision;
  readonly optionId?: string;
  readonly feedback?: string;
}

/** A choice's identity: the provider's option when it names one, otherwise its decision. */
export function agentApprovalOptionKey(option: Pick<AgentApprovalOption, "decision" | "optionId">) {
  return option.optionId ?? option.decision;
}

const DEFAULT_OPTION_LABELS: Record<AgentApprovalDecision, string> = {
  accept: "Approve",
  acceptForSession: "Allow for this chat",
  decline: "Decline",
  cancel: "Decline and stop",
};

const DEFAULT_OPTIONS: readonly AgentApprovalOption[] = [
  { decision: "accept", label: DEFAULT_OPTION_LABELS.accept },
  { decision: "decline", label: DEFAULT_OPTION_LABELS.decline },
  { decision: "acceptForSession", label: DEFAULT_OPTION_LABELS.acceptForSession },
  { decision: "cancel", label: DEFAULT_OPTION_LABELS.cancel },
];

/**
 * The provider decides which decisions it can honor. Approve, Decline and Decline and stop read
 * the same for every Agent; a session allowance keeps the provider's label because it states the
 * scope being allowed. An empty or missing list falls back to every decision.
 */
export function resolveAgentApprovalOptions(
  advertised: readonly AgentApprovalOption[] | null | undefined,
): readonly AgentApprovalOption[] {
  if (!advertised?.length) return DEFAULT_OPTIONS;
  const seen = new Set<string>();
  return advertised.flatMap((option) => {
    const key = agentApprovalOptionKey(option);
    if (seen.has(key)) return [];
    seen.add(key);
    const label =
      option.decision === "acceptForSession" && option.label.trim()
        ? option.label.trim()
        : DEFAULT_OPTION_LABELS[option.decision];
    return [
      {
        decision: option.decision,
        label,
        ...(option.warning ? { warning: option.warning } : {}),
        ...(option.optionId ? { optionId: option.optionId } : {}),
      },
    ];
  });
}

/**
 * One refusal and Approve sit inline, Approve last; broader or terminal choices live behind
 * More. Without a plain Decline, Decline and stop is the inline refusal so No is always visible.
 */
export function splitAgentApprovalOptions(options: readonly AgentApprovalOption[]): {
  readonly primary: readonly AgentApprovalOption[];
  readonly more: readonly AgentApprovalOption[];
} {
  const refusal =
    options.find((option) => option.decision === "decline") ??
    options.find((option) => option.decision === "cancel");
  const accept = options.find((option) => option.decision === "accept");
  const primary = [refusal, accept].filter((option) => option !== undefined);
  return { primary, more: options.filter((option) => !primary.includes(option)) };
}

export const AGENT_APPROVAL_KIND_LABEL: Record<AgentApprovalKind, string> = {
  command: "Command approval",
  "file-read": "File read approval",
  "file-change": "File change approval",
  permission: "Permission approval",
  "mcp-elicitation": "App access approval",
};

export const FULL_ACCESS_OVERRIDE_QUESTION = "Why am I being asked?";

export function fullAccessOverrideExplanation(override: "ask_rule" | "provider_check"): string {
  return override === "ask_rule"
    ? "Full access skips approvals, but an ask rule in the Agent's own settings matches this action. Remove or narrow that rule to stop these prompts."
    : "Full access skips approvals, but the Agent still stops for a few safety checks of its own that no setting can skip. Check the request and approve it if it's what you expect.";
}

/** The composer stays usable while approvals wait: a message declines them and redirects. */
export function agentApprovalComposerPlaceholder(
  approvals: readonly AgentPendingApproval[],
): string | null {
  const answerable = approvals.filter((approval) => approval.live);
  if (answerable.length === 0) return null;
  const only = answerable.length === 1 ? answerable[0]! : null;
  return only?.supportsFeedback && only.options.some((option) => option.decision === "decline")
    ? "Tell the Agent what to do instead"
    : "Send a message to decline and redirect the Agent";
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
