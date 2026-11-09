import { z } from "zod";
import type { components } from "@nodex/core-protocol";

export const MANAGED_CHAT_STALL_MS = 20 * 60 * 1000;
const terminalStatus = z.enum(["completed", "failed", "interrupted"]).nullable();
const observationSchema = z.strictObject({
  agent: z
    .strictObject({ instanceId: z.string(), model: z.string(), effort: z.string().nullable() })
    .optional(),
  state: z.enum(["working", "queued", "waiting", "idle", "failed", "unavailable"]),
  runId: z.string().nullable(),
  runStartedAt: z.number().finite().nullable(),
  pendingRequestIds: z.array(z.string()),
  pendingRequests: z
    .array(
      z.strictObject({
        id: z.string(),
        kind: z.enum(["question", "approval"]),
        question: z.string().optional(),
        options: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  queue: z
    .strictObject({
      runId: z.string(),
      class: z.enum(["person", "continuation", "start"]),
      position: z.number().int().positive(),
      waitingSince: z.string(),
    })
    .nullable()
    .default(null),
  personStopped: z.boolean().default(false),
  progressFingerprint: z.string().nullable(),
  progressSince: z.number().finite(),
  terminalStatus,
  failureReason: z.string().nullable().optional(),
  stalled: z.boolean(),
});
export type ManagedChatObservation = z.infer<typeof observationSchema>;
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
  readonly agent?: ManagedChatObservation["agent"];
  readonly waitingAdmissions?: readonly {
    readonly runId: string;
    readonly class: "person" | "continuation" | "start";
    readonly position: number;
    readonly waitingSince: string;
  }[];
  readonly state: ManagedChatObservation["state"];
  readonly runId: string | null;
  readonly runStartedAt: number | null;
  readonly terminalStatus: ManagedChatObservation["terminalStatus"];
  readonly pendingRequests: readonly ManagedChatRequest[];
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
export function parseManagedChatObservation(value: unknown): ManagedChatObservation | null {
  const parsed = observationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Preserve the complete envelope when it fits; oversized questions cannot block observation. */
function attentionPayload(request: ManagedChatRequest) {
  const payload = {
    requestId: request.id,
    kind: request.kind,
    ...(request.question ? { question: request.question } : {}),
    ...(request.questions?.length
      ? {
          questions: request.questions.map(({ question, options }) => ({
            question,
            ...(options
              ? {
                  options: options.map(({ label, description }) => ({
                    label,
                    ...(description ? { description } : {}),
                  })),
                }
              : {}),
          })),
        }
      : {}),
  };
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  if (encoded.byteLength <= 24000) return payload;
  // JSON escaping can double the excerpt's size. Leave space for the request envelope too.
  return {
    requestId: request.id,
    kind: request.kind,
    text: new TextDecoder().decode(encoded.subarray(0, 10000)) + "… [truncated]",
    truncated: true,
  };
}

/** Occurrences only wake this decision: current owner facts, reports and a baseline decide events. */
export function diffManagedChatObservation(input: {
  readonly sessionId: string;
  readonly previous: ManagedChatObservation | null;
  /** Unmanaged execution observations must not consume a managed chat's notification baseline. */
  readonly eventPrevious?: ManagedChatObservation | null;
  readonly facts: ManagedChatFacts;
  readonly now: number;
  readonly latestReportAt: number | null;
  /** Restart only the stall grace; persisted observations still detect completed work. */
  readonly restartStallClock?: boolean;
}): {
  readonly observed: ManagedChatObservation;
  readonly events: components["schemas"]["CoordinatorWorkEventInput"][];
  readonly resolvedRequestIds: string[];
} {
  const { sessionId, facts, now, latestReportAt } = input;
  const previous = input.previous;
  const eventPrevious = input.eventPrevious === undefined ? previous : input.eventPrevious;
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
    input.previous &&
    !input.restartStallClock &&
    input.previous.state === facts.state &&
    input.previous.runId === facts.runId &&
    input.previous.progressFingerprint === facts.progressFingerprint &&
    JSON.stringify(input.previous.pendingRequestIds) === JSON.stringify(pendingRequestIds);
  const observed: ManagedChatObservation = {
    ...((facts.agent ?? previous?.agent) ? { agent: facts.agent ?? previous!.agent } : {}),
    state: facts.state,
    runId: facts.runId,
    runStartedAt: facts.runStartedAt,
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
    progressSince: sameProgress ? input.previous!.progressSince : now,
    terminalStatus: facts.terminalStatus,
    ...(facts.failureReason ? { failureReason: facts.failureReason } : {}),
    stalled: continuous ? previous.stalled : false,
  };
  const events: components["schemas"]["CoordinatorWorkEventInput"][] = [];
  if (!available)
    return {
      observed: previous ? { ...previous, state: "unavailable", stalled: false } : observed,
      events,
      resolvedRequestIds: [],
    };
  const resolvedRequestIds = (eventPrevious?.pendingRequestIds ?? []).filter(
    (id) => !pendingRequestIds.includes(id),
  );
  for (const request of facts.pendingRequests) {
    if (eventPrevious?.pendingRequestIds.includes(request.id)) continue;
    if (events.some((event) => event.dedupe_key === `attention:${sessionId}:${request.id}`))
      continue;
    events.push({
      kind: "attention",
      session_id: sessionId,
      page_id: null,
      dedupe_key: `attention:${sessionId}:${request.id}`,
      payload: attentionPayload(request),
    });
  }
  const newlyEnded =
    eventPrevious &&
    facts.runId &&
    facts.terminalStatus &&
    (eventPrevious.runId !== facts.runId || eventPrevious.terminalStatus !== facts.terminalStatus);
  if (newlyEnded && !facts.interruptRequested && facts.terminalStatus !== "completed") {
    events.push({
      kind: "failed",
      session_id: sessionId,
      page_id: null,
      dedupe_key: `failed:${sessionId}:${facts.runId}`,
      payload: { runId: facts.runId, status: facts.terminalStatus },
    });
  }
  if (
    newlyEnded &&
    !facts.interruptRequested &&
    facts.terminalStatus === "completed" &&
    pendingRequestIds.length === 0 &&
    facts.runStartedAt !== null &&
    (latestReportAt === null || latestReportAt < facts.runStartedAt)
  ) {
    events.push({
      kind: "turn_ended",
      session_id: sessionId,
      page_id: null,
      dedupe_key: `turn_ended:${sessionId}:${facts.runId}`,
      payload: {
        runId: facts.runId,
        ...(facts.lastReplyExcerpt ? { summary: facts.lastReplyExcerpt.slice(0, 600) } : {}),
      },
    });
  }
  if (
    continuous &&
    facts.runId &&
    facts.progressFingerprint !== null &&
    !observed.stalled &&
    now - observed.progressSince >= MANAGED_CHAT_STALL_MS
  ) {
    observed.stalled = true;
  }
  if (
    observed.stalled &&
    !eventPrevious?.stalled &&
    facts.runId &&
    facts.progressFingerprint !== null &&
    !facts.interruptRequested
  ) {
    events.push({
      kind: "stalled",
      session_id: sessionId,
      page_id: null,
      dedupe_key: `stalled:${sessionId}:${facts.runId}:${facts.progressFingerprint}`,
      payload: { runId: facts.runId, progressSince: observed.progressSince },
    });
  }
  return { observed, events, resolvedRequestIds };
}
