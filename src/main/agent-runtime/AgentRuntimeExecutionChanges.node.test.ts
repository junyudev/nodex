import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Option from "effect/Option";
import type {
  AgentRuntimeProcessConnection,
  AgentRuntimeProcessDelivery,
} from "../platform/node/AgentRuntimeProcess";
import { subscribe } from "./AgentRuntimeExecutionChanges";

const fixture = Effect.gen(function* () {
  const events = yield* PubSub.sliding<AgentRuntimeProcessDelivery>(64);
  const closed = yield* Deferred.make<void>();
  let subscriptions = 0;
  const connection = {
    terminated: Deferred.await(closed),
    subscribeExecutionNotifications: PubSub.subscribe(events).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          subscriptions += 1;
        }),
      ),
      Effect.map(Stream.fromSubscription),
    ),
  } as AgentRuntimeProcessConnection;
  const publish = PubSub.publish(events, {
    delivery: 1,
    notification: {
      type: "execution.lifecycle",
      subscriptionId: "lifecycle",
      runtimeGeneration: "generation",
      sequence: 1,
      threadId: "root",
      eventType: "run.updated",
      runStatus: "completed",
    },
  });
  return {
    connection,
    publish,
    close: Deferred.succeed(closed, undefined),
    subscriptions: () => subscriptions,
  };
});

it.effect("captures lifecycle changes after eager preparation and before the first pull", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const events = yield* subscribe(Effect.succeed(f.connection));
    assert.strictEqual(f.subscriptions(), 1);
    yield* f.publish;
    assert.isTrue(Option.isSome(yield* Stream.runHead(events)));
  }),
);

it.effect(
  "invalidates lost execution and acquires a fresh generation without transcript reads",
  () =>
    Effect.gen(function* () {
      const first = yield* fixture;
      const next = yield* fixture;
      let connects = 0;
      const observed = yield* Deferred.make<void>();
      const events = yield* subscribe(
        Effect.sync(() => (++connects === 1 ? first.connection : next.connection)),
      );
      const result = yield* events.pipe(
        Stream.tap(() => Deferred.succeed(observed, undefined)),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* first.publish;
      yield* Deferred.await(observed);
      yield* first.close;
      yield* TestClock.adjust("250 millis");
      assert.strictEqual((yield* Fiber.join(result)).length, 3);
      assert.strictEqual(connects, 2);
      assert.strictEqual(next.subscriptions(), 1);
    }),
);
