import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import type { ThreadItemEntry } from "@nodex/codex-app-server-protocol/v2";
import { CoreModuleResponseError } from "../core-client/core-client";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { CoreModules } from "../core-runtime/CoreModules";
import { makeTargetFixture, targetThread } from "./CodexThreadTargets.test-support";

const missing = () =>
  coreRuntimeError({
    operation: "workspace.read",
    reason: "operation",
    retryable: false,
    cause: new CoreModuleResponseError({
      code: "not_found",
      message: "Missing Thread",
      retryable: false,
      recovery: { kind: "none" },
    }),
  });
const emptyCore = CoreModules.of({
  workspace: {
    read: () => Effect.fail(missing()),
    apply: () => Effect.die("Readonly summary cannot write Core"),
  },
} as unknown as CoreModules["Service"]);
const item = (
  text: string,
  phase: "commentary" | "final_answer",
  delivery: "async" | null = null,
): ThreadItemEntry => ({
  turnId: "turn",
  startedAtMs: 1,
  completedAtMs: 2,
  item: {
    type: "agentMessage",
    id: text,
    text,
    phase,
    delivery,
    memoryCitation: null,
    questions: null,
  },
});

it.effect(
  "reads exactly one metadata header and one bounded descending item page without installing history",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeTargetFixture({
        core: emptyCore,
        request: (_host, method) =>
          Effect.succeed(
            method === "thread/read"
              ? { thread: targetThread("child") }
              : {
                  data: [
                    item("commentary", "commentary"),
                    item("**hel**lo [a](https://x)bc", "final_answer"),
                  ],
                  nextCursor: "must-not-follow",
                },
          ) as never,
      });
      const result = yield* fixture.service.readSummary({ hostId: "ssh:owner", threadId: "child" });
      assert.deepStrictEqual(result, {
        hostId: "ssh:owner",
        threadId: "child",
        title: "Created chat",
        status: { type: "idle" },
        latestReply: "hello abc",
      });
      assert.deepStrictEqual(
        fixture.requests.map((request) => [request.method, request.params]),
        [
          ["thread/read", { threadId: "child", includeTurns: false }],
          ["thread/items/list", { threadId: "child", limit: 100, sortDirection: "desc" }],
        ],
      );
      assert.strictEqual(fixture.listeners(), 0);
    }),
);

for (const retire of ["reset", "dispose"] as const)
  it.effect(
    `cancels an in-flight header when its physical source ${retire}s and releases observers`,
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        let interrupted = false;
        const fixture = yield* makeTargetFixture({
          core: emptyCore,
          request: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted = true;
                }),
              ),
            ) as never,
        });
        const fiber = yield* fixture.service
          .readSummary({ hostId: "ssh:owner", threadId: "child" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        fixture[retire]();
        assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)));
        assert.isTrue(interrupted);
        assert.strictEqual(fixture.listeners(), 0);
        assert.strictEqual(fixture.requests.length, 1);
      }),
  );

it.effect(
  "caller cancellation releases the read and late retirement cannot cancel a new attempt",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let interrupted = false;
      let suspended = true;
      const fixture = yield* makeTargetFixture({
        core: emptyCore,
        request: (_host, method) => {
          if (!suspended)
            return Effect.succeed(
              method === "thread/read"
                ? { thread: targetThread("child") }
                : { data: [], nextCursor: null },
            ) as never;
          return Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
          ) as never;
        },
      });
      const fiber = yield* fixture.service
        .readSummary({ hostId: "ssh:owner", threadId: "child" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const lateCallbacks = fixture.retirementCallbacks();
      assert.strictEqual(lateCallbacks.length, 2);
      yield* Fiber.interrupt(fiber);
      assert.isTrue(interrupted);
      assert.strictEqual(fixture.listeners(), 0);
      suspended = false;
      for (const callback of lateCallbacks) callback();
      const result = yield* fixture.service.readSummary({ hostId: "ssh:owner", threadId: "child" });
      assert.strictEqual(result.threadId, "child");
      assert.strictEqual(fixture.listeners(), 0);
      assert.strictEqual(fixture.requests.length, 3);
    }),
);

it.effect(
  "rejects an unavailable explicit host without creating a manager or issuing native reads",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeTargetFixture({ core: emptyCore });
      assert.isTrue(
        Exit.isFailure(
          yield* fixture.service
            .readSummary({ hostId: "foreign", threadId: "child" })
            .pipe(Effect.exit),
        ),
      );
      assert.strictEqual(fixture.requests.length, 0);
    }),
);

it.effect("rejects a non-metadata header before requesting items", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTargetFixture({
      core: emptyCore,
      request: () =>
        Effect.succeed({ thread: { ...targetThread("wrong-child"), turns: [] } }) as never,
    });
    assert.isTrue(
      Exit.isFailure(
        yield* fixture.service
          .readSummary({ hostId: "ssh:owner", threadId: "child" })
          .pipe(Effect.exit),
      ),
    );
    assert.strictEqual(fixture.requests.length, 1);
  }),
);
