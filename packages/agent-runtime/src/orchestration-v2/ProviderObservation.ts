import type * as ProviderAdapter from "@nodex/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
import { isSqlError } from "effect/sql/SqlError";

/** Only transport/reader/lock/I/O SQL faults are retryable; malformed data and SQL are not. */
export function isTransientObservationFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 16 && error != null && !seen.has(error); depth++) {
    seen.add(error);
    if (Cause.isCause(error)) {
      error = Cause.squash(error);
      continue;
    }
    if (isSqlError(error)) {
      if (error.isRetryable) return true;
      const reason = error.reason;
      if (reason._tag !== "UnknownError") return false;
      const cause = reason.cause as { code?: unknown; errcode?: unknown; message?: unknown } | null;
      return (
        /SQLITE_(?:INTERRUPT|IOERR|BUSY|LOCKED)/u.test(String(cause?.code ?? "")) ||
        (typeof cause?.errcode === "number" && [5, 6, 9, 10].includes(cause.errcode & 0xff)) ||
        /(?:Database reader query was interrupted|database is (?:locked|busy)|disk I\/O error)/iu.test(
          `${reason.message ?? ""} ${cause?.message ?? ""}`,
        )
      );
    }
    if (typeof error !== "object") return false;
    error = (error as { cause?: unknown }).cause;
  }
  return false;
}

/** Seventeen retries: 100 ms doubling to 5 s, about one minute in total. */
export const retryObservation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.exit(effect).pipe(
    Effect.flatMap((exit) =>
      Exit.isFailure(exit) ? Effect.fail(exit.cause) : Effect.succeed(exit.value),
    ),
    Effect.retry(($) =>
      $(Schedule.min([Schedule.exponential("100 millis"), Schedule.spaced("5 seconds")])).pipe(
        Schedule.upTo({ times: 17 }),
        Schedule.while(
          ({ input }) => !Cause.hasInterruptsOnly(input) && isTransientObservationFailure(input),
        ),
      ),
    ),
    Effect.catch((cause) => Effect.failCause(cause)),
  );

/** Reattachment is bounded independently from event persistence retries. */
export const reconcileProviderTurn = (
  session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  input: Parameters<
    NonNullable<ProviderAdapter.ProviderAdapterV2SessionRuntime["reconcileTurn"]>
  >[0],
) =>
  (
    session.reconcileTurn?.(input) ??
    Effect.succeed<ProviderAdapter.ProviderAdapterV2TurnReconciliation>({
      status: "unknown",
      events: [],
    })
  ).pipe(
    Effect.timeout("15 seconds"),
    Effect.retry(Schedule.spaced("1 second").pipe(Schedule.upTo({ times: 3 }))),
  );
