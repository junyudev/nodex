import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { make, type AppToolInvocation } from "./AppToolInvocationInbox";

const invocation: AppToolInvocation = {
  caller: {
    threadId: "thread",
    turnId: "turn",
    callId: "call",
    hostId: "local",
    generation: 1,
    isActive: () => true,
  },
  name: "context",
  arguments: {},
};

it.effect("returns the semantic result and prevents duplicate interpretation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const inbox = yield* make;
      let executions = 0;
      yield* inbox.invocations.pipe(
        Stream.runForEach((ticket) =>
          Effect.gen(function* () {
            const operation = () =>
              Effect.sync(() => {
                executions += 1;
                return { content: [{ type: "text" as const, text: "context" }] };
              });
            yield* inbox.interpret(ticket, operation);
            yield* inbox.interpret(ticket, operation);
          }),
        ),
        Effect.forkChild,
      );
      assert.deepStrictEqual(yield* inbox.invoke(invocation), {
        content: [{ type: "text", text: "context" }],
      });
      assert.strictEqual(executions, 1);
    }),
  ),
);

it.effect("withdraws active semantic work when its caller is interrupted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const inbox = yield* make;
      const started = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      yield* inbox.invocations.pipe(
        Stream.runForEach((ticket) =>
          inbox.interpret(ticket, () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(stopped, undefined)),
            ),
          ),
        ),
        Effect.forkChild,
      );
      const call = yield* inbox.invoke(invocation).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(call);
      yield* Deferred.await(stopped);
    }),
  ),
);

it.effect("settles a defective interpreter and continues serving later calls", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const inbox = yield* make;
      let executions = 0;
      yield* inbox.invocations.pipe(
        Stream.runForEach((ticket) =>
          inbox.interpret(ticket, () =>
            Effect.sync(() => {
              executions += 1;
              if (executions === 1) throw new Error("unexpected implementation failure");
              return { content: [{ type: "text" as const, text: "recovered" }] };
            }),
          ),
        ),
        Effect.forkChild,
      );
      const failed = yield* inbox.invoke(invocation);
      assert.strictEqual(failed.isError, true);
      assert.deepStrictEqual(failed.structuredContent, {
        error: { code: "tool_execution_failed" },
      });
      assert.deepStrictEqual((yield* inbox.invoke(invocation)).content, [
        { type: "text", text: "recovered" },
      ]);
    }),
  ),
);
