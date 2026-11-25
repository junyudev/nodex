import { describe, expect, test } from "vite-plus/test";
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
import { turnFixture, conversationFixture } from "./conversation-test-fixture";
import { produce } from "immer";
import {
  interruptSubagentDescendants,
  CodexSubagentDirectoryError,
} from "./CodexSubagentDirectory";
import {
  projectCodexSubagentOverviewWindow,
  type CoreSubagentOverviewLike,
  type CoreSubagentOverviewThreadLike,
} from "./CodexSubagentDirectoryProjection";

describe("CodexWaitThreads", () => {
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
                : {
                    data: [turnFixture(`target-turn-${options.expectedGeneration}`, "inProgress")],
                  };
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
  it.effect(
    "a retained manager polls through the current physical connection after reconnect",
    () =>
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
});

describe("CodexSubagentInterrupt", () => {
  it.effect(
    "stops known resident descendants before discovery, then checks remaining active Turns once",
    () =>
      Effect.gen(function* () {
        const events: string[] = [];
        const active = conversationFixture("resident", [
          turnFixture("resident-turn", "inProgress"),
        ]);
        const idle = produce(conversationFixture("idle", []), (draft) => {
          draft.threadRuntimeStatus = { type: "idle" };
          draft.resumeState = "resumed";
        });
        const rows = [
          { threadId: "resident", active: false },
          { threadId: "idle", active: true },
          { threadId: "cold", active: true },
          { threadId: "finished", active: true },
          { threadId: "unknown", active: false },
        ];
        const result = yield* interruptSubagentDescendants({
          known: Effect.succeed({ rows, complete: false }),
          discover: Effect.sync(() => {
            events.push("discover");
            return { rows, complete: false };
          }),
          resident: (id) => (id === "resident" ? active : id === "idle" ? idle : null),
          interruptResident: (id) =>
            Effect.sync(() => {
              events.push(`resident:${id}`);
              return id === "resident" ? "resident-turn" : null;
            }),
          readLatestTurn: (id) =>
            Effect.sync(() => {
              events.push(`read:${id}`);
              return { id: `${id}-turn`, status: id === "cold" ? "inProgress" : "completed" };
            }),
          interruptTurn: (id, turnId) =>
            Effect.sync(() => events.push(`interrupt:${id}:${turnId}`)),
          warn: () => Effect.die("Unexpected warning"),
        });
        const discoveryIndex = events.indexOf("discover");
        assert.isTrue(events.indexOf("resident:resident") < discoveryIndex);
        assert.isTrue(events.indexOf("resident:idle") > discoveryIndex);
        assert.deepEqual(
          events.filter((event) => event.startsWith("read:")),
          ["read:idle", "read:cold", "read:finished"],
        );
        assert.deepEqual(
          events.filter((event) => event.startsWith("interrupt:")),
          ["interrupt:cold:cold-turn"],
        );
        assert.isFalse(events.some((event) => event.includes("unknown")));
        assert.deepEqual(result.interruptedThreadIds, ["resident", "cold"]);
        assert.isFalse(result.discoveryComplete);
      }),
  );

  it.effect("starts all known active child stops concurrently before waiting for discovery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        let running = 0;
        const rows = Array.from({ length: 4 }, (_, index) => ({
          threadId: `child-${index}`,
          active: true,
        }));
        const active = conversationFixture("child", [turnFixture("turn", "inProgress")]);
        const fiber = yield* interruptSubagentDescendants({
          known: Effect.succeed({ rows, complete: true }),
          discover: Effect.sync(() => {
            assert.strictEqual(running, 4);
            return { rows, complete: true };
          }),
          resident: () => active,
          interruptResident: (id) =>
            Effect.gen(function* () {
              running++;
              if (running === 4) yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return `${id}-turn`;
            }),
          readLatestTurn: () => Effect.die("Accepted resident stops must not be read again"),
          interruptTurn: () => Effect.die("Accepted resident stops must not be interrupted again"),
          warn: () => Effect.die("Unexpected warning"),
        }).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* Deferred.succeed(release, undefined);
        assert.strictEqual((yield* Fiber.join(fiber)).interruptedThreadIds.length, 4);
      }),
    ),
  );

  it.effect("retains known child stop success when discovery fails", () =>
    Effect.gen(function* () {
      const warnings: unknown[] = [];
      const failure = new CodexSubagentDirectoryError({
        operation: "discover",
        rootThreadId: "root",
        cause: new Error("discovery unavailable"),
      });
      const result = yield* interruptSubagentDescendants({
        known: Effect.succeed({ rows: [{ threadId: "child", active: true }], complete: true }),
        discover: Effect.fail(failure),
        resident: () => conversationFixture("child", [turnFixture("turn", "inProgress")]),
        interruptResident: () => Effect.succeed("turn"),
        readLatestTurn: () => Effect.die("No second phase after discovery failure"),
        interruptTurn: () => Effect.die("No second phase after discovery failure"),
        warn: (id, cause) =>
          Effect.sync(() => {
            warnings.push([id, cause]);
          }),
      });
      assert.deepEqual(result.interruptedThreadIds, ["child"]);
      assert.isFalse(result.discoveryComplete);
      assert.deepEqual(warnings, [[null, failure]]);
    }),
  );

  it.effect("does not fallback-interrupt an old metadata child absent from fresh discovery", () =>
    Effect.gen(function* () {
      const result = yield* interruptSubagentDescendants({
        known: Effect.succeed({ rows: [{ threadId: "old-child", active: true }], complete: true }),
        discover: Effect.succeed({ rows: [], complete: true }),
        resident: () => null,
        interruptResident: () => Effect.succeed(null),
        readLatestTurn: () => Effect.die("An absent nonresident child is not a current candidate"),
        interruptTurn: () => Effect.die("An absent nonresident child must not be interrupted"),
        warn: () => Effect.die("Unexpected warning"),
      });
      assert.deepEqual(result.interruptedThreadIds, []);
    }),
  );

  it.effect("warns on failed children without rejecting other native interruptions", () =>
    Effect.gen(function* () {
      const warnings: Array<string | null> = [];
      const interrupted: string[] = [];
      const result = yield* interruptSubagentDescendants({
        known: Effect.succeed({ rows: [], complete: false }),
        discover: Effect.succeed({
          rows: ["failed", "healthy"].map((threadId) => ({ threadId, active: true })),
          complete: true,
        }),
        resident: () => null,
        interruptResident: () => Effect.succeed(null),
        readLatestTurn: (id) =>
          id === "failed"
            ? Effect.fail(
                new CodexSubagentDirectoryError({
                  operation: "lifecycle",
                  rootThreadId: "root",
                  cause: new Error("read denied"),
                }),
              )
            : Effect.succeed({ id: "turn", status: "inProgress" }),
        interruptTurn: (id) =>
          Effect.sync(() => {
            interrupted.push(id);
          }),
        warn: (id) =>
          Effect.sync(() => {
            warnings.push(id);
          }),
      });
      assert.deepEqual(interrupted, ["healthy"]);
      assert.deepEqual(warnings, ["failed"]);
      assert.deepEqual(
        result.failed.map((failure) => failure.threadId),
        ["failed"],
      );
      assert.deepEqual(result.unresolvedThreadIds, []);
    }),
  );
});

describe("CodexSubagentDirectoryProjection", () => {
  const thread: CoreSubagentOverviewThreadLike = {
    thread_id: "child",
    parent_thread_id: "root",
    thread_preview: "Stored preview",
    agent_nickname: "@Scout",
    agent_role: "explorer",
    archived: false,
    created_at: 80,
    updated_at: 120,
    recency_at: 100,
    status: { status_type: "notLoaded" },
  };
  function overview(
    threads: CoreSubagentOverviewThreadLike[],
    complete = true,
  ): CoreSubagentOverviewLike {
    return {
      universe: { generation: 7, root_thread_id: "root" },
      active: { items: threads.map((thread) => ({ thread, status: "unknown" })) },
      done: { items: [] },
      known_active_count: threads.length,
      known_done_count: 0,
      discovery_complete: complete,
      projection_revision: 42,
    };
  }
  describe("subagent overview shared projection", () => {
    test("regroups runtime-notLoaded metadata into done and omits unnamed or archived rows", () => {
      const result = projectCodexSubagentOverviewWindow(
        overview([
          thread,
          { ...thread, thread_id: "unnamed", agent_nickname: null },
          { ...thread, thread_id: "archived", archived: true },
        ]),
      );
      expect(result.active.rows).toEqual([]);
      expect(result.done).toMatchObject({ knownCount: 1, totalCount: 1 });
      expect(result.done.rows[0]).toMatchObject({
        displayName: "Scout",
        status: "done",
        canInteract: false,
        canOpen: true,
        spawnModel: null,
      });
    });
    test("resident runtime overrides stored evidence and never leaks an answer body", () => {
      const result = projectCodexSubagentOverviewWindow(overview([thread]), () => false, {
        parentTurns: [],
        knownConversationsById: {
          child: {
            turns: [],
            threadRuntimeStatus: { type: "active", activeFlags: ["waitingOnApproval"] },
          },
        },
      });
      expect(result.active.rows[0]).toMatchObject({ status: "active", startedAtMs: 80 });
      expect(result.active.rows[0]).not.toHaveProperty("lastAssistantMessage");
      expect(result.active.rows[0]).not.toHaveProperty("turns");
    });
    test("incomplete discovery preserves a lower-bound total and uses active fallback only without runtime", () => {
      const result = projectCodexSubagentOverviewWindow(
        overview([{ ...thread, status: undefined }], false),
      );
      expect(result.active).toMatchObject({ knownCount: 1, totalCount: null });
      expect(result.active.rows[0]?.status).toBe("active");
    });
    test("runtime system error hides identity independently of durable done evidence", () => {
      const result = projectCodexSubagentOverviewWindow(
        overview([{ ...thread, status: { status_type: "systemError" } }]),
      );
      expect(result.active.rows).toEqual([]);
      expect(result.done.rows).toEqual([]);
    });
    test("source order prefers cached descendants while display sections sort recency", () => {
      const old = { ...thread, thread_id: "old", created_at: 1, recency_at: 1, updated_at: 1 };
      const recent = {
        ...thread,
        thread_id: "recent",
        created_at: 10,
        recency_at: 10,
        updated_at: 10,
      };
      const result = projectCodexSubagentOverviewWindow(overview([recent, old]), () => false, {
        parentTurns: [],
        knownConversationsById: { old: { turns: [] } },
        cachedConversationIds: ["old"],
        sourceLinkedThreadIds: ["recent", "old"],
      });
      expect(result.rows?.map((row) => row.threadId)).toEqual(["old", "recent"]);
      expect(result.done.rows.map((row) => row.threadId)).toEqual(["recent", "old"]);
    });
    test("conversation titles never replace agent nicknames or name an unnamed source child", () => {
      const result = projectCodexSubagentOverviewWindow(
        overview([
          { ...thread, thread_name: "Custom title" },
          { ...thread, thread_id: "unnamed", thread_name: "Another title", agent_nickname: null },
        ]),
      );
      expect(result.rows?.map((row) => row.displayName)).toEqual(["Scout", ""]);
      expect(result.done.rows.map((row) => row.threadId)).toEqual(["child"]);
    });
  });
});
