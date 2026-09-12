import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { assert, it } from "@effect/vitest";
import { makeCodexRendererRequestLifetimes } from "./CodexRendererRequestLifetimes";
import { CodexRendererResponseMetrics } from "./CodexHostRequestMetrics";
import { CodexRendererDispatchState } from "./CodexRendererRequestOrigin";

it.effect("retains the operation result after timeout abandonment without repeating dispatch", () =>
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
