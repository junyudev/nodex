import { createUuidV7 } from "@nodex/mobile-protocol";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { ConnectionLink, MobileConnection } from "./connection";
import type { MobilePlatform } from "./platform";
import { disconnected, RpcFailure } from "./rpc-client";

export function mintId(platform: MobilePlatform, timestamp = platform.now()) {
  return createUuidV7(platform.randomBytes, timestamp);
}
export function errorMessage(error: unknown, fallback: string) {
  return error instanceof RpcFailure ? error.message : fallback;
}

export const waitForLink = Effect.fn("MobileConnection.waitForLink")(function* (
  connection: MobileConnection,
  hostId: string,
) {
  const check = Effect.suspend(() => {
    if (connection.activeHostId() !== hostId) return Effect.fail(disconnected());
    return Effect.succeed(connection.activeLink());
  });
  const current = yield* check;
  if (current) return current;
  const changes = Stream.merge(
    connection.state.changes.pipe(Stream.map(() => undefined)),
    connection.hosts.changes.pipe(Stream.map(() => undefined)),
  );
  const link = yield* changes.pipe(
    Stream.mapEffect(() => check),
    Stream.filter((link) => link !== null),
    Stream.take(1),
    Stream.runHead,
    Effect.timeoutOrElse({ duration: 30_000, orElse: () => Effect.fail(disconnected()) }),
  );
  if (link._tag === "None") return yield* Effect.fail(disconnected());
  return link.value;
});

/** Retries one command's stable identity; a Host switch always ends its admission. */
export const retryOperation = Effect.fn("MobileOperation.retry")(function* <T, E, R>(
  connection: MobileConnection,
  run: (link: ConnectionLink) => Effect.Effect<T, E, R>,
) {
  const initial = yield* connection.requireLink;
  const hostId = initial.hello.host.id;
  return yield* Effect.suspend(() =>
    waitForLink(connection, hostId).pipe(
      Effect.flatMap((link) => connection.assertLink(link).pipe(Effect.andThen(run(link)))),
    ),
  ).pipe(
    Effect.retry({
      times: 2,
      schedule: Schedule.exponential(1_000),
      while: (error) =>
        error instanceof RpcFailure && error.retryable && connection.activeHostId() === hostId,
    }),
  );
});
