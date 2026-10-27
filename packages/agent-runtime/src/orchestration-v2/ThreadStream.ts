import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";

import { omitLocalVisibleTurnItems } from "@t3tools/shared/orchestrationV2BoundedSnapshot";

import {
  buildBoundedThreadProjection,
  type BoundedProjectionResult,
} from "./threadHistoryPaging.ts";
import { projectThreadProjectionForWire } from "./WireProjection.ts";
import { retainPublicThreadControlClosure } from "./PublicThreadProjection.ts";
import { THREAD_HISTORY_PAGE_POLICY } from "./threadHistoryPaging.ts";

/** Maximum number of reducer applications allowed during a thread resume. */
export const THREAD_RESUME_MAX_REPLAY_EVENTS = 128;

/** Maximum encoded event JSON allowed during a thread resume. */
export const THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES = 1_048_576;

/**
 * Maximum aggregate persisted payload JSON decoded for one thread resume.
 * Keep the original preflight budget: decoded objects and temporary strings
 * cost more than their stored JSON, even if wire projection shrinks them later.
 */
export const THREAD_RESUME_MAX_RAW_PAYLOAD_BYTES = 1_048_576;

/** Resource-safety check applied before persisted replay payloads are decoded. */
export function isThreadReplayRawPayloadSafe(rawPayloadBytes: number): boolean {
  return rawPayloadBytes <= THREAD_RESUME_MAX_RAW_PAYLOAD_BYTES;
}

/** Encoded payload cost after events have been projected for the wire. */
export function threadReplayEncodedBytes(items: ReadonlyArray<unknown>): number {
  let total = 0;
  for (const item of items) {
    const encoded = JSON.stringify(item);
    total += Buffer.byteLength(encoded ?? "", "utf8");
  }
  return total;
}

type ThreadSnapshotStreamItem = Extract<
  OrchestrationV2ThreadStreamItem,
  { readonly kind: "snapshot" }
>;

/**
 * Bounded snapshot fields shared by the HTTP route and socket fallbacks. Only
 * clients that opted in get compact `turnItems` and the marker; everyone else
 * gets the unchanged representation.
 */
export function boundedSnapshotResponseFields(input: {
  readonly bounded: BoundedProjectionResult;
  readonly compactTurnItems: boolean;
  readonly requiredRunId?: string | undefined;
  readonly requiredRequestId?: string | undefined;
}) {
  const { bounded } = input;
  const publicProjection = retainPublicThreadControlClosure(
    projectThreadProjectionForWire(bounded.projection),
    input.requiredRunId,
    input.requiredRequestId,
  );
  const compactProjection = input.compactTurnItems
    ? omitLocalVisibleTurnItems(publicProjection)
    : null;
  const fields = {
    projection: compactProjection ?? publicProjection,
    historyCursor: bounded.historyCursor,
    hasMoreHistory: bounded.hasMoreHistory,
    latestLocalTurnOrdinal: bounded.latestLocalTurnOrdinal,
    payloadBudgetExceeded: false,
    ...(compactProjection === null ? {} : { turnItemsOmitLocalVisible: true as const }),
  };
  const itemIds = new Set(fields.projection.turnItems.map((item) => `${item.threadId}:${item.id}`));
  for (const row of fields.projection.visibleTurnItems)
    itemIds.add(`${row.sourceThreadId}:${row.sourceItemId}`);
  // Reserve the enclosing response fields. Oversized control state is an
  // explicit read failure, never an exception to the public wire budget.
  if (
    itemIds.size > THREAD_HISTORY_PAGE_POLICY.maxItems ||
    Buffer.byteLength(JSON.stringify(fields), "utf8") >
      THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes - 1_024
  )
    throw new Error("The thread's control state exceeds the snapshot transport budget.");
  return fields;
}

/** Build the same bounded, wire-projected snapshot for every socket fallback path. */
export function buildBoundedThreadStreamSnapshot(input: {
  readonly snapshotSequence: number;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly compactTurnItems?: boolean;
  readonly hasEarlierHistory?: boolean | undefined;
  readonly latestLocalTurnOrdinal?: number | null | undefined;
  readonly requiredRunId?: string | undefined;
  readonly requiredRequestId?: string | undefined;
}): ThreadSnapshotStreamItem {
  const bounded = buildBoundedThreadProjection({
    snapshotSequence: input.snapshotSequence,
    projection: projectThreadProjectionForWire(input.projection),
    hasEarlierHistory: input.hasEarlierHistory,
    latestLocalTurnOrdinal: input.latestLocalTurnOrdinal,
  });
  return {
    kind: "snapshot",
    snapshotSequence: input.snapshotSequence,
    ...boundedSnapshotResponseFields({
      bounded,
      compactTurnItems: input.compactTurnItems === true,
      requiredRunId: input.requiredRunId,
      requiredRequestId: input.requiredRequestId,
    }),
  };
}

export type ThreadResumePlan =
  | {
      readonly mode: "replay";
      readonly afterSequence: number;
      readonly throughSequence: number;
    }
  | { readonly mode: "snapshot" };

/**
 * Decide whether a thread subscription should replay the event gap after the
 * client's cursor or send a fresh snapshot instead.
 *
 * A client cursor above the high water mark is stale or invalid. Event count
 * limits reducer churn while encoded bytes limit a small number of large
 * updates. Either excess is cheaper to replace with one current snapshot.
 */
export function decideThreadResume(input: {
  readonly afterSequence: number;
  readonly highWater: number;
  readonly replayEventCount: number;
  readonly replayEncodedBytes: number;
}): ThreadResumePlan {
  if (
    input.afterSequence > input.highWater ||
    input.replayEventCount > THREAD_RESUME_MAX_REPLAY_EVENTS ||
    input.replayEncodedBytes > THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES
  ) {
    return { mode: "snapshot" };
  }
  return {
    mode: "replay",
    afterSequence: input.afterSequence,
    throughSequence: input.highWater,
  };
}
