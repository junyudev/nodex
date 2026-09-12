import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { make } from "./CodexResumeIngress";
import type { CodexApplicationProtocolOccurrence } from "../codex-runtime/CodexApplicationRequestInbox";
const notification = (
  token: number,
  method: string,
  params: unknown,
): CodexApplicationProtocolOccurrence => ({
  kind: "notification",
  protocol: "generated",
  hostId: "local",
  generation: 7,
  occurrenceId: `event-${token}`,
  occurrenceToken: token,
  method,
  params,
});
it.effect(
  "releases native notifications and requests in order after removing the resume gate",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ingress = yield* make;
        const replayed: number[] = [];
        const rejected: number[] = [];
        assert.isTrue(ingress.begin("thread"));
        assert.isFalse(ingress.begin("thread"));
        const events: CodexApplicationProtocolOccurrence[] = [
          notification(1, "turn/started", { threadId: "thread", turn: { id: "turn" } }),
          {
            kind: "request",
            protocol: "generated",
            hostId: "local",
            generation: 7,
            occurrenceId: "request",
            occurrenceToken: 2,
            requestId: 3,
            method: "item/tool/requestUserInput",
            params: { threadId: "thread", turnId: "turn" },
          },
          notification(3, "turn/completed", { threadId: "thread", turn: { id: "turn" } }),
        ];
        for (const occurrence of events)
          assert.isTrue(
            ingress.offer("thread", {
              occurrence,
              replay: (event) =>
                Effect.sync(() => {
                  assert.isFalse(ingress.has("thread"));
                  replayed.push(event.occurrenceToken);
                  return false;
                }),
              reject: (event) =>
                Effect.sync(() => {
                  rejected.push(event.occurrenceToken);
                }),
            }),
          );
        yield* ingress.release("thread", null);
        assert.deepEqual(replayed, [1, 2, 3]);
        assert.deepEqual(rejected, []);
      }),
    ),
);
it.effect("discard settles buffered requests without delivering native notifications", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ingress = yield* make;
      ingress.begin("thread");
      const rejected: unknown[] = [];
      const event = notification(1, "turn/started", { threadId: "thread", turn: { id: "turn" } });
      ingress.offer("thread", {
        occurrence: event,
        replay: () => Effect.die("must not replay"),
        reject: (occurrence, reason) =>
          Effect.sync(() => {
            rejected.push([occurrence.generation, reason]);
          }),
      });
      yield* ingress.discard("thread", "retired");
      assert.deepEqual(rejected, [[7, "retired"]]);
      assert.isFalse(ingress.has("thread"));
    }),
  ),
);

it.effect(
  "interrupted replay rejects every remaining occurrence without touching a successor buffer",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ingress = yield* make;
        const entered = yield* Deferred.make<void>();
        const rejected: number[] = [];
        const replayed: number[] = [];
        ingress.begin("thread", { hostId: "local", generation: 7 });
        for (const token of [1, 2, 3]) {
          const occurrence = notification(token, "turn/started", {
            threadId: "thread",
            turn: { id: `turn-${token}` },
          });
          ingress.offer("thread", {
            occurrence,
            replay: () =>
              Effect.sync(() => {
                replayed.push(token);
              }).pipe(
                Effect.andThen(
                  token === 2
                    ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
                    : Effect.void,
                ),
                Effect.as(false),
              ),
            reject: (event) =>
              Effect.sync(() => {
                rejected.push(event.occurrenceToken);
              }),
          });
        }
        const running = yield* ingress.release("thread", null).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Effect.yieldNow;
        ingress.begin("thread", { hostId: "local", generation: 8 });
        yield* Fiber.interrupt(running);
        assert.deepEqual(replayed, [1, 2]);
        assert.deepEqual(rejected, [2, 3]);
        assert.isTrue(ingress.has("thread"));
        yield* ingress.release("thread", null);
        assert.deepEqual(rejected, [2, 3]);
      }),
    ),
);
it.effect(
  "keeps another host generation outside the gate and settles its own pending ingress on disposal",
  () =>
    Effect.gen(function* () {
      const rejected: number[] = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const ingress = yield* make;
          ingress.begin("thread", { hostId: "local", generation: 7 });
          const delivery = (occurrence: CodexApplicationProtocolOccurrence) => ({
            occurrence,
            replay: () => Effect.die("must not replay"),
            reject: (event: CodexApplicationProtocolOccurrence) =>
              Effect.sync(() => {
                rejected.push(event.occurrenceToken);
              }),
          });
          const event = notification(1, "turn/started", {
            threadId: "thread",
            turn: { id: "turn" },
          });
          assert.isFalse(
            ingress.offer("thread", delivery({ ...event, generation: 8, occurrenceToken: 2 })),
          );
          assert.isFalse(
            ingress.offer("thread", delivery({ ...event, hostId: "remote", occurrenceToken: 3 })),
          );
          assert.isTrue(ingress.offer("thread", delivery(event)));
        }),
      );
      assert.deepEqual(rejected, [1]);
    }),
);
