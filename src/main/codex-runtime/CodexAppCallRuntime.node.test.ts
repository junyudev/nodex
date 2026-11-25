import { describe, expect, test } from "vite-plus/test";
import type { ItemStartedNotification } from "@nodex/codex-app-server-protocol/v2/ItemStartedNotification";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { make } from "./CodexAppCallRuntime";
import { it as itcodexappcalladmission } from "vitest";
import { createCodexAppCallAdmission } from "./codex-app-call-admission";
import type { MainTraceSpanOptions } from "../observability/sentry-main";
import type { CodexRequestTraceContext } from "../../shared/codex-request-lifecycle";
import { makeCodexRequestTraceCoordinator } from "./CodexRequestTraceCoordinator";
import { codexAppServerResponseErrorTraceAttributes } from "./CodexAppServerTraceAttributes";
import { makeCodexRendererRequestLifetimes } from "./CodexRendererRequestLifetimes";
import { CodexRendererResponseMetrics } from "./CodexHostRequestMetrics";
import { CodexRendererDispatchState } from "./CodexRendererRequestOrigin";

describe("CodexAppCallRuntime", () => {
  describe("CodexAppCallRuntime", () => {
    const event = (id = "call-1"): ItemStartedNotification => ({
      threadId: "thread-1",
      turnId: "turn-1",
      startedAtMs: 1,
      item: {
        type: "mcpToolCall",
        environmentId: null,
        id,
        server: "nodex_app",
        tool: "read_page",
        status: "inProgress",
        arguments: { pageId: "page-1" },
        appContext: null,
        mcpAppUi: null,
        pluginId: null,
        readOnlyHint: true,
        result: null,
        error: null,
        durationMs: null,
      },
    });
    const request = () => ({
      name: "read_page",
      arguments: { pageId: "page-1" },
      metadata: {
        callId: "call-1",
        "x-codex-turn-metadata": { thread_id: "thread-1", turn_id: "turn-1" },
      },
    });

    it.effect("waits for native observation before executing a raced MCP request", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* make;
          let ran = false;
          const call = yield* runtime
            .run(request(), () =>
              Effect.sync(() => {
                ran = true;
                return 42;
              }),
            )
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          assert.isFalse(ran);
          yield* runtime.observe(event());
          assert.strictEqual(yield* Fiber.join(call), 42);
        }),
      ),
    );

    it.effect("rejects an unobserved call after a bounded wait without executing it", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* make;
          let ran = false;
          const call = yield* runtime
            .run(request(), () =>
              Effect.sync(() => {
                ran = true;
              }),
            )
            .pipe(Effect.flip, Effect.forkChild);
          yield* TestClock.adjust("2 seconds");
          assert.strictEqual((yield* Fiber.join(call)).reason, "unverified");
          assert.isFalse(ran);
        }),
      ),
    );

    for (const trigger of ["cancelled turn", "generation"] as const) {
      it.effect(`interrupts active work when its ${trigger} closes`, () =>
        Effect.scoped(
          Effect.gen(function* () {
            const scope = yield* Scope.make();
            const runtime = yield* make.pipe(Effect.provideService(Scope.Scope, scope));
            yield* runtime.observe(event());
            const started = yield* Deferred.make<void>();
            const stopped = yield* Deferred.make<void>();
            const call = yield* runtime
              .run(request(), () =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(Deferred.succeed(stopped, undefined)),
                ),
              )
              .pipe(Effect.flip, Effect.forkChild);
            yield* Deferred.await(started);
            if (trigger === "cancelled turn") yield* runtime.cancelTurn("thread-1", "turn-1");
            else yield* Scope.close(scope, Exit.void);
            assert.strictEqual((yield* Fiber.join(call)).reason, "revoked");
            yield* Deferred.await(stopped);
            yield* Scope.close(scope, Exit.void);
          }),
        ),
      );
    }
  });

  describe("codex-app-call-admission", () => {
    const it = itcodexappcalladmission;
    const event = (id = "call-1"): ItemStartedNotification => ({
      threadId: "thread-1",
      turnId: "turn-1",
      startedAtMs: 1,
      item: {
        type: "mcpToolCall",
        environmentId: null,
        id,
        server: "nodex_app",
        tool: "read_page",
        status: "inProgress",
        arguments: { pageId: "page-1" },
        appContext: null,
        mcpAppUi: null,
        pluginId: null,
        readOnlyHint: true,
        result: null,
        error: null,
        durationMs: null,
      },
    });
    const request = () => ({
      name: "read_page",
      arguments: { pageId: "page-1" },
      metadata: {
        callId: "call-1",
        "x-codex-turn-metadata": { thread_id: "thread-1", turn_id: "turn-1" },
      },
    });
    const ready = () => {
      const ledger = createCodexAppCallAdmission();
      ledger.observe(event());
      return ledger;
    };

    describe("native MCP invocation admission", () => {
      it("requires trusted observation and exact caller, tool and arguments", () => {
        const ledger = createCodexAppCallAdmission();
        expect(ledger.claim(request())).toBeNull();
        expect(ledger.observe(event())).toBe(true);
        expect(ledger.claim({ ...request(), name: "delete_page" })).toBeNull();
        expect(ledger.claim({ ...request(), arguments: { pageId: "page-2" } })).toBeNull();
        const forged = request();
        forged.metadata["x-codex-turn-metadata"].thread_id = "other-thread";
        expect(ledger.claim(forged)).toBeNull();
        expect(ledger.claim(request())?.isActive()).toBe(true);
      });

      it("does not admit a call twice even after duplicate protocol delivery", () => {
        const ledger = ready();
        expect(ledger.claim(request())).not.toBeNull();
        expect(ledger.observe(event())).toBe(false);
        expect(ledger.claim(request())).toBeNull();
      });

      it.each(["complete", "cancel", "close"])("revokes the exact call on %s", (action) => {
        const ledger = ready();
        const claim = ledger.claim(request());
        expect(claim?.isActive()).toBe(true);
        if (action === "complete") ledger.completeCall("thread-1", "turn-1", "call-1");
        if (action === "cancel") ledger.cancelTurn("thread-1", "turn-1");
        if (action === "close") ledger.close();
        expect(claim?.isActive()).toBe(false);
        expect(ledger.claim(request())).toBeNull();
        if (action === "cancel") expect(ledger.observe(event("late-call"))).toBe(false);
      });

      it("retains original background calls and distinguishes reused call IDs by native Turn", () => {
        const ledger = ready();
        const first = ledger.claim(request());
        expect(ledger.observe({ ...event(), turnId: "turn-2" })).toBe(true);
        const second = ledger.claim({
          ...request(),
          metadata: {
            callId: "call-1",
            "x-codex-turn-metadata": { thread_id: "thread-1", turn_id: "turn-2" },
          },
        });
        expect(first?.turnId).toBe("turn-1");
        expect(second?.turnId).toBe("turn-2");
        expect(first?.isActive()).toBe(true);
        ledger.completeCall("thread-1", "turn-2", "call-1");
        expect(first?.isActive()).toBe(true);
        expect(second?.isActive()).toBe(false);
        ledger.close();
        expect(first?.isActive()).toBe(false);
      });

      it("releases completed bodies and fails closed on count, byte and cancellation overflow", () => {
        const ledger = createCodexAppCallAdmission(1);
        expect(ledger.observe(event())).toBe(true);
        const first = ledger.claim(request());
        ledger.completeCall("thread-1", "turn-1", "call-1");
        expect(first?.isActive()).toBe(false);
        expect(ledger.observe(event("call-2"))).toBe(true);
        expect(ledger.observe(event("call-3"))).toBe(false);
        expect(ledger.overflowed).toBe(true);
        expect(createCodexAppCallAdmission().claim(request())).toBeNull();
        const bytes = createCodexAppCallAdmission();
        const oversized = event();
        if (oversized.item.type !== "mcpToolCall") throw new Error("Expected MCP call");
        oversized.item.arguments = { text: "x".repeat(4 * 1024 * 1024) };
        expect(bytes.observe(oversized)).toBe(false);
        expect(bytes.overflowed).toBe(true);
        const cancelled = createCodexAppCallAdmission(1);
        cancelled.cancelTurn("thread-1", "turn-1");
        cancelled.cancelTurn("thread-1", "turn-2");
        expect(cancelled.overflowed).toBe(true);
        expect(cancelled.observe(event())).toBe(false);
      });
    });
  });
});

describe("CodexRequestTraceCoordinator", () => {
  describe("CodexRequestTraceCoordinator", () => {
    const TRACE = {
      traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    };

    describe("CodexRequestTraceCoordinator", () => {
      test("moves a settled turn from parent delivery to linked delivery and deduplicates methods", () => {
        let now = 1_000;
        const coordinator = makeCodexRequestTraceCoordinator({ now: () => now });
        coordinator.trackRequest({
          method: "turn/start",
          requestId: "turn-1",
          threadId: "thread-1",
          trace: TRACE,
          webContentsId: 7,
        });

        const before = coordinator.takeNotificationDelivery("thread-1", "turn/started", 1_010);
        expect(before?.recipients.get(7)).toEqual({ link: false, trace: TRACE });
        expect(
          coordinator.takeNotificationDelivery("thread-1", "turn/started", 1_011),
        ).toBeUndefined();

        coordinator.settleRequest("thread-1", 7, "turn-1", true);
        now = 1_020;
        const after = coordinator.takeNotificationDelivery("thread-1", "item/started", 1_020);
        expect(after?.recipients.get(7)).toEqual({ link: true, trace: TRACE });
      });

      test("binds the only pending thread start from thread/started", () => {
        const coordinator = makeCodexRequestTraceCoordinator({ now: () => 5_000 });
        coordinator.trackRequest({
          method: "thread/start",
          requestId: "start-1",
          trace: TRACE,
          webContentsId: 9,
        });

        const delivery = coordinator.takeNotificationDelivery(
          "thread-new",
          "thread/started",
          5_010,
        );
        expect(delivery?.recipients.get(9)).toEqual({ link: false, trace: TRACE });
        coordinator.settleRequest("thread-new", 9, "start-1", true);
        expect(
          coordinator
            .takeNotificationDelivery("thread-new", "item/started", 5_020)
            ?.recipients.get(9),
        ).toEqual({ link: true, trace: TRACE });
      });

      test("resets app discovery delivery after a successful response", () => {
        const coordinator = makeCodexRequestTraceCoordinator({ now: () => 10_000 });
        coordinator.trackRequest({
          method: "app/list",
          requestId: "apps-1",
          trace: TRACE,
          webContentsId: 3,
        });
        expect(
          coordinator.takeNotificationDelivery(null, "app/list/updated", 10_010)?.recipients.get(3),
        ).toEqual({ link: false, trace: TRACE });
        expect(
          coordinator.takeNotificationDelivery(null, "app/list/updated", 10_011),
        ).toBeUndefined();
        coordinator.settleRequest(null, 3, "apps-1", true);
        expect(
          coordinator.takeNotificationDelivery(null, "app/list/updated", 10_012)?.recipients.get(3),
        ).toEqual({ link: true, trace: TRACE });
      });

      test("records a bounded streaming window and closes it on turn completion", () => {
        let now = 20_000;
        const spans: MainTraceSpanOptions[] = [];
        const runSpan = <A>(
          options: MainTraceSpanOptions,
          callback: (trace: CodexRequestTraceContext | null) => A,
        ): A => {
          spans.push(options);
          return callback(options.trace ?? null);
        };
        const coordinator = makeCodexRequestTraceCoordinator({ now: () => now, runSpan });
        coordinator.trackRequest({
          method: "turn/start",
          requestId: "turn-2",
          threadId: "thread-2",
          trace: TRACE,
          webContentsId: 4,
        });
        coordinator.takeNotificationDelivery("thread-2", "turn/started", 20_100);
        now = 40_000;
        coordinator.takeNotificationDelivery("thread-2", "item/started", 40_000);
        coordinator.takeNotificationDelivery("thread-2", "turn/completed", 40_100);

        expect(spans).toEqual([
          expect.objectContaining({
            name: "app_server.streaming_window",
            startTimeMs: 20_100,
            endTimeMs: 35_100,
            attributes: expect.objectContaining({
              "app_server.notification_count": 1,
              "app_server.streaming_window_end": "window",
            }),
          }),
          expect.objectContaining({
            startTimeMs: 40_000,
            endTimeMs: 40_100,
            attributes: expect.objectContaining({
              "app_server.notification_count": 2,
              "app_server.streaming_window_end": "completed",
            }),
          }),
        ]);
      });
    });
  });

  describe("CodexAppServerTraceAttributes", () => {
    describe("codexAppServerResponseErrorTraceAttributes", () => {
      test("classifies known JSON-RPC failures", () => {
        expect(
          codexAppServerResponseErrorTraceAttributes({
            code: -32001,
            message: "thread not found: abc",
          }),
        ).toEqual({
          "app_server.error_code": -32001,
          "app_server.failure_reason": "thread_not_found",
        });
        expect(
          codexAppServerResponseErrorTraceAttributes({
            code: -32603,
            message: "Connection for host ID remote-1 not found",
          }),
        ).toEqual({
          "app_server.error_code": -32603,
          "app_server.failure_reason": "remote_unavailable",
        });
      });

      test("does not tag non JSON-RPC error codes", () => {
        expect(
          codexAppServerResponseErrorTraceAttributes({ code: 500, message: "Unauthorized" }),
        ).toEqual({});
      });
    });
  });
});

describe("CodexRendererRequestLifetimes", () => {
  it.effect(
    "retains the operation result after timeout abandonment without repeating dispatch",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const requests = yield* makeCodexRendererRequestLifetimes;
          const result = yield* Deferred.make<string>();
          let dispatched = 0;
          const pending = yield* requests.start(
            "window:request",
            true,
            Effect.sync(() => {
              dispatched++;
            }).pipe(Effect.andThen(Deferred.await(result))),
          );
          yield* requests.abandon("window:request");
          yield* requests.abandon("window:request");
          yield* Deferred.succeed(result, "late accepted result");
          assert.strictEqual(yield* Fiber.join(pending), "late accepted result");
          assert.strictEqual(dispatched, 1);
        }),
      ),
  );

  it.effect(
    "window closure cancels retained callers and ordinary timeout cancels ordinary callers",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const requests = yield* makeCodexRendererRequestLifetimes;
          const retained = yield* requests.start("window:retained", true, Effect.never);
          const ordinary = yield* requests.start("window:ordinary", false, Effect.never);
          yield* requests.abandon("window:ordinary");
          assert.isTrue(Exit.isFailure(yield* Fiber.await(ordinary)));
          yield* requests.close("window:retained");
          assert.isTrue(Exit.isFailure(yield* Fiber.await(retained)));
        }),
      ),
  );

  it.effect("keeps a physically dispatched request alive after renderer timeout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests = yield* makeCodexRendererRequestLifetimes;
        const result = yield* Deferred.make<string>();
        const responseState: { abandonmentReason?: "timeout" | "disposed" } = {};
        const pending = yield* requests
          .start("window:dispatched-timeout", false, Deferred.await(result))
          .pipe(
            Effect.provideService(CodexRendererDispatchState, { dispatched: true }),
            Effect.provideService(CodexRendererResponseMetrics, responseState),
          );

        yield* requests.abandon("window:dispatched-timeout");
        assert.strictEqual(responseState.abandonmentReason, "timeout");
        yield* Deferred.succeed(result, "late result");
        assert.strictEqual(yield* Fiber.join(pending), "late result");
      }),
    ),
  );

  it.effect("detaches a physically dispatched logical caller after its renderer closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests = yield* makeCodexRendererRequestLifetimes;
        const responseState: { abandonmentReason?: "timeout" | "disposed" } = {};
        const pending = yield* requests
          .start("window:dispatched-close", false, Effect.never)
          .pipe(
            Effect.provideService(CodexRendererDispatchState, { dispatched: true }),
            Effect.provideService(CodexRendererResponseMetrics, responseState),
          );

        yield* requests.closeRenderer("window:dispatched-close");
        assert.strictEqual(responseState.abandonmentReason, "disposed");
        assert.isTrue(Exit.isFailure(yield* Fiber.await(pending)));
      }),
    ),
  );

  it.effect("detaches a destroyed caller when another live renderer owns the coalesced reply", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests = yield* makeCodexRendererRequestLifetimes;
        const responseState: { abandonmentReason?: "timeout" | "disposed" } = {};
        const pending = yield* requests.start("window:coalesced-close", false, Effect.never).pipe(
          Effect.provideService(CodexRendererDispatchState, {
            dispatched: true,
          }),
          Effect.provideService(CodexRendererResponseMetrics, responseState),
        );

        yield* requests.closeRenderer("window:coalesced-close");

        assert.strictEqual(responseState.abandonmentReason, "disposed");
        assert.isTrue(Exit.isFailure(yield* Fiber.await(pending)));
      }),
    ),
  );

  it.effect("detaches source-owned timeout lifetimes after physical dispatch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests = yield* makeCodexRendererRequestLifetimes;
        const timedOut = yield* requests.start("window:timeout-detach", false, Effect.never).pipe(
          Effect.provideService(CodexRendererDispatchState, {
            dispatched: true,
            detachOnTimeout: true,
          }),
        );
        yield* requests.abandon("window:timeout-detach");

        assert.isTrue(Exit.isFailure(yield* Fiber.await(timedOut)));
      }),
    ),
  );

  it.effect("detaches a timed-out coalesced follower while keeping its physical leader alive", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests = yield* makeCodexRendererRequestLifetimes;
        const pending = yield* requests.start("window:follower-timeout", false, Effect.never).pipe(
          Effect.provideService(CodexRendererDispatchState, {
            dispatched: true,
            isCoalescedFollower: true,
          }),
        );

        yield* requests.abandon("window:follower-timeout");

        assert.isTrue(Exit.isFailure(yield* Fiber.await(pending)));
      }),
    ),
  );
});
