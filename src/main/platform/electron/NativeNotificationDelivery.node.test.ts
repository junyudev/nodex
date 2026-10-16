import { EventEmitter } from "node:events";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { makeNativeNotificationDelivery } from "./NativeNotificationDelivery";

class NativeNotification extends EventEmitter {
  shown = false;
  closed = false;
  show() {
    this.shown = true;
  }
  close() {
    this.closed = true;
    this.emit("close");
  }
}
const input = { title: "Reminder", body: "Due now" };
const options = (notification: NativeNotification) => ({
  authorization: {
    read: Effect.succeed("authorized" as const),
    request: Effect.succeed("authorized" as const),
  },
  isSupported: () => true,
  createNotification: () => notification,
  runCallback: () => undefined,
  logger: { warn: () => undefined },
});

it.effect(
  "waits for native show acknowledgement and consumes clicks without requiring a close event",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const notification = new NativeNotification();
      let actions = 0;
      let completed = false;
      const deliver = yield* Scope.provide(
        makeNativeNotificationDelivery({
          ...options(notification),
          runCallback: () => {
            assert.deepEqual(notification.eventNames(), []);
            actions++;
          },
        }),
        scope,
      );
      const fiber = yield* deliver({ ...input, onClick: Effect.void }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            completed = true;
          }),
        ),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      assert.isTrue(notification.shown);
      assert.isFalse(completed);
      notification.emit("show");
      assert.isTrue(yield* Fiber.join(fiber));
      const lateClick = notification.listeners("click")[0];
      notification.emit("click");
      assert.strictEqual(actions, 1);
      assert.deepEqual(notification.eventNames(), []);
      notification.emit("click");
      notification.emit("action", {}, 0);
      lateClick?.();
      assert.strictEqual(actions, 1);
      yield* Scope.close(scope, Exit.void);
      assert.isFalse(notification.closed);
    }),
);

it.effect(
  "consumes and closes a native action before a delayed show event without dispatching twice",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const notification = new NativeNotification();
      let closeCalls = 0;
      notification.close = () => {
        closeCalls++;
        notification.closed = true;
      };
      const selected: number[] = [];
      let dispatched = 0;
      const deliver = yield* Scope.provide(
        makeNativeNotificationDelivery({
          ...options(notification),
          runCallback: () => {
            assert.deepEqual(notification.eventNames(), []);
            assert.isTrue(notification.closed);
            dispatched++;
          },
        }),
        scope,
      );
      const fiber = yield* deliver({
        ...input,
        actions: ["Snooze 10m", "Snooze 1h"],
        onAction: (index) => {
          selected.push(index);
          return Effect.void;
        },
      }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const lateAction = notification.listeners("action")[0];
      notification.emit("action", {}, 1);
      assert.isTrue(yield* Fiber.join(fiber));
      assert.deepEqual(notification.eventNames(), []);
      assert.deepEqual(selected, [1]);
      notification.emit("show");
      notification.emit("click");
      notification.emit("action", {}, 0);
      lateAction?.({}, 0);
      assert.strictEqual(dispatched, 1);
      assert.deepEqual(selected, [1]);
      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(closeCalls, 1);
    }),
);

it.effect("returns delivery failure and releases callbacks when native scheduling fails", () =>
  Effect.gen(function* () {
    const notification = new NativeNotification();
    const deliver = yield* makeNativeNotificationDelivery(options(notification));
    const fiber = yield* deliver(input).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    notification.emit("failed", {}, "UNErrorDomain error 1");
    assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)));
    assert.deepEqual(notification.eventNames(), []);
  }),
);

it.effect("releases and settles an unconfirmed delivery on native close or scope shutdown", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const notification = new NativeNotification();
    const deliver = yield* Scope.provide(
      makeNativeNotificationDelivery(options(notification)),
      scope,
    );
    const pending = yield* deliver(input).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    notification.emit("close");
    assert.isFalse(yield* Fiber.join(pending));
    const next = yield* deliver(input).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Scope.close(scope, Exit.void);
    assert.isFalse(yield* Fiber.join(next));
    assert.isTrue(notification.closed);
    assert.deepEqual(notification.eventNames(), []);
  }),
);

it.effect("interruption closes a pending native notification and fences late delivery events", () =>
  Effect.gen(function* () {
    const notification = new NativeNotification();
    const deliver = yield* makeNativeNotificationDelivery(options(notification));
    const fiber = yield* deliver(input).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(fiber);
    notification.emit("show");
    assert.isTrue(notification.closed);
    assert.deepEqual(notification.eventNames(), []);
  }),
);
