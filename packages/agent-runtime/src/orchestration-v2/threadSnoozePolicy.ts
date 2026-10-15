import * as DateTime from "effect/DateTime";
import type * as ProjectionStore from "./ProjectionStore.ts";

export function toMillis(value: DateTime.Utc | null | undefined): number | null {
  return value == null ? null : DateTime.toEpochMillis(value);
}

export function isSnoozed(
  thread: Pick<
    ProjectionStore.ProjectionSettlementCandidate,
    "snoozedUntil" | "snoozedAt" | "latestRunCompletedAt" | "status" | "pendingRuntimeRequest"
  >,
  nowMs: number,
): boolean {
  const snoozedUntilMs = toMillis(thread.snoozedUntil);
  if (snoozedUntilMs === null || snoozedUntilMs <= nowMs) return false;
  if (thread.pendingRuntimeRequest !== null) return false;
  const snoozedAtMs = toMillis(thread.snoozedAt);
  const completedAtMs = toMillis(thread.latestRunCompletedAt);
  const wokeOnError =
    thread.status === "failed" &&
    (snoozedAtMs === null || (completedAtMs !== null && completedAtMs > snoozedAtMs));
  // Like the client, only a run that completed wakes it; an interrupt or cancel does not.
  const wokeOnCompletion =
    thread.status === "completed" &&
    snoozedAtMs !== null &&
    completedAtMs !== null &&
    completedAtMs > snoozedAtMs;
  return !wokeOnError && !wokeOnCompletion;
}
