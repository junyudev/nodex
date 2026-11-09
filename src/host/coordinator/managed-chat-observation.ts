import { z } from "zod";
import type { components } from "@nodex/core-protocol";

export const MANAGED_CHAT_STALL_MS = 20 * 60 * 1000;
const terminalStatus = z.enum(["completed", "failed", "interrupted"]).nullable();
const observationSchema = z.strictObject({
  runId: z.string().nullable(),
  runStartedAt: z.number().finite().nullable(),
  pendingRequestIds: z.array(z.string()),
  progressFingerprint: z.string().nullable(),
  progressSince: z.number().finite(),
  terminalStatus,
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
  readonly state: ManagedChatObservation["state"];
  readonly runId: string | null;
  readonly runStartedAt: number | null;
  readonly terminalStatus: ManagedChatObservation["terminalStatus"];
  readonly pendingRequests: readonly ManagedChatRequest[];
  readonly progressFingerprint: string | null;
  readonly lastReplyExcerpt?: string;
  readonly interruptRequested?: boolean;
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
    state: facts.state,
    runId: facts.runId,
    runStartedAt: facts.runStartedAt,
    pendingRequestIds,
    progressFingerprint: facts.progressFingerprint,
    progressSince: sameProgress ? input.previous!.progressSince : now,
    terminalStatus: facts.terminalStatus,
    stalled: continuous ? previous.stalled : false,
  };
  const events: components["schemas"]["CoordinatorWorkEventInput"][] = [];
    (id) => !pendingRequestIds.includes(id),
  );
  for (const request of facts.pendingRequests) {
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
    facts.runId &&
    facts.terminalStatus &&
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
