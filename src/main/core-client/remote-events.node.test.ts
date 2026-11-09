import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import { CoreHttpError, CoreTransportError } from "./local-http";
import { runRemoteCoreEvents } from "./remote-events";
import type { CoreClientPort, CoreStreamCheckpoint } from "./types";

const settle = (predicate: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200; i += 1) {
      if (predicate()) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error("Remote stream did not settle"));
  });

it.effect(
  "reconnect resumes the delivered cursor and closing the scope closes its active lease",
  () =>
    Effect.gen(function* () {
      const opened: number[] = [];
      let closeCount = 0;
      const client: Pick<CoreClientPort, "openEventStream"> = {
        openEventStream: async (after, _event, checkpoint) => {
          opened.push(after);
          if (opened.length === 1) {
            checkpoint({
              store_epoch: "epoch",
              generation: "core",
              scanned_through_seq: 7,
              oldest_available_seq: 1,
              resync_token: null,
            } as CoreStreamCheckpoint);
            return {
              done: Promise.reject(
                new CoreTransportError("connection_lost", "response", null, null),
              ),
              close: () => {
                closeCount += 1;
              },
            };
          }
          return {
            done: new Promise<void>(() => {}),
            close: () => {
              closeCount += 1;
            },
          };
        },
      };
      const fiber = yield* runRemoteCoreEvents({
        client,
        after: 3,
        onEvent: () => {},
        onCheckpoint: () => {},
        onResyncRequired: () => {},
      }).pipe(Effect.forkScoped);
      yield* settle(() => closeCount === 1);
      yield* TestClock.adjust("1 second");
      yield* settle(() => opened.length === 2);
      assert.deepEqual(opened, [3, 7]);
      yield* Fiber.interrupt(fiber);
      assert.strictEqual(closeCount, 2);
    }),
);

it.effect("membership refusal is terminal", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const client: Pick<CoreClientPort, "openEventStream"> = {
      openEventStream: async () => {
        attempts += 1;
        throw new CoreHttpError(401, "Revoked");
      },
    };
    const result = yield* runRemoteCoreEvents({
      client,
      after: 0,
      onEvent: () => {},
      onCheckpoint: () => {},
      onResyncRequired: () => {},
    }).pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
    assert.strictEqual(attempts, 1);
  }),
);
