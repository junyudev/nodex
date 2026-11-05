/** What a person can answer to a native execution approval, on any surface that asks. */
export type AgentApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface AgentApprovalOption {
  readonly decision: AgentApprovalDecision;
  readonly label: string;
  readonly warning?: string;
  /** The provider's own choice, when one decision has several native scopes. */
  readonly optionId?: string;
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
