import type { components } from "@nodex/core-protocol";

export const MANAGED_CHAT_STALL_MS = 20 * 60 * 1000;
export type ManagedChatObservation = components["schemas"]["SessionExecutionObservation"];
export type ManagedChatScope = components["schemas"]["SessionExecutionScope"];

export const replyExcerpt = (text: string | null | undefined) =>
  Array.from(text?.trim() ?? "")
    .slice(0, 400)
    .join("")
    .trimEnd();

export interface ManagedChatRequest {
  readonly id: string;
  readonly kind: "question" | "approval";
  readonly question?: string;
  readonly questions?: readonly {
    readonly question: string;
    readonly options?: readonly { readonly label: string; readonly description?: string | null }[];
  }[];
}
export interface ManagedChatFacts {
  readonly scoped?: readonly {
    readonly scope: ManagedChatScope;
    readonly facts: ManagedChatFacts;
  }[];
  readonly agent?: NonNullable<ManagedChatObservation["agent"]>;
  readonly waitingAdmissions?: readonly {
    readonly runId: string;
    readonly position: number;
    readonly waitingSince: string;
  }[];
  readonly state: ManagedChatObservation["state"];
  readonly runId: string | null;
  readonly runStartedAt: number | null;
  readonly earlierRunStart?: NonNullable<ManagedChatObservation["earlierRunStart"]>;
  readonly terminalStatus: ManagedChatObservation["terminalStatus"];
  readonly pendingRequests: readonly ManagedChatRequest[];
  /**
   * Null while progress cannot be observed, such as while the chat only waits on commands. That
   * time never counts toward a stall; the stall clock restarts once progress is observable again.
   */
  readonly progressFingerprint: string | null;
  readonly lastReplyExcerpt?: string;
  readonly interruptRequested?: boolean;
  readonly failureReason?: string | null;
}
export const unavailableManagedChatFacts: ManagedChatFacts = {
  state: "unavailable",
  runId: null,
  runStartedAt: null,
  terminalStatus: null,
  pendingRequests: [],
  progressFingerprint: null,
};
/** Preserve the last confirmed outcome while its chat cannot be reached. */
export function observeManagedChat(input: {
  readonly previous: ManagedChatObservation | null;
  readonly facts: ManagedChatFacts;
  readonly now: number;
  readonly restartStallClock?: boolean;
}): ManagedChatObservation {
  const { previous, facts, now } = input;
  const available = facts.state !== "unavailable";
  const pendingRequestIds = available
    ? [...new Set(facts.pendingRequests.map((r) => r.id))].sort()
    : [];
  const continuous =
    !input.restartStallClock &&
    !facts.interruptRequested &&
    previous?.state === "working" &&
    facts.state === "working" &&
    previous.runId === facts.runId &&
    previous.progressFingerprint === facts.progressFingerprint &&
    previous.pendingRequestIds.length === 0 &&
    pendingRequestIds.length === 0;
  const sameProgress =
    previous &&
    !input.restartStallClock &&
    previous.state === facts.state &&
    previous.runId === facts.runId &&
    previous.progressFingerprint === facts.progressFingerprint &&
    JSON.stringify(previous.pendingRequestIds) === JSON.stringify(pendingRequestIds);
  if (!available && previous?.state === "idle" && previous.terminalStatus === "completed")
    return previous;
  if (!available && previous)
    return {
      ...previous,
      state: "unavailable",
      terminalStatus:
        previous.state === "working" || previous.state === "waiting" || previous.state === "queued"
          ? null
          : previous.terminalStatus,
      stalled: false,
    };
  const lastReplyExcerpt = replyExcerpt(facts.lastReplyExcerpt);
  return {
    ...((facts.agent ?? previous?.agent) ? { agent: facts.agent ?? previous?.agent } : {}),
    state: facts.state,
    runId: facts.runId,
    runStartedAt: facts.runStartedAt,
    ...(facts.earlierRunStart ? { earlierRunStart: facts.earlierRunStart } : {}),
    pendingRequestIds,
    pendingRequests: available
      ? facts.pendingRequests
          .map(({ id, kind, question, questions }) => ({
            id,
            kind,
            ...(question ? { question } : {}),
            options:
              questions?.length === 1
                ? (questions[0]!.options?.map((option) => option.label) ?? [])
                : [],
          }))
          .sort((a, b) => a.id.localeCompare(b.id))
      : [],
    queue: available
      ? (facts.waitingAdmissions?.find((admission) => admission.runId === facts.runId) ??
        facts.waitingAdmissions?.toSorted((a, b) => a.position - b.position)[0] ??
        null)
      : null,
    personStopped:
      facts.interruptRequested ??
      (previous?.runId === facts.runId && previous?.personStopped) ??
      false,
    progressFingerprint: facts.progressFingerprint,
    progressSince: sameProgress ? previous.progressSince : now,
    terminalStatus: facts.terminalStatus,
    ...(facts.failureReason ? { failureReason: facts.failureReason } : {}),
    ...(lastReplyExcerpt ? { lastReplyExcerpt } : {}),
    stalled:
      continuous &&
      (previous.stalled ||
        (facts.runId !== null &&
          facts.progressFingerprint !== null &&
          now - previous.progressSince >= MANAGED_CHAT_STALL_MS)),
  };
}
