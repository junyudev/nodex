import type { ModeKind, ReasoningSummary } from "@nodex/codex-app-server-protocol";
import type { ThreadSettings } from "@nodex/codex-app-server-protocol/v2";
import type { CodexPromptInput } from "./types";
import type { CodexCanonicalSteeringUserMessageItem } from "./codex-conversation-state/codex-conversation-state";
import { normalizeCodexServiceTier } from "./codex-service-tier";

export const CODEX_INTERRUPTED_STEER_REASON = "Interrupted before the steer was accepted." as const;
export const CODEX_ENDED_STEER_REASON = "Run ended before the steer was accepted." as const;
export const CODEX_QUEUED_FOLLOW_UP_PAYLOAD_SCHEMA_VERSION = 2 as const;

export type CodexQueuedFollowUpPause =
  | {
      readonly kind: "interrupted";
      readonly reason: typeof CODEX_INTERRUPTED_STEER_REASON;
    }
  | {
      readonly kind: "failed";
      readonly reason: string;
    };

export interface CodexQueuedFollowUpPayloadRef {
  readonly schemaVersion: typeof CODEX_QUEUED_FOLLOW_UP_PAYLOAD_SCHEMA_VERSION;
  readonly assetUri: string;
  readonly sha256: string;
  readonly byteLength: number;
}

/**
 * A captured Composer submission. Queue identity, app-server deduplication identity,
 * and the immutable payload manifest are deliberately separate concerns.
 */
export interface CodexQueuedFollowUp {
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
  /** Null only while Main is freezing a new submission before its Core commit. */
  readonly payloadRef: CodexQueuedFollowUpPayloadRef | null;
}

export type CreateCodexQueuedFollowUpInput = Pick<
  CodexQueuedFollowUp,
  "followUpId" | "clientUserMessageId" | "threadId" | "prompt" | "createdAtMs"
> &
  Partial<
    Pick<
      CodexQueuedFollowUp,
      "promptInput" | "collaborationMode" | "serviceTier" | "summary" | "pause" | "payloadRef"
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
    payloadRef: input.payloadRef ?? null,
  };
}

export type CodexQueuedFollowUpProjectionStatus = "loading" | "ready" | "error";
export type CodexQueuedFollowUpFreshStartResolution = "resume" | "clear";

/** Immutable full projection authored by Main and published by the active renderer owner. */
export interface CodexQueuedFollowUpProjection {
  readonly status: CodexQueuedFollowUpProjectionStatus;
  readonly ledgerRevision: number;
  readonly projectionRevision: number;
  readonly entries: readonly CodexQueuedFollowUp[];
  readonly inFlightFollowUpId: string | null;
  readonly editingFollowUpId: string | null;
  readonly error: string | null;
}

export const CODEX_QUEUE_OWNER_UPDATE_METHOD = "codex-queue-owner-update" as const;

/**
 * Main-authored transcript work applied atomically with one full queue projection.
 * These directives only update the visible owner document; Main retains canonical
 * steer and queue authority.
 */
export type CodexQueueOwnerTranscriptDirective =
  | { readonly kind: "none" }
  | {
      readonly kind: "stageSteer";
      readonly item: CodexCanonicalSteeringUserMessageItem;
      readonly observedAtMs: number;
    }
  | {
      readonly kind: "retargetSteer";
      readonly clientUserMessageId: string;
      readonly targetTurnId: string;
    }
  | {
      readonly kind: "rejectSteer";
      readonly clientUserMessageId: string;
    };

/** Full, generation-fenced projection sent only to the active renderer owner. */
export interface CodexQueueOwnerUpdateRequest {
  readonly threadId: string;
  readonly threadGeneration: number;
  readonly ownerEpoch: number;
  readonly projectionRevision: number;
  readonly projection: CodexQueuedFollowUpProjection;
  readonly transcript: CodexQueueOwnerTranscriptDirective;
}

export type CodexQueueOwnerUpdateRejectionReason =
  | "not-owner"
  | "thread-generation-mismatch"
  | "owner-epoch-mismatch"
  | "newer-projection-applied"
  | "conversation-unavailable"
  | "canonical-state-unavailable";

export type CodexQueueOwnerUpdateResult =
  | {
      readonly kind: "applied" | "already-applied";
      readonly projectionRevision: number;
      readonly streamRevision: number;
    }
  | {
      readonly kind: "rejected";
      readonly reason: CodexQueueOwnerUpdateRejectionReason;
      readonly currentProjectionRevision: number | null;
    };

export const EMPTY_CODEX_QUEUED_FOLLOW_UP_PROJECTION: CodexQueuedFollowUpProjection = {
  status: "ready",
  ledgerRevision: 0,
  projectionRevision: 0,
  entries: [],
  inFlightFollowUpId: null,
  editingFollowUpId: null,
  error: null,
};

export function isCodexQueuedFollowUpInterrupted(entry: CodexQueuedFollowUp): boolean {
  return entry.pause?.kind === "interrupted";
}

export function hasInterruptedCodexQueuedFollowUps(
  projection: Pick<CodexQueuedFollowUpProjection, "entries">,
): boolean {
  return projection.entries.some(isCodexQueuedFollowUpInterrupted);
}

export function getAutomaticCodexQueuedFollowUp(
  projection: CodexQueuedFollowUpProjection,
): CodexQueuedFollowUp | null {
  if (projection.status !== "ready" || projection.inFlightFollowUpId) return null;
  const head = projection.entries[0];
  if (!head || head.pause) return null;
  return head;
}

export function getManualCodexQueuedFollowUp(
  projection: CodexQueuedFollowUpProjection,
  followUpId: string,
): CodexQueuedFollowUp | null {
  if (projection.status !== "ready" || projection.inFlightFollowUpId) return null;
  return projection.entries.find((entry) => entry.followUpId === followUpId) ?? null;
}

export function doesCodexQueuedFollowUpProjectionBlockHandoff(
  projection: CodexQueuedFollowUpProjection,
): boolean {
  return (
    projection.status !== "ready" ||
    projection.entries.length > 0 ||
    projection.inFlightFollowUpId !== null ||
    projection.editingFollowUpId !== null
  );
}
