import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { CodexEndpointEvent } from "../codex-runtime/CodexEventHub";
import { make } from "./CodexHeartbeatTurnCompletion";

type Turn = ClientRequestResponsesByMethod["turn/start"]["turn"];
type TurnStartParams = ClientRequestParamsByMethod["turn/start"];
type TurnStatus = Turn["status"];

const turn = (id: string, status: TurnStatus): Turn => ({
  id,
  status,
  items: [],
  itemsView: "full",
  error: null,
  startedAt: 1,
  completedAt: status === "inProgress" ? null : 2,
  durationMs: status === "inProgress" ? null : 1_000,
});

const completed = (
  threadId: string,
  turnId: string,
  status: TurnStatus,
  hostId = "local",
): CodexEndpointEvent => ({
  kind: "notification",
  generation: 1,
  hostId,
  value: {
    protocol: "generated",
    method: "turn/completed",
    params: { threadId, turn: turn(turnId, status) },
  },
});

const turnStartParams = { threadId: "thread-1" } as TurnStartParams;

it.effect("buffers early completion and accepts only the exact local turn", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<CodexEndpointEvent>();
    const response = { turn: turn("turn-1", "inProgress") };
    const runtime = yield* make({
      events: Stream.fromPubSub(events),
      resolveHost: () => Effect.succeed("local"),
      request: () =>
        PubSub.publish(events, completed("thread-1", "turn-1", "completed", "ssh")).pipe(
          Effect.andThen(PubSub.publish(events, completed("thread-1", "turn-other", "completed"))),
          Effect.andThen(PubSub.publish(events, completed("thread-1", "turn-1", "completed"))),
          Effect.as(response),
        ),
    });

    assert.strictEqual((yield* runtime.startAndWait(turnStartParams)).turn.id, "turn-1");
  }),
);

it.effect("fails a terminal heartbeat turn that did not complete successfully", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<CodexEndpointEvent>();
    const runtime = yield* make({
      events: Stream.fromPubSub(events),
      resolveHost: () => Effect.succeed("local"),
      request: () =>
        PubSub.publish(events, completed("thread-1", "turn-failed", "failed")).pipe(
          Effect.as({ turn: turn("turn-failed", "inProgress") }),
        ),
    });

    const error = yield* runtime.startAndWait(turnStartParams).pipe(Effect.flip);
    assert.strictEqual(error.reason, "turn-failed");
    assert.strictEqual(error.status, "failed");
    assert.strictEqual(error.turnId, "turn-failed");
  }),
);

it.effect("starts one non-failing deadline before host resolution and turn/start", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<CodexEndpointEvent>();
    const requested = yield* Deferred.make<void>();
    const runtime = yield* make({
      events: Stream.fromPubSub(events),
      resolveHost: () =>
        Deferred.succeed(requested, undefined).pipe(
          Effect.andThen(Effect.sleep("750 millis")),
          Effect.as("local"),
        ),
      timeout: "2 seconds",
      request: () =>
        Effect.sleep("750 millis").pipe(Effect.as({ turn: turn("turn-timeout", "inProgress") })),
    });
    const result = yield* Effect.forkChild(runtime.startAndWait(turnStartParams));
    yield* Deferred.await(requested);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("1999 millis");
    yield* TestClock.adjust("1 millis");
    assert.strictEqual((yield* Fiber.join(result)).turn.id, "turn-timeout");
  }),
);

it.effect("ends an active completion wait when the Main Scope closes", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const events = yield* PubSub.unbounded<CodexEndpointEvent>();
    const requested = yield* Deferred.make<void>();
    const runtime = yield* make({
      events: Stream.fromPubSub(events),
      resolveHost: () => Effect.succeed("local"),
      request: () =>
        Deferred.succeed(requested, undefined).pipe(
          Effect.as({ turn: turn("turn-closing", "inProgress") }),
        ),
    }).pipe(Effect.provideService(Scope.Scope, scope));
    const closed = yield* Effect.forkChild(runtime.startAndWait(turnStartParams).pipe(Effect.flip));
    yield* Deferred.await(requested);
    yield* Scope.close(scope, Exit.void);
    assert.strictEqual((yield* Fiber.join(closed)).reason, "runtime-closed");
  }),
);

it.effect("attributes an early completion only to the admitted automation turn", () =>
  Effect.gen(function* () {
    const requested = yield* Deferred.make<void>();
    const response = yield* Deferred.make<ClientRequestResponsesByMethod["turn/start"]>();
    const runtime = yield* make({
      events: Stream.empty,
      resolveHost: () => Effect.succeed("local"),
      request: () =>
        Deferred.succeed(requested, undefined).pipe(Effect.andThen(Deferred.await(response))),
    });
    const started = yield* Effect.forkChild(runtime.start(turnStartParams, "failed_runs_only"));
    yield* Deferred.await(requested);
    const early = yield* Effect.forkChild(
      runtime.notificationDecision("thread-1", "automation-turn", "completed"),
    );
    yield* Effect.yieldNow;
    yield* Deferred.succeed(response, { turn: turn("automation-turn", "inProgress") });
    yield* Fiber.join(started);
    assert.deepEqual(yield* Fiber.join(early), { decision: "DONT_NOTIFY" });
    assert.strictEqual(
      yield* runtime.notificationDecision("thread-1", "manual-turn", "completed"),
      null,
    );
    assert.strictEqual(
      yield* runtime.notificationDecision("thread-other", "automation-turn", "completed"),
      null,
    );
    assert.strictEqual(
      (yield* runtime.notificationDecision("thread-1", "automation-turn", "failed"))?.decision,
      "NOTIFY",
    );
  }),
);

it.effect("releases notification attribution when a pending launch is interrupted", () =>
  Effect.gen(function* () {
    const requested = yield* Deferred.make<void>();
    const runtime = yield* make({
      events: Stream.empty,
      resolveHost: () => Effect.succeed("local"),
      request: () => Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never)),
    });
    const started = yield* Effect.forkChild(runtime.start(turnStartParams, "failed_runs_only"));
    yield* Deferred.await(requested);
    const decision = yield* Effect.forkChild(
      runtime.notificationDecision("thread-1", "unaccepted-turn", "completed"),
    );
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(started);
    assert.strictEqual(yield* Fiber.join(decision), null);
  }),
);

it.effect("distinguishes an unmuted heartbeat from an unrelated manual turn", () =>
  Effect.gen(function* () {
    const runtime = yield* make({
      events: Stream.empty,
      resolveHost: () => Effect.succeed("local"),
      request: () => Effect.succeed({ turn: turn("heartbeat", "inProgress") }),
    });
    yield* runtime.start(turnStartParams, null);
    assert.deepEqual(yield* runtime.notificationDecision("thread-1", "heartbeat", "completed"), {
      decision: null,
    });
    assert.strictEqual(
      yield* runtime.notificationDecision("thread-1", "manual", "completed"),
      null,
    );
  }),
);
