import { EventEmitter } from "node:events";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { layer as callbacksLayer, ScopedCallbackRuntime } from "../../app/ScopedCallbackRuntime";
import { makeCodexRendererRequestLifetimes } from "../../codex-runtime/CodexRendererRequestLifetimes";
import {
  WebContentsDestructionSubscriptions,
  makeWebContentsDestructionSubscriptions,
} from "./WebContentsDestructionSubscriptions";

const createSource = () => {
  let destroyed = false;
  const events = new EventEmitter();
  return Object.assign(events, {
    isDestroyed: () => destroyed,
    destroy() {
      destroyed = true;
      events.emit("destroyed");
    },
  });
};

it.effect(
  "bounds concurrent operations to one listener and releases it after the last operation",
  () =>
    Effect.gen(function* () {
      const subscriptions = yield* makeWebContentsDestructionSubscriptions;
      const source = createSource();
      const existing = () => {};
      for (let index = 0; index < 9; index++) source.on("destroyed", existing);
      let cancelled = 0;
      const releases = Array.from({ length: 32 }, () =>
        subscriptions.subscribe(source, () => cancelled++),
      );

      assert.strictEqual(source.listenerCount("destroyed"), 10);
      for (const release of releases.slice(0, -1)) release();
      assert.strictEqual(source.listenerCount("destroyed"), 10);
      releases.at(-1)!();
      releases.at(-1)!();
      assert.strictEqual(source.listenerCount("destroyed"), 9);
      source.destroy();
      assert.strictEqual(cancelled, 0);
    }),
);

it.effect(
  "destroying a renderer cancels all its pending requests and preserves another renderer",
  () =>
    Effect.gen(function* () {
      const subscriptions = yield* makeWebContentsDestructionSubscriptions;
      const requests = yield* makeCodexRendererRequestLifetimes;
      const callbacks = Context.get(yield* Layer.build(callbacksLayer), ScopedCallbackRuntime);
      const source = createSource();
      const survivor = createSource();
      const reasons: string[] = [];
      const pending = yield* Effect.forEach(
        Array.from({ length: 16 }, (_, index) => index),
        (index) =>
          Effect.gen(function* () {
            const key = `window:${index}`;
            const fiber = yield* requests.start(key, true, Effect.never, (reason) =>
              reasons.push(reason),
            );
            subscriptions.subscribe(source, () => callbacks.fork(requests.closeRenderer(key)));
            return fiber;
          }),
      );
      const result = yield* Deferred.make<string>();
      const other = yield* requests.start("other:request", true, Deferred.await(result));
      const releaseOther = subscriptions.subscribe(survivor, () =>
        callbacks.fork(requests.closeRenderer("other:request")),
      );

      assert.strictEqual(source.listenerCount("destroyed"), 1);
      source.destroy();
      const exits = yield* Effect.forEach(pending, Fiber.await);
      assert.isTrue(exits.every(Exit.isFailure));
      assert.deepEqual(
        reasons,
        Array.from({ length: 16 }, () => "disposed"),
      );
      assert.strictEqual(source.listenerCount("destroyed"), 0);
      assert.strictEqual(survivor.listenerCount("destroyed"), 1);
      yield* Deferred.succeed(result, "still connected");
      assert.strictEqual(yield* Fiber.join(other), "still connected");
      releaseOther();
      assert.strictEqual(survivor.listenerCount("destroyed"), 0);
    }),
);

it.effect(
  "notifies each subscription once even when destruction callbacks release each other",
  () =>
    Effect.gen(function* () {
      const subscriptions = yield* makeWebContentsDestructionSubscriptions;
      const source = createSource();
      const notified: string[] = [];
      const releaseFirst = subscriptions.subscribe(source, () => {
        notified.push("first");
        releaseSecond();
      });
      const releaseSecond = subscriptions.subscribe(source, () => {
        notified.push("second");
        releaseFirst();
      });

      source.destroy();
      releaseFirst();
      releaseSecond();
      assert.deepEqual(notified, ["first", "second"]);
      assert.strictEqual(source.listenerCount("destroyed"), 0);
    }),
);

it.effect("releases every native listener when its adapter scope closes", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const subscriptions = yield* Scope.provide(makeWebContentsDestructionSubscriptions, scope);
    const sources = [createSource(), createSource()];
    let cancelled = 0;
    const releases = sources.map((source) => subscriptions.subscribe(source, () => cancelled++));

    yield* Scope.close(scope, Exit.void);
    for (const source of sources) {
      assert.strictEqual(source.listenerCount("destroyed"), 0);
      source.destroy();
    }
    for (const release of releases) release();
    assert.strictEqual(cancelled, 0);
  }),
);

it.effect("immediately disposes work admitted after a renderer was destroyed", () =>
  Effect.gen(function* () {
    const subscriptions = yield* makeWebContentsDestructionSubscriptions;
    const source = createSource();
    source.destroy();
    let cancelled = 0;
    const release = subscriptions.subscribe(source, () => cancelled++);

    assert.strictEqual(cancelled, 1);
    assert.strictEqual(source.listenerCount("destroyed"), 0);
    release();
    assert.strictEqual(cancelled, 1);
  }),
);

it.effect("releases each subscription with its child Scope, including repeated renderer work", () =>
  Effect.gen(function* () {
    const subscriptions = yield* makeWebContentsDestructionSubscriptions;
    const source = createSource();
    const scopes = yield* Effect.forEach(Array.from({ length: 32 }), () => Scope.make());
    const notified: number[] = [];
    for (const [index, scope] of scopes.entries()) {
      yield* Scope.provide(
        subscriptions.subscribeScoped(source, () => notified.push(index)),
        scope,
      );
    }
    assert.strictEqual(source.listenerCount("destroyed"), 1);
    for (const scope of scopes.slice(0, 16)) yield* Scope.close(scope, Exit.void);
    source.destroy();
    assert.deepEqual(
      notified,
      Array.from({ length: 16 }, (_, index) => index + 16),
    );
    for (const scope of scopes) yield* Scope.close(scope, Exit.void);
    assert.strictEqual(source.listenerCount("destroyed"), 0);

    const longLived = createSource();
    for (let index = 0; index < 64; index++) {
      yield* Effect.scoped(subscriptions.subscribeScoped(longLived, () => notified.push(-1)));
      assert.strictEqual(longLived.listenerCount("destroyed"), 0);
    }
    longLived.destroy();
    assert.strictEqual(notified.length, 16);
  }),
);

it.effect("memoizes the same native owner across independent Main Layers", () =>
  Effect.gen(function* () {
    class First extends Context.Service<First, WebContentsDestructionSubscriptions["Service"]>()(
      "test/destruction/first",
    ) {}
    class Second extends Context.Service<Second, WebContentsDestructionSubscriptions["Service"]>()(
      "test/destruction/second",
    ) {}
    const first = Layer.effect(First, WebContentsDestructionSubscriptions).pipe(
      Layer.provide(WebContentsDestructionSubscriptions.live),
    );
    const second = Layer.effect(Second, WebContentsDestructionSubscriptions).pipe(
      Layer.provide(WebContentsDestructionSubscriptions.live),
    );
    const context = yield* Layer.build(Layer.merge(first, second));
    const firstOwner = Context.get(context, First);
    const secondOwner = Context.get(context, Second);
    assert.strictEqual(firstOwner, secondOwner);
    const source = createSource();
    let notified = 0;
    const releases = [firstOwner, secondOwner].flatMap((owner) =>
      Array.from({ length: 16 }, () => owner.subscribe(source, () => notified++)),
    );
    assert.strictEqual(source.listenerCount("destroyed"), 1);
    source.destroy();
    for (const release of releases) release();
    assert.strictEqual(notified, 32);
  }),
);

it.effect("removes destruction waits on normal completion and interruption", () =>
  Effect.gen(function* () {
    const subscriptions = yield* makeWebContentsDestructionSubscriptions;
    const source = createSource();
    for (let index = 0; index < 32; index++) {
      const fiber = yield* subscriptions
        .wait(source)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      assert.strictEqual(source.listenerCount("destroyed"), 1);
      yield* Fiber.interrupt(fiber);
      assert.strictEqual(source.listenerCount("destroyed"), 0);
    }
    const waiting = yield* subscriptions
      .wait(source)
      .pipe(Effect.forkScoped({ startImmediately: true }));
    source.destroy();
    yield* Fiber.join(waiting);
    assert.strictEqual(source.listenerCount("destroyed"), 0);
  }),
);

it.effect("runs every live cleanup even if a callback throws", () =>
  Effect.gen(function* () {
    const subscriptions = yield* makeWebContentsDestructionSubscriptions;
    const source = createSource();
    let cleaned = false;
    subscriptions.subscribe(source, () => {
      throw new Error("cleanup failed");
    });
    subscriptions.subscribe(source, () => {
      cleaned = true;
    });
    assert.throws(() => source.destroy(), AggregateError);
    assert.isTrue(cleaned);
    assert.strictEqual(source.listenerCount("destroyed"), 0);
  }),
);
