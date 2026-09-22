import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { CodexExecutionHostAuthState, live } from "./CodexExecutionHostAuthState";

it.effect("reuses host leases until mutation and revokes all leases with the owner Scope", () =>
  Effect.gen(function* () {
    const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    const context = yield* Layer.build(live).pipe(Scope.provide(scope));
    const state = Context.get(context, CodexExecutionHostAuthState);
    const first = yield* state.backendLease("local");
    const remote = yield* state.backendLease("remote");
    assert.strictEqual(yield* state.backendLease("local"), first);
    yield* state.withAccountMutation("local", "account/logout", Effect.void);
    assert.isTrue(first.aborted);
    assert.isFalse(remote.aborted);
    const next = yield* state.backendLease("local");
    assert.notStrictEqual(next, first);
    assert.isFalse(next.aborted);
    yield* Scope.close(scope, Exit.void);
    assert.isTrue(next.aborted);
    assert.isTrue(remote.aborted);
  }).pipe(Effect.scoped),
);

it.effect(
  "waits for every overlapping mutation and releases admission after failure or interruption",
  () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(live);
      const state = Context.get(context, CodexExecutionHostAuthState);
      const previous = yield* state.backendLease("local");
      const firstStarted = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const finishFirst = yield* Deferred.make<void>();
      const first = yield* state
        .withAccountMutation(
          "local",
          "account/sessions/switch",
          Deferred.succeed(firstStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishFirst)),
            Effect.andThen(Effect.fail("refused")),
          ),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(firstStarted);
      assert.isTrue(previous.aborted);
      const second = yield* state
        .withAccountMutation(
          "local",
          "account/sessions/add",
          Deferred.succeed(secondStarted, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(secondStarted);
      let admitted = false;
      const waiting = yield* state.backendLease("local").pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            admitted = true;
          }),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.succeed(finishFirst, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.await(first)));
      yield* Effect.yieldNow;
      assert.isFalse(admitted);
      yield* Fiber.interrupt(second);
      const next = yield* Fiber.join(waiting);
      assert.isTrue(admitted);
      assert.isFalse(next.aborted);
    }).pipe(Effect.scoped),
);
