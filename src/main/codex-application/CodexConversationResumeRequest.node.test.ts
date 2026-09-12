import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import type { CodexGateway, CodexGatewayRequestOptions } from "../codex-runtime/CodexGateway";
import { codexRuntimeError, type CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { requestMainConversationResume } from "./CodexConversationResumeRequest";

type ThreadResumeParams = ClientRequestParamsByMethod["thread/resume"];
const params: ThreadResumeParams = { threadId: "thread", excludeTurns: true };
const response = { thread: { id: "thread" } } as ClientRequestResponsesByMethod["thread/resume"];
const failure = (reason: "timeout" | "request" | "session-lost", message: string) =>
  codexRuntimeError({
    operation: "request",
    method: "thread/resume",
    reason,
    retryable: true,
    cause: new Error(message),
  });
const closing = () =>
  failure("request", "thread thread is closing; retry thread/resume after the thread is closed");

function fixture(errors: readonly CodexRuntimeError[], options: CodexGatewayRequestOptions = {}) {
  const attempts: Array<{
    at: number;
    options: CodexGatewayRequestOptions | undefined;
    params: ThreadResumeParams;
  }> = [];
  const gateway = {
    requestOnHost: (
      _hostId: string,
      _method: string,
      request: ThreadResumeParams,
      scheduling?: CodexGatewayRequestOptions,
    ) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        const error = errors[attempts.length];
        attempts.push({ at, options: scheduling, params: request });
        if (error) return yield* Effect.fail(error);
        return response;
      }),
  } as Pick<CodexGateway["Service"], "requestOnHost">;
  return {
    attempts,
    send: requestMainConversationResume(gateway, "remote", params, {
      expectedHostId: "remote",
      expectedGeneration: 7,
      ...options,
    }),
  };
}

it.effect(
  "Main retries closing responses with the same immutable request and generation fence",
  () =>
    Effect.gen(function* () {
      const f = fixture([closing(), closing(), closing(), closing()]);
      const fiber = yield* f.send.pipe(Effect.forkChild);
      yield* TestClock.adjust(750 + 1500 + 3000 + 6000);
      assert.strictEqual(yield* Fiber.join(fiber), response);
      assert.deepEqual(
        f.attempts.map(({ at }) => at - f.attempts[0]!.at),
        [0, 750, 2250, 5250, 11250],
      );
      for (const attempt of f.attempts) {
        assert.strictEqual(attempt.params, params);
        assert.deepEqual(attempt.options, {
          expectedHostId: "remote",
          expectedGeneration: 7,
          timeoutMs: 120_000,
        });
      }
    }),
);

it.effect("Main expands only default timeout attempts and retains the final failure", () =>
  Effect.gen(function* () {
    const errors = [
      failure("timeout", "request deadline"),
      failure("timeout", "request deadline"),
      failure("timeout", "last deadline"),
    ];
    const f = fixture(errors);
    const fiber = yield* f.send.pipe(Effect.result, Effect.forkChild);
    yield* TestClock.adjust(1500);
    const result = yield* Fiber.join(fiber);
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") assert.strictEqual(result.failure, errors[2]);
    assert.deepEqual(
      f.attempts.map(({ options }) => options?.timeoutMs),
      [120_000, 240_000, 480_000],
    );
  }),
);

it.effect("Main does not retry an explicit timeout or endpoint retirement", () =>
  Effect.gen(function* () {
    for (const error of [
      failure("timeout", "deadline"),
      failure("session-lost", "endpoint retired"),
    ]) {
      const f = fixture([error], { timeoutMs: 30_000 });
      const result = yield* f.send.pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(f.attempts.length, 1);
      assert.strictEqual(f.attempts[0]!.options?.timeoutMs, 30_000);
    }
  }),
);

it.effect("closing the Main consumer Scope interrupts backoff before another native dispatch", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const f = fixture([closing()]);
    const fiber = yield* f.send.pipe(Effect.forkIn(scope, { startImmediately: true }));
    yield* TestClock.adjust(749);
    assert.strictEqual(f.attempts.length, 1);
    yield* Scope.close(scope, Exit.void);
    assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)));
    yield* TestClock.adjust(30_000);
    assert.strictEqual(f.attempts.length, 1);
  }),
);
