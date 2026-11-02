interface AssistantResponseCandidate {
  readonly id: string;
  readonly type: string;
  readonly delivery?: string | null;
  readonly startedAtMs?: number | null;
}

/** The action row belongs to the last ordinary assistant message, including phase promotion. */
function selectedAssistantResponse(
  items: readonly AssistantResponseCandidate[],
): AssistantResponseCandidate | undefined {
  return items.findLast((item) => item.type === "agentMessage" && item.delivery !== "async");
}

/** Recorded item starts take precedence; a Turn fallback belongs only to the same response. */
export function resolveAssistantResponseStartedAtMs(
  turn: {
    readonly items: readonly AssistantResponseCandidate[];
    readonly assistantMessageStartedAtMsById?: Readonly<Record<string, number>> | undefined;
  },
  ...previousTurns: readonly {
    readonly items: readonly AssistantResponseCandidate[];
    readonly finalAssistantStartedAtMs: number | null;
  }[]
): number | null {
  const response = selectedAssistantResponse(turn.items);
  if (!response) return null;
  const recorded = response.startedAtMs ?? turn.assistantMessageStartedAtMsById?.[response.id];
  if (recorded != null && Number.isFinite(recorded)) return recorded;
  for (const previous of previousTurns) {
    if (response.id !== selectedAssistantResponse(previous.items)?.id) continue;
    const anchor = previous.finalAssistantStartedAtMs;
    if (anchor != null && Number.isFinite(anchor)) return anchor;
  }
  return null;
}

/** Both endpoints come from item records on the execution host, never the observer's clock. */
export function resolveAssistantResponseWorkDurationMs(
  items: readonly AssistantResponseCandidate[],
): number | null {
  // Approval-review times are observed by Nodex, rather than recorded on the execution host.
  const firstWork = items.find(
    (item) =>
      item.type !== "userMessage" &&
      item.type !== "hookPrompt" &&
      item.type !== "automaticApprovalReview",
  );
  const startedAtMs = firstWork?.startedAtMs;
  const completedAtMs = resolveAssistantResponseStartedAtMs({ items });
  if (startedAtMs == null || !Number.isFinite(startedAtMs) || completedAtMs === null) return null;
  return Math.max(0, completedAtMs - startedAtMs);
}
