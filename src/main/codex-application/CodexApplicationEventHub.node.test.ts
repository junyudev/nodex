import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { make } from "./CodexApplicationEventHub";

it.effect("fans out ordered application events and closes them with the Main Scope", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const events = yield* make.pipe(Effect.provideService(Scope.Scope, scope));
    const collectTwo = events.events.pipe(Stream.take(2), Stream.runCollect);
    const first = yield* Effect.forkIn(collectTwo, scope);
    const second = yield* Effect.forkIn(collectTwo, scope);
    yield* Effect.yieldNow;

    events.publish({ kind: "pendingWorktreesChanged", value: [] });
    events.publish({ kind: "conversationSeen", value: "thread-1" });

    const expectedKinds = ["pendingWorktreesChanged", "conversationSeen"];
    assert.deepEqual(
      (yield* Fiber.join(first)).map((event) => event.kind),
      expectedKinds,
    );
    assert.deepEqual(
      (yield* Fiber.join(second)).map((event) => event.kind),
      expectedKinds,
    );

    yield* Scope.close(scope, Exit.void);
    events.publish({ kind: "conversationSeen", value: "ignored" });
    assert.deepEqual(yield* Stream.runCollect(events.events), []);
  }),
);
