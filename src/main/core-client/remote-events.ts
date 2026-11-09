import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  CoreEventCompatibilityError,
  CoreEventReplayError,
  CoreHttpError,
  CoreTransportError,
} from "./local-http";
import { RemoteCertificateError } from "./remote-http";
import type {
  CoreClientPort,
  CoreEventEnvelope,
  CoreEventReplayRequired,
  CoreStreamCheckpoint,
} from "./types";

const retryable = (error: unknown): boolean => {
  if (
    error instanceof RemoteCertificateError ||
    error instanceof CoreEventCompatibilityError ||
    error instanceof CoreEventReplayError
  )
    return false;
  if (error instanceof CoreTransportError && error.cause instanceof RemoteCertificateError)
    return false;
  if (error instanceof CoreHttpError) return error.status === 429 || error.status >= 500;
  return error instanceof CoreTransportError;
};

/** Scoped remote event recovery. Only successfully delivered checkpoints advance
 * the resume cursor. Mutation retries keep their existing operation identity. */
export const runRemoteCoreEvents = Effect.fnUntraced(function* (input: {
  readonly client: Pick<CoreClientPort, "openEventStream">;
  readonly after: number;
  readonly onEvent: (event: CoreEventEnvelope) => void;
  readonly onCheckpoint: (checkpoint: CoreStreamCheckpoint) => void;
  readonly onResyncRequired: (event: CoreEventReplayRequired) => void;
}) {
  let after = input.after;
  const attempt = Effect.scoped(
    Effect.gen(function* () {
      const lease = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: (signal) =>
            input.client.openEventStream(
              after,
              input.onEvent,
              (checkpoint) => {
                input.onCheckpoint(checkpoint);
                after = checkpoint.scanned_through_seq;
              },
              input.onResyncRequired,
              signal,
            ),
          catch: (error) =>
            error instanceof Error
              ? error
              : new Error("Remote Core transport failed", { cause: error }),
        }),
        (subscription) => Effect.sync(() => subscription.close()),
      );
      yield* Effect.tryPromise({
        try: () => lease.done,
        catch: (error) =>
          error instanceof Error
            ? error
            : new Error("Remote Core transport failed", { cause: error }),
      });
      return yield* Effect.fail(
        new CoreTransportError(
          "connection_lost",
          "response",
          null,
          new Error("Remote stream ended"),
        ),
      );
    }),
  );
  return yield* attempt.pipe(
    Effect.retry({
      while: retryable,
      schedule: Schedule.min([
        Schedule.exponential("250 millis"),
        Schedule.spaced("15 seconds"),
      ]).pipe(Schedule.jittered),
    }),
  );
});
