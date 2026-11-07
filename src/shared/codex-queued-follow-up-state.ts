import type { ModeKind, ReasoningSummary } from "@nodex/codex-app-server-protocol";
import type { ThreadSettings } from "@nodex/codex-app-server-protocol/v2";
import type { CodexPromptInput } from "./types";
import { normalizeCodexServiceTier } from "./codex-service-tier";

export const CODEX_INTERRUPTED_STEER_REASON = "Interrupted before the steer was accepted." as const;
export const CODEX_ENDED_STEER_REASON = "Run ended before the steer was accepted." as const;

export type CodexQueuedFollowUpPause =
  | {
      readonly kind: "interrupted";
      readonly reason: typeof CODEX_INTERRUPTED_STEER_REASON;
    }
  | {
      readonly kind: "failed";
      readonly reason: string;
    }
  // The whole queue waits for an explicit resume; the reason says why.
  | {
      readonly kind: "held";
      readonly reason: string;
    };

/** Composer presentation derived from the manager's captured queue messages. */
export interface CodexQueuedFollowUp {
  readonly deliveryOwner?: "local" | "server";
  readonly canSendNow?: boolean;
  readonly followUpId: string;
  readonly clientUserMessageId: string;
  readonly threadId: string;
  readonly prompt: string;
  readonly promptInput: CodexPromptInput;
  readonly createdAtMs: number;
  readonly collaborationMode: ModeKind | null;
  readonly serviceTier: ThreadSettings["serviceTier"];
  readonly summary: ReasoningSummary | null;
  readonly pause: CodexQueuedFollowUpPause | null;
}

export type CreateCodexQueuedFollowUpInput = Pick<
  CodexQueuedFollowUp,
  "followUpId" | "clientUserMessageId" | "threadId" | "prompt" | "createdAtMs"
> &
  Partial<
    Pick<
      CodexQueuedFollowUp,
      "promptInput" | "collaborationMode" | "serviceTier" | "summary" | "pause"
    >
  >;

export function createCodexQueuedFollowUp(
  input: CreateCodexQueuedFollowUpInput,
): CodexQueuedFollowUp {
  return {
    followUpId: input.followUpId,
    clientUserMessageId: input.clientUserMessageId,
    threadId: input.threadId,
    prompt: input.prompt,
    promptInput: input.promptInput ?? { text: input.prompt },
    createdAtMs: input.createdAtMs,
    collaborationMode: input.collaborationMode ?? null,
    serviceTier: normalizeCodexServiceTier(input.serviceTier),
    summary: input.summary ?? null,
    pause: input.pause ?? null,
  };
}

export type CodexQueuedFollowUpProjectionStatus = "loading" | "ready" | "error";
export type CodexQueuedFollowUpFreshStartResolution = "resume" | "clear";

/** Immutable Composer view derived locally from queue documents and submission activity. */
export interface CodexQueuedFollowUpProjection {
  readonly status: CodexQueuedFollowUpProjectionStatus;
  readonly ledgerRevision: number;
  readonly projectionRevision: number;
  readonly entries: readonly CodexQueuedFollowUp[];
  readonly inFlightFollowUpId: string | null;
  readonly editingFollowUpId: string | null;
  readonly error: string | null;
  readonly hasPreviousPage?: boolean;
  readonly hasNextPage?: boolean;
}

export const EMPTY_CODEX_QUEUED_FOLLOW_UP_PROJECTION: CodexQueuedFollowUpProjection = {
  status: "ready",
  ledgerRevision: 0,
  projectionRevision: 0,
  entries: [],
  inFlightFollowUpId: null,
  editingFollowUpId: null,
  error: null,
};
