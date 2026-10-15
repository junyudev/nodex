import { assert, it } from "@effect/vitest";
import type {
  AgentRuntimeMethod,
  AgentRuntimeOperations,
  AgentThreadAuthority,
} from "@nodex/agent-runtime/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type {
  AgentRuntimeProcessConnection,
  AgentRuntimeProcessDelivery,
} from "../platform/node/AgentRuntimeProcess";
import { make } from "./AgentRuntimePresentationRelease";

const proof = (threadId: string, runId = "run") =>
  ({
    threadId,
    runId,
    userMessageId: `message:${threadId}`,
    providerSessionId: "provider-session",
    nativeGeneration: 1,
  }) as AgentThreadAuthority;

const fixture = Effect.gen(function* () {
  const events = yield* PubSub.unbounded<AgentRuntimeProcessDelivery>();
  const ended = yield* Deferred.make<never>();
  const settled = yield* Deferred.make<void>();
  const live = new Set(["root", "child"]);
  const reads: string[] = [];
  const finished: unknown[][] = [];
  const observations: string[] = [];
  let subscriptions = 0;
  let unobserved: string[] = [];
  const request: AgentRuntimeProcessConnection["request"] = <M extends AgentRuntimeMethod>(
    method: M,
    input: AgentRuntimeOperations[M]["input"],
  ) =>
    Effect.sync(() => {
      if (method === "execution.observe")
        return {
          subscribed: true,
          subscriptionId: `lifecycle:${++subscriptions}`,
          afterSequence: 0,
        } as AgentRuntimeOperations[M]["output"];
      if (method === "events.unobserve") {
        unobserved = [
          ...unobserved,
          (input as AgentRuntimeOperations["events.unobserve"]["input"]).subscriptionId,
        ];
        return { unsubscribed: true } as AgentRuntimeOperations[M]["output"];
      }
      if (method !== "thread.authority") throw Error(`Unexpected runtime request ${method}`);
      const thread = (input as AgentRuntimeOperations["thread.authority"]["input"]).threadId;
      reads.push(thread);
      return (
        live.has(thread) ? { runtimeId: "runtime", runtimeGeneration: "generation" } : null
      ) as AgentRuntimeOperations[M]["output"];
    });
  const connection: AgentRuntimeProcessConnection = {
    identity: {
      runtimeId: "runtime",
      runtimeGeneration: "generation",
      schemaVersion: 1,
      databasePath: "/runtime.sqlite",
      mcpEndpoint: "http://localhost:1/mcp",
      lastSequence: 0,
    },
    request,
    terminated: Deferred.await(ended),
    notifications: Stream.fromPubSub(events),
    subscribeNotifications: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
    subscribeExecutionNotifications: PubSub.subscribe(events).pipe(
      Effect.map(Stream.fromSubscription),
    ),
  };
  const release = yield* make(connection, {
    observeRuntimeMessage: (threadId, runId) =>
      Effect.sync(() => observations.push(`${threadId}/${runId}`)),
    finish: (...args) => finished.push(["run", ...args]),
    finishRuntimeSource: (value) => finished.push(["source", value]),
    finishRuntimeLease: (...args) => {
      finished.push(["lease", ...args]);
      Deferred.doneUnsafe(settled, Effect.void);
    },
  });
  const lifecycle = (
    delivery: number,
    threadId: string,
    runStatus: "completed" | "running" | "cancelled",
    options: { readonly generation?: string; readonly subscription?: number } = {},
  ) =>
    PubSub.publish(events, {
      delivery,
      notification: {
        type: "execution.lifecycle",
        subscriptionId: `lifecycle:${options.subscription ?? 1}`,
        runtimeGeneration: options.generation ?? "generation",
        sequence: delivery,
        threadId,
        eventType: "run.updated",
        runId: "run",
        runStatus,
      },
    });
  const settle = Effect.sleep("20 millis");
  return {
    release,
    events,
    live,
    reads,
    finished,
    observations,
    lifecycle,
    settle,
    settled,
    unobserved: () => unobserved,
  };
});

it.live("cancellation releases only the exact Run presentation of the current process", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.release.observe(proof("root"));
    yield* f.release.observe(proof("child"));
    yield* f.lifecycle(1, "root", "cancelled", { generation: "previous" });
    yield* f.lifecycle(2, "child", "completed");
    yield* f.lifecycle(3, "root", "cancelled");
    yield* f.settle;
    assert.deepEqual(f.observations, ["root/run", "child/run"]);
    assert.deepEqual(f.finished, [["run", "root", "run"]]);
    assert.deepEqual(f.reads, ["root", "child"]);
  }).pipe(Effect.scoped),
);

it.live("a cancellation delivered before the presentation existed still releases it", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.live.delete("root");
    yield* f.release.observe(proof("root"));
    assert.deepEqual(f.finished, [["run", "root", "run"]]);
  }).pipe(Effect.scoped),
);

it.live("skipped deliveries and resubscription recheck only Runs that hold a presentation", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.release.observe(proof("root"));
    yield* f.release.observe(proof("child"));
    yield* f.lifecycle(1, "root", "running");
    f.live.delete("root");
    yield* f.lifecycle(7, "child", "running");
    yield* f.settle;
    assert.deepEqual(f.finished, [["run", "root", "run"]]);
    assert.deepEqual(f.reads, ["root", "child", "root", "child"]);
    f.live.delete("child");
    yield* PubSub.publish(f.events, {
      delivery: 8,
      notification: { type: "event.error", subscriptionId: "lifecycle:1", message: "lagged" },
    });
    yield* f.settle;
    assert.deepEqual(f.finished, [
      ["run", "root", "run"],
      ["run", "child", "run"],
    ]);
    assert.deepEqual(f.reads, ["root", "child", "root", "child", "child"]);
  }).pipe(Effect.scoped),
);

it.live(
  "a closed native source releases its presentations and stream loss releases the lease",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (const [delivery, runtimeGeneration] of [
        [1, "previous"],
        [2, "generation"],
      ] as const)
        yield* PubSub.publish(f.events, {
          delivery,
          notification: {
            type: "execution.native-session.closed",
            runtimeId: "runtime",
            runtimeGeneration,
            providerSessionId: "provider-session",
            nativeGeneration: 1,
            incarnationId: "incarnation:one",
          },
        });
      yield* f.settle;
      assert.deepEqual(f.finished, [
        [
          "source",
          {
            runtimeId: "runtime",
            runtimeGeneration: "generation",
            providerSessionId: "provider-session",
            nativeGeneration: 1,
          },
        ],
      ]);
      yield* PubSub.shutdown(f.events);
      yield* Deferred.await(f.settled).pipe(Effect.timeout("2 seconds"));
      assert.deepEqual(f.finished.at(-1), ["lease", "runtime", "generation"]);
    }).pipe(Effect.scoped),
);
