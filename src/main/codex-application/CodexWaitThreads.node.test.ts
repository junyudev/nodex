/* oxlint-disable effecttsgo/strict-effect-provide -- The test entry point owns the scoped callback runtime and native event bus. */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import { CodexNativeThreadLookup, CodexNativeThreadLookupError } from "./CodexNativeThreadLookup";
import {
  CodexMainConversationManagers,
  type MainConversationManager,
} from "./CodexMainConversationManagers";
import { make } from "./CodexWaitThreads";
import { CodexGateway, CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import type { CodexEndpointEvent } from "../codex-runtime/CodexEventHub";
import { CodexApplicationEventHub, make as makeEvents } from "./CodexApplicationEventHub";
import { layer as callbackLayer } from "../app/ScopedCallbackRuntime";
import { turnFixture } from "./conversation-test-fixture";
const params = {
  namespace: "codex_app",
  tool: "wait_threads",
  threadId: "caller",
  turnId: "source-turn",
  callId: "wait-call",
  arguments: { targets: [{ threadId: "target" }], timeoutMs: 120000 },
};
const makeHarness = (holdPage = false) =>
  Effect.gen(function* () {
    const native = yield* PubSub.unbounded<CodexEndpointEvent>();
    const events = yield* makeEvents;
    const read = yield* Deferred.make<void>();
    const page = yield* Deferred.make<void>();
    let retired = false;
    let generation = 1;
    const requests: number[] = [];
    const manager = {
      hostId: "local",
      get generation() {
        return generation;
      },
      assertCurrent: (expected = generation) => {
        if (retired || expected !== generation) throw new Error("account or connection retired");
      },
      onDispose: () => ({ [Symbol.dispose]() {} }),
    } as unknown as MainConversationManager;
    const service = yield* make.pipe(
      Effect.provideService(CodexNativeThreadLookup, {
        resolve: () =>
          Effect.try({
            try: () => {
              manager.assertCurrent();
              return { hostId: "local", manager, thread: {} };
            },
            catch: (cause) => new CodexNativeThreadLookupError({ threadId: "target", cause }),
          }),
      } as unknown as CodexNativeThreadLookup["Service"]),
      Effect.provideService(CodexMainConversationManagers, {
        get: () => Effect.succeed(manager),
        current: () => manager,
      } as unknown as CodexMainConversationManagers["Service"]),
      Effect.provideService(CodexApplicationEventHub, events),
      Effect.provideService(CodexThreadHostResolver, { resolve: () => Effect.succeed("local") }),
      Effect.provideService(CodexGateway, {
        localHostId: "local",
        events: Stream.fromPubSub(native),
        awaitReady: () => Effect.void,
        connection: () => Effect.succeed({ kind: "ready", hostId: "local", generation: 1 }),
        requestOnHost: (
          _host: string,
          method: string,
          _params: unknown,
          options: { expectedGeneration: number },
        ) =>
          Effect.gen(function* () {
            requests.push(options.expectedGeneration);
            if (options.expectedGeneration !== generation)
              return yield* Effect.fail("stale native generation" as const);
            yield* Deferred.succeed(read, undefined);
            if (holdPage && method === "thread/turns/list") yield* Deferred.await(page);
            return method === "thread/read"
              ? { thread: { status: { type: "active", activeFlags: [] } } }
              : { data: [turnFixture(`target-turn-${options.expectedGeneration}`, "inProgress")] };
          }),
      } as unknown as CodexGateway["Service"]),
    );
    return {
      service,
      native,
      events,
      read,
      page,
      requests,
      reconnect: () => {
        generation += 1;
      },
      retire: () => {
        retired = true;
      },
    };
  });
const harness = makeHarness();
it.effect("a retained manager polls through the current physical connection after reconnect", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.service.execute({
      ...params,
      arguments: { targets: [{ threadId: "before" }], timeoutMs: 0 },
    });
    h.reconnect();
    const response = yield* h.service.execute({
      ...params,
      arguments: { targets: [{ threadId: "after" }], timeoutMs: 0 },
    });
    const content = response?.contentItems[0];
    assert.strictEqual(content?.type, "inputText");
    if (content?.type !== "inputText") return;
    const result = JSON.parse(content.text);
    assert.deepEqual(result.errors ?? [], []);
    assert.lengthOf(result.polls, 1);
    assert.deepEqual(h.requests, [1, 1, 2, 2]);
  }).pipe(Effect.provide(callbackLayer)),
);

it.effect(
  "reconnect discards the old polling response and retries through the current connection",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(true);
      const fiber = yield* h.service
        .execute({ ...params, arguments: { ...params.arguments, timeoutMs: 0 } })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(h.read);
      h.reconnect();
      yield* Deferred.succeed(h.page, undefined);
      const response = yield* Fiber.join(fiber);
      const content = response?.contentItems[0];
      assert.strictEqual(content?.type, "inputText");
      if (content?.type !== "inputText") return;
      const result = JSON.parse(content.text);
      assert.deepEqual(result.errors ?? [], []);
      assert.lengthOf(result.polls, 1);
      assert.strictEqual(result.polls[0].latestTurn.id, "target-turn-2");
      assert.include(h.requests, 1);
      assert.deepEqual(h.requests.slice(-2), [2, 2]);
    }).pipe(Effect.provide(callbackLayer)),
);
it.effect("steering the caller interrupts wait with a successful non-timeout result", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const fiber = yield* h.service.execute(params).pipe(Effect.forkScoped);
    yield* Deferred.await(h.read);
    h.events.publish({ kind: "conversationTurnSteered", value: "caller" });
    const response = yield* Fiber.join(fiber);
    assert.strictEqual(response?.success, true);
    assert.deepEqual(response?.contentItems, [
      {
        type: "inputText",
        text: JSON.stringify({ message: "Wait interrupted by new input.", timedOut: false }),
      },
    ]);
  }).pipe(Effect.provide(callbackLayer)),
);
it.effect("completion of the calling turn suppresses a late tool response", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const fiber = yield* h.service.execute(params).pipe(Effect.forkScoped);
    yield* Deferred.await(h.read);
    yield* PubSub.publish(h.native, {
      kind: "notification",
      hostId: "local",
      generation: 1,
      value: {
        protocol: "extension",
        method: "turn/completed",
        params: { threadId: "caller", turn: turnFixture("source-turn") },
      },
    });
    assert.strictEqual(yield* Fiber.join(fiber), null);
  }).pipe(Effect.provide(callbackLayer)),
);
it.effect("wait rejects self and duplicate targets before starting native work", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const self = yield* h.service.execute({
      ...params,
      arguments: { targets: [{ threadId: "caller" }] },
    });
    assert.strictEqual(self?.success, false);
    const duplicate = yield* h.service.execute({
      ...params,
      arguments: { targets: [{ threadId: "target" }, { threadId: "target", hostId: "local" }] },
    });
    assert.strictEqual(duplicate?.success, false);
    assert.strictEqual(yield* Deferred.isDone(h.read), false);
  }).pipe(Effect.provide(callbackLayer)),
);

it.effect("an authenticated manager retirement rejects a late native polling result", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness(true);
    const fiber = yield* h.service
      .execute({ ...params, arguments: { ...params.arguments, timeoutMs: 0 } })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(h.read);
    h.retire();
    yield* Deferred.succeed(h.page, undefined);
    const response = yield* Fiber.join(fiber);
    assert.strictEqual(response?.success, true);
    const content = response?.contentItems[0];
    assert.strictEqual(content?.type, "inputText");
    if (content?.type !== "inputText") return;
    const result = JSON.parse(content.text);
    assert.lengthOf(result.errors, 1);
    assert.lengthOf(result.polls, 0);
  }).pipe(Effect.provide(callbackLayer)),
);
