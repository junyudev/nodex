import type { AgentRuntimeMethod, AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { expect } from "vitest";
import type { AgentRuntimeProcessConnection } from "../platform/node/AgentRuntimeProcess";
import { AgentRuntimeApplication } from "./AgentRuntimeApplication";
import { makeSessionObservation } from "./AgentRuntimeSessionObservation";
import { AgentRuntimeSupervisor } from "./AgentRuntimeSupervisor";

const observerFixture = Effect.gen(function* () {
  const observing = yield* Deferred.make<void>();
  const reply = yield* Deferred.make<AgentRuntimeOperations["events.observe"]["output"]>();
  const released: string[] = [];
  const connection = {
    identity: { runtimeId: "runtime" },
    subscribeNotifications: Effect.succeed(Stream.never),
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
  return { observe, observing, reply, released };
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
