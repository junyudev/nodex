import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import type { AgentRuntimeProcessConnection } from "../platform/node/AgentRuntimeProcess";

/** The initial queue is acquired before a waiter's baseline; later generations invalidate it. */
export const subscribe = Effect.fn("AgentRuntimeExecutionChanges.subscribe")(function* (
  connect: Effect.Effect<AgentRuntimeProcessConnection, unknown>,
) {
  const acquire = connect.pipe(
    Effect.flatMap((connection) =>
      connection.subscribeExecutionNotifications.pipe(
        Effect.map((notifications) => ({ connection, notifications })),
      ),
    ),
  );
  type Subscription = Effect.Success<typeof acquire>;
  const generation = ({ connection, notifications }: Subscription) =>
    notifications.pipe(
      Stream.filter(
        ({ notification }) =>
          notification.type === "execution.lifecycle" || notification.type === "event.error",
      ),
      Stream.map(() => undefined),
      Stream.interruptWhen(connection.terminated),
      // A lost process changes observation even if it sent no final lifecycle notification.
      Stream.concat(Stream.succeed(undefined)),
    );
  const reconnect = Stream.unwrap(
    acquire.pipe(
      Effect.map((subscription) =>
        Stream.succeed(undefined).pipe(Stream.concat(generation(subscription))),
      ),
      Effect.catchCause(() =>
        Effect.succeed(
          Stream.fromEffect(Effect.sleep("1 second")).pipe(
            Stream.concat(Stream.succeed(undefined)),
          ),
        ),
      ),
    ),
  ).pipe(
    Stream.concat(Stream.fromEffect(Effect.sleep("250 millis"))),
    Stream.repeat(Schedule.forever),
  );
  return yield* acquire.pipe(
    Effect.map((subscription) => generation(subscription).pipe(Stream.concat(reconnect))),
    Effect.catchCause(() =>
      Effect.succeed(Stream.succeed(undefined).pipe(Stream.concat(reconnect))),
    ),
  );
});
