import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
  ServerNotificationMethod,
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
import { CodexInternalThreadRegistry } from "./CodexInternalThreadRegistry";
import { ThreadCreationRuntime } from "./ThreadCreationRuntime";
import { transparentThreadCreationRuntime } from "./ThreadCreationRuntime.test-support";
import {
  CODEX_STRUCTURED_THREAD_TITLE_NOTIFICATION_QUEUE_CAPACITY,
  make,
  type CodexStructuredThreadTitleOptions,
} from "./CodexStructuredThreadTitle";

type ThreadStartResponse = ClientRequestResponsesByMethod["thread/start"];
type TurnStartResponse = ClientRequestResponsesByMethod["turn/start"];

const threadStarted = (threadId: string): ThreadStartResponse =>
  ({
    thread: { id: threadId, historyMode: "paginated", turns: [] },
  }) as unknown as ThreadStartResponse;

const turnStarted = (turnId: string): TurnStartResponse =>
  ({ turn: { id: turnId } }) as TurnStartResponse;

const notification = (
  method: ServerNotificationMethod,
  params: unknown,
  hostId = "local",
): CodexEndpointEvent =>
  ({
    kind: "notification",
    generation: 1,
    hostId,
    value: { method, params },
  }) as CodexEndpointEvent;

const makeOptions = (
  events: PubSub.PubSub<CodexEndpointEvent>,
  overrides: Partial<CodexStructuredThreadTitleOptions> = {},
) => {
  const lifecycle: string[] = [];
  const options: CodexStructuredThreadTitleOptions = {
    hostId: "local",
    generation: Effect.succeed(1),
    events: Stream.fromPubSub(events),
    startThread: () => Effect.succeed(threadStarted("thread-title")),
    startTurn: () => Effect.succeed(turnStarted("turn-title")),
    interruptTurn: (_threadId, turnId) => Effect.sync(() => lifecycle.push(`interrupt:${turnId}`)),
    unsubscribeThread: (threadId) => Effect.sync(() => lifecycle.push(`unsubscribe:${threadId}`)),
    ...overrides,
  };
  return { lifecycle, options };
};

const makeRuntime = (options: CodexStructuredThreadTitleOptions, lifecycle: string[]) =>
  make(options).pipe(
    Effect.provideService(ThreadCreationRuntime, transparentThreadCreationRuntime),
    Effect.provideService(
      CodexInternalThreadRegistry,
      CodexInternalThreadRegistry.of({
        leaseStructuredTitle: (threadId) =>
          Effect.gen(function* () {
            lifecycle.push(`register:${threadId}`);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => lifecycle.push(`release:${threadId}`)),
            );
          }),
        observeStarted: () => null,
        classification: () => null,
        shouldSuppress: () => false,
        clear: () => undefined,
      }),
    ),
  );

it.effect("rejects and releases a title helper start that returns inline history", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<CodexEndpointEvent>();
    let turnStarted = false;
    const { lifecycle, options } = makeOptions(events, {
      startThread: () =>
        Effect.succeed({
          thread: {
            id: "thread-title-inline",
            historyMode: "paginated",
            turns: [{ id: "turn-inline", items: [], status: "completed" }],
          },
        } as never),
      startTurn: () => {
        turnStarted = true;
        return Effect.die("inline history must fail before title generation");
      },
    });
    const runtime = yield* makeRuntime(options, lifecycle);

    const failure = yield* runtime
      .generate({ prompt: "Metadata only", cwd: null })
      .pipe(Effect.flip);

    assert.strictEqual(failure.reason, "request-failed");
    assert.isFalse(turnStarted);
    assert.deepEqual(lifecycle, ["unsubscribe:thread-title-inline"]);
  }),
);

it.effect("buffers an exact-host title completion that arrives before turn/start responds", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<CodexEndpointEvent>();
    const threadStartRequests: ClientRequestParamsByMethod["thread/start"][] = [];
    const turnStartRequests: ClientRequestParamsByMethod["turn/start"][] = [];
    const { lifecycle, options } = makeOptions(events, {
      startThread: (params) =>
        Effect.sync(() => {
          threadStartRequests.push(params);
          return threadStarted("thread-title-1");
        }),
      startTurn: (params) => {
        turnStartRequests.push(params);
        return PubSub.publish(
          events,
          notification(
            "item/agentMessage/delta",
            {
              threadId: "thread-title-1",
              turnId: "turn-title-1",
              itemId: "message-1",
              delta: '{"title":"Wrong host"}',
            },
            "ssh",
          ),
        ).pipe(
          Effect.andThen(
            PubSub.publish(
              events,
              notification("item/agentMessage/delta", {
                threadId: "thread-title-1",
                turnId: "turn-title-1",
                itemId: "message-1",
                delta: '{"title":"Refactor inbox list layout"}',
              }),
            ),
          ),
          Effect.andThen(
            PubSub.publish(
              events,
              notification("turn/completed", {
                threadId: "thread-title-1",
                turn: { id: "turn-title-1", status: "completed" },
              }),
            ),
          ),
          Effect.as(turnStarted("turn-title-1")),
        );
      },
    });
    const runtime = yield* makeRuntime(options, lifecycle);

    assert.strictEqual(
      yield* runtime.generate({
        prompt: "Refactor inbox list layout",
        cwd: "/tmp/codex",
        serviceName: "source-service",
      }),
      "Refactor inbox list layout",
    );
    assert.strictEqual(threadStartRequests[0]?.ephemeral, true);
    assert.strictEqual(threadStartRequests[0]?.threadSource, "system");
    assert.strictEqual(threadStartRequests[0]?.serviceName, "source-service");
    assert.strictEqual(turnStartRequests[0]?.threadId, "thread-title-1");
    assert.strictEqual(turnStartRequests[0]?.permissions, ":read-only");
    assert.deepEqual(lifecycle, [
      "register:thread-title-1",
      "unsubscribe:thread-title-1",
      "release:thread-title-1",
    ]);
  }),
);

it.effect("filters foreign-thread payloads before title inbox byte admission", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<CodexEndpointEvent>();
    const giantForeignDelta = "x".repeat(128 * 1024);
    const { lifecycle, options } = makeOptions(events, {
      startTurn: () =>
        Effect.forEach(
          Array.from({ length: 40 }),
          () =>
            PubSub.publish(
              events,
              notification("item/agentMessage/delta", {
                threadId: "unrelated-thread",
                turnId: "unrelated-turn",
                itemId: "unrelated-item",
                delta: giantForeignDelta,
              }),
            ),
          { discard: true },
        ).pipe(
          Effect.andThen(
            PubSub.publish(
              events,
              notification("item/agentMessage/delta", {
                threadId: "thread-title",
                turnId: "turn-title",
                itemId: "message-1",
                delta: '{"title":"Bounded title"}',
              }),
            ),
          ),
          Effect.andThen(
            PubSub.publish(
              events,
              notification("turn/completed", {
                threadId: "thread-title",
                turn: { id: "turn-title", status: "completed" },
              }),
            ),
          ),
          Effect.as(turnStarted("turn-title")),
        ),
    });
    const runtime = yield* makeRuntime(options, lifecycle);

    assert.strictEqual(
      yield* runtime.generate({ prompt: "Bounded title", cwd: null }),
      "Bounded title",
    );
    assert.notInclude(lifecycle, "interrupt:turn-title");
  }),
);

it.effect("fails and interrupts when a title notification exceeds byte admission", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<CodexEndpointEvent>();
    const { lifecycle, options } = makeOptions(events, {
      startTurn: () =>
        PubSub.publish(
          events,
          notification("item/agentMessage/delta", {
            threadId: "thread-title",
            turnId: "turn-oversized-notification",
            itemId: "message-1",
            delta: "x".repeat(128 * 1024),
          }),
        ).pipe(Effect.as(turnStarted("turn-oversized-notification"))),
    });
    const runtime = yield* makeRuntime(options, lifecycle);
    const error = yield* runtime
      .generate({ prompt: "Bounded notification", cwd: null })
      .pipe(Effect.flip);

    assert.strictEqual(error.reason, "notification-overflow");
    assert.deepEqual(lifecycle, [
      "register:thread-title",
      "interrupt:turn-oversized-notification",
      "unsubscribe:thread-title",
      "release:thread-title",
    ]);
  }),
);

it.effect("fails and interrupts when the pre-response title inbox reaches its count cap", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<CodexEndpointEvent>();
    const { lifecycle, options } = makeOptions(events, {
      startTurn: () =>
        Effect.forEach(
          Array.from({ length: CODEX_STRUCTURED_THREAD_TITLE_NOTIFICATION_QUEUE_CAPACITY + 1 }),
          (_, index) =>
            PubSub.publish(
              events,
              notification("item/agentMessage/delta", {
                threadId: "thread-title",
                turnId: "turn-count-overflow",
                itemId: `message-${index}`,
                delta: "x",
              }),
            ),
          { discard: true },
        ).pipe(Effect.as(turnStarted("turn-count-overflow"))),
    });
    const runtime = yield* makeRuntime(options, lifecycle);
    const error = yield* runtime.generate({ prompt: "Bounded count", cwd: null }).pipe(Effect.flip);

    assert.strictEqual(error.reason, "notification-overflow");
    assert.deepEqual(lifecycle, [
      "register:thread-title",
      "interrupt:turn-count-overflow",
      "unsubscribe:thread-title",
      "release:thread-title",
    ]);
  }),
);

it.effect("fails and interrupts when accumulated title output exceeds 16 KiB", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<CodexEndpointEvent>();
    const { lifecycle, options } = makeOptions(events, {
      startTurn: () =>
        Effect.forEach(
          Array.from({ length: 17 }),
          (_, index) =>
            PubSub.publish(
              events,
              notification("item/agentMessage/delta", {
                threadId: "thread-title",
                turnId: "turn-output-overflow",
                itemId: `message-${index}`,
                delta: "x".repeat(1024),
              }),
            ),
          { discard: true },
        ).pipe(Effect.as(turnStarted("turn-output-overflow"))),
    });
    const runtime = yield* makeRuntime(options, lifecycle);
    const error = yield* runtime
      .generate({ prompt: "Bounded output", cwd: null })
      .pipe(Effect.flip);

    assert.strictEqual(error.reason, "output-overflow");
    assert.deepEqual(lifecycle, [
      "register:thread-title",
      "interrupt:turn-output-overflow",
      "unsubscribe:thread-title",
      "release:thread-title",
    ]);
  }),
);

it.effect("uses the completed agent message instead of partial deltas", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<CodexEndpointEvent>();
    const { lifecycle, options } = makeOptions(events, {
      startTurn: () =>
        PubSub.publish(
          events,
          notification("item/agentMessage/delta", {
            threadId: "thread-title",
            turnId: "turn-title",
            itemId: "message-1",
            delta: "partial",
          }),
        ).pipe(
          Effect.andThen(
            PubSub.publish(
              events,
              notification("item/completed", {
                threadId: "thread-title",
                turnId: "turn-title",
                completedAtMs: 1,
                item: {
                  id: "message-1",
                  type: "agentMessage",
                  text: '{"title":"title: \\"Fix flaky.\\""}',
                },
              }),
            ),
          ),
          Effect.andThen(
            PubSub.publish(
              events,
              notification("turn/completed", {
                threadId: "thread-title",
                turn: { id: "turn-title", status: "completed" },
              }),
            ),
          ),
          Effect.as(turnStarted("turn-title")),
        ),
    });
    const runtime = yield* makeRuntime(options, lifecycle);
    assert.strictEqual(yield* runtime.generate({ prompt: "Fix flaky", cwd: null }), "Fix flaky");
  }),
);

it.effect("reports terminal failure and best-effort interrupts and unsubscribes", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<CodexEndpointEvent>();
    const { lifecycle, options } = makeOptions(events, {
      startTurn: () =>
        PubSub.publish(
          events,
          notification("error", {
            threadId: "thread-title",
            turnId: "turn-failed",
            willRetry: false,
            error: { message: "model unavailable", additionalDetails: null },
          }),
        ).pipe(
          Effect.andThen(
            PubSub.publish(
              events,
              notification("turn/completed", {
                threadId: "thread-title",
                turn: { id: "turn-failed", status: "failed", error: null },
              }),
            ),
          ),
          Effect.as(turnStarted("turn-failed")),
        ),
    });
    const runtime = yield* makeRuntime(options, lifecycle);
    const error = yield* runtime
      .generate({ prompt: "Fix title flow", cwd: null })
      .pipe(Effect.flip);
    assert.strictEqual(error.reason, "turn-failed");
    assert.include(error.message, "model unavailable");
    assert.deepEqual(lifecycle, [
      "register:thread-title",
      "interrupt:turn-failed",
      "unsubscribe:thread-title",
      "release:thread-title",
    ]);
  }),
);

it.effect("uses the Effect clock for the sole operation deadline", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<CodexEndpointEvent>();
    const started = yield* Deferred.make<void>();
    const { lifecycle, options } = makeOptions(events, {
      timeout: "2 seconds",
      startTurn: () =>
        Deferred.succeed(started, undefined).pipe(Effect.as(turnStarted("turn-timeout"))),
    });
    const runtime = yield* makeRuntime(options, lifecycle);
    const timedOut = yield* Effect.forkChild(
      runtime.generate({ prompt: "Timeout", cwd: null }).pipe(Effect.flip),
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust("1999 millis");
    yield* TestClock.adjust("1 millis");
    assert.strictEqual((yield* Fiber.join(timedOut)).reason, "timeout");
    assert.deepEqual(lifecycle, [
      "register:thread-title",
      "interrupt:turn-timeout",
      "unsubscribe:thread-title",
      "release:thread-title",
    ]);
  }),
);

it.effect("releases the helper Thread when the Main Scope closes", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const events = yield* PubSub.unbounded<CodexEndpointEvent>();
    const started = yield* Deferred.make<void>();
    const { lifecycle, options } = makeOptions(events, {
      startTurn: () =>
        Deferred.succeed(started, undefined).pipe(Effect.as(turnStarted("turn-closing"))),
    });
    const runtime = yield* makeRuntime(options, lifecycle).pipe(
      Effect.provideService(Scope.Scope, scope),
    );
    const closed = yield* Effect.forkChild(
      runtime.generate({ prompt: "Closing", cwd: null }).pipe(Effect.flip),
    );
    yield* Deferred.await(started);
    yield* Scope.close(scope, Exit.void);
    assert.strictEqual((yield* Fiber.join(closed)).reason, "runtime-closed");
    assert.deepEqual(lifecycle, [
      "register:thread-title",
      "interrupt:turn-closing",
      "unsubscribe:thread-title",
      "release:thread-title",
    ]);
  }),
);
