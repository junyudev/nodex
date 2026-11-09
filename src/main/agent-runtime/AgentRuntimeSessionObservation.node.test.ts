import type { AgentRuntimeMethod, AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { expect } from "vitest";
import * as Queue from "effect/Queue";
import type {
  AgentRuntimeProcessConnection,
  AgentRuntimeProcessDelivery,
} from "../platform/node/AgentRuntimeProcess";
import { AgentRuntimeApplication } from "./AgentRuntimeApplication";
import { makeSessionObservation } from "./AgentRuntimeSessionObservation";
import { AgentRuntimeSupervisor } from "./AgentRuntimeSupervisor";

const observerFixture = Effect.gen(function* () {
  const notifications = yield* Queue.unbounded<AgentRuntimeProcessDelivery>();
  const observing = yield* Deferred.make<void>();
  const reply = yield* Deferred.make<AgentRuntimeOperations["events.observe"]["output"]>();
  const released: string[] = [];
  const connection = {
    identity: { runtimeId: "runtime" },
    subscribeNotifications: Effect.succeed(Stream.fromQueue(notifications)),
    terminated: Effect.never,
    request: (method: AgentRuntimeMethod, input: unknown) => {
      if (method === "events.observe")
        return Deferred.succeed(observing, undefined).pipe(Effect.andThen(Deferred.await(reply)));
      if (method !== "events.unobserve") throw new Error(`Unexpected request ${method}`);
      return Effect.sync(() => {
        released.push(
          (input as AgentRuntimeOperations["events.unobserve"]["input"]).subscriptionId,
        );
        return { unsubscribed: true } as const;
      });
    },
  } as unknown as AgentRuntimeProcessConnection;
  const observe = yield* makeSessionObservation.pipe(
    Effect.provideService(AgentRuntimeSupervisor, {
      get: () => Effect.succeed(connection),
    } as unknown as AgentRuntimeSupervisor["Service"]),
    Effect.provideService(AgentRuntimeApplication, {
      resolveTarget: () =>
        Effect.succeed({
          sessionId: "session",
          projectId: null,
          runtimeId: "runtime",
          rootThreadId: "thread",
          threadId: "thread",
        }),
    } as unknown as AgentRuntimeApplication["Service"]),
  );
  return { observe, observing, reply, released, notifications };
});

it.effect("a watcher can leave while execution has not answered its observe", () =>
  Effect.gen(function* () {
    const { observe, observing, released } = yield* observerFixture;
    const reader = yield* Effect.forkChild(Stream.runDrain(observe("session", 42)));
    yield* Deferred.await(observing);
    yield* Fiber.interrupt(reader);
    // The connection releases an observer abandoned this way; see AgentRuntimeProcess.
    expect(released).toEqual([]);
  }),
);

it.effect("releases the subscription a watcher was given when it leaves", () =>
  Effect.gen(function* () {
    const { observe, observing, reply, released } = yield* observerFixture;
    const reader = yield* Effect.forkChild(Stream.runDrain(observe("session", 42)));
    yield* Deferred.await(observing);
    yield* Deferred.succeed(reply, {
      subscribed: true,
      subscriptionId: "observer",
      afterSequence: 42,
    } as const);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(reader);
    expect(released).toEqual(["observer"]);
  }),
);

it.effect("ends with a reset when execution stops delivering to its observer", () =>
  Effect.gen(function* () {
    const { observe, observing, reply, notifications } = yield* observerFixture;
    const reader = yield* Effect.forkChild(Stream.runCollect(observe("session", 42)));
    yield* Deferred.await(observing);
    yield* Deferred.succeed(reply, {
      subscribed: true,
      subscriptionId: "observer",
      afterSequence: 42,
    } as const);
    const event = { type: "run.updated" } as never;
    yield* Queue.offerAll(notifications, [
      { delivery: 1, notification: { type: "event", subscriptionId: "other", event } },
      { delivery: 2, notification: { type: "event", subscriptionId: "observer", event } },
      {
        delivery: 3,
        notification: { type: "event.error", subscriptionId: "observer", message: "stopped" },
      },
      { delivery: 4, notification: { type: "event", subscriptionId: "observer", event } },
    ] as unknown as AgentRuntimeProcessDelivery[]);
    // The watch does not wait on a stream that will never speak again.
    expect(Array.from(yield* Fiber.join(reader))).toEqual([
      { kind: "event", event },
      { kind: "reset" },
    ]);
  }),
);
