import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { makeBinding, NativeConversationExtension } from "./NativeConversationExtension";

const service = NativeConversationExtension.of({
  read: () => Effect.succeed(null),
  submit: () => Effect.succeed({ turnId: "accepted" }),
  wait: () => Effect.never,
  cancel: () => Effect.void,
  createAutomationSession: () => Effect.succeed({ threadId: "created" }),
  validateAutomation: () => Effect.void,
});

it.effect("deferred extension accepts one complete owner and unblocks earlier requests", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const { extension, binding } = yield* makeBinding.pipe(Scope.provide(scope));
    const pending = yield* extension
      .submit({ threadId: "target", operationId: "message", prompt: "Hello" })
      .pipe(Effect.forkChild);
    yield* binding.bind(service);
    assert.deepEqual(yield* Fiber.join(pending), { turnId: "accepted" });
    const duplicate = yield* Effect.flip(binding.bind(service));
    assert.equal(duplicate.reason, "already_bound");
    yield* Scope.close(scope, Exit.void);
    const closed = yield* Effect.flip(extension.read("target"));
    assert.equal((closed as { reason?: string }).reason, "closed");
  }),
);

it.effect(
  "shutdown revokes pending and active delegated operations without waiting for binding",
  () =>
    Effect.gen(function* () {
      for (const bind of [false, true]) {
        const scope = yield* Scope.make();
        const { extension, binding } = yield* makeBinding.pipe(Scope.provide(scope));
        if (bind) yield* binding.bind(service);
        const pending = yield* extension.wait("target", "turn").pipe(Effect.flip, Effect.forkChild);
        yield* Scope.close(scope, Exit.void);
        const failure = yield* Fiber.join(pending);
        assert.equal((failure as { reason?: string }).reason, "closed");
      }
    }),
);
