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
import { makeWebContentsDestructionSubscriptions } from "./WebContentsDestructionSubscriptions";

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
