import { describe, vi } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeNativeNotificationAuthorization } from "./NativeNotificationAuthorization";
import { CoreRequestClass } from "../../core-runtime/CoreRequestClass";
import { EventEmitter } from "node:events";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { makeNativeNotificationDelivery } from "./NativeNotificationDelivery";

vi.mock("electron", () => ({ Notification: { isSupported: () => true } }));

describe("NativeNotificationAuthorization", () => {
  it.effect("serializes first authorization requests and reads the current system decision", () =>
    Effect.gen(function* () {
      let status = "not-determined";
      let requests = 0;
      let reads = 0;
      const authorization = yield* makeNativeNotificationAuthorization({
        platform: "darwin",
        isSupported: () => true,
        loadBridge: () => ({
          readAuthorization: async () => {
            reads++;
            return status;
          },
          requestAuthorization: async () => {
            requests++;
            await Promise.resolve();
            status = "authorized";
            return status;
          },
        }),
      });
      assert.strictEqual(yield* authorization.read, "not-determined");
      assert.strictEqual(requests, 0);
      assert.deepEqual(
        yield* Effect.all([authorization.request, authorization.request], {
          concurrency: "unbounded",
        }),
        ["authorized", "authorized"],
      );
      assert.strictEqual(requests, 1);
      assert.strictEqual(reads, 3);
      status = "denied";
      assert.strictEqual(yield* authorization.request, "denied");
      assert.strictEqual(requests, 1);
      status = "provisional";
      assert.strictEqual(yield* authorization.request, "provisional");
      assert.strictEqual(requests, 1);
    }),
  );

  it.effect(
    "propagates invalid and failed native authorization instead of assuming delivery is allowed",
    () =>
      Effect.gen(function* () {
        const unavailable = yield* makeNativeNotificationAuthorization({
          platform: "darwin",
          isSupported: () => true,
          loadBridge: () => ({
            readAuthorization: async () => "unknown",
            requestAuthorization: async () => "authorized",
          }),
        });
        assert.strictEqual((yield* Effect.result(unavailable.request))._tag, "Failure");
        const rejected = yield* makeNativeNotificationAuthorization({
          platform: "darwin",
          isSupported: () => true,
          loadBridge: () => ({
            readAuthorization: async () => "not-determined",
            requestAuthorization: async () => {
              throw new Error("Native permission failed");
            },
          }),
        });
        assert.strictEqual((yield* Effect.result(rejected.request))._tag, "Failure");
      }),
  );

  it.effect("uses platform support without loading a macOS bridge on other platforms", () =>
    Effect.gen(function* () {
      let supported = true;
      const authorization = yield* makeNativeNotificationAuthorization({
        platform: "linux",
        isSupported: () => supported,
        loadBridge: () => {
          throw new Error("macOS bridge must not load");
        },
      });
      assert.strictEqual(yield* authorization.request, "unknown");
      supported = false;
      assert.strictEqual(yield* authorization.read, "unsupported");
    }),
  );
});

describe("NativeNotificationDelivery", () => {
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
        const callbacks: Effect.Effect<void>[] = [];
        const notification = new NativeNotification();
        let completed = false;
        const deliver = yield* Scope.provide(
          makeNativeNotificationDelivery({
            ...options(notification),
            runCallback: (effect) => {
              assert.deepEqual(notification.eventNames(), []);
              callbacks.push(effect);
            },
          }),
          scope,
        );
        const fiber = yield* deliver({
          ...input,
          onClick: CoreRequestClass.pipe(
            Effect.map((requestClass) => assert.strictEqual(requestClass, "interactive")),
          ),
        }).pipe(
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
        assert.lengthOf(callbacks, 1);
        yield* callbacks[0]!;
        assert.deepEqual(notification.eventNames(), []);
        notification.emit("click");
        notification.emit("action", {}, 0);
        lateClick?.();
        assert.lengthOf(callbacks, 1);
        yield* Scope.close(scope, Exit.void);
        assert.isFalse(notification.closed);
      }),
  );

  it.effect(
    "consumes and closes a native action before a delayed show event without dispatching twice",
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const callbacks: Effect.Effect<void>[] = [];
        const notification = new NativeNotification();
        let closeCalls = 0;
        notification.close = () => {
          closeCalls++;
          notification.closed = true;
        };
        const selected: number[] = [];
        const deliver = yield* Scope.provide(
          makeNativeNotificationDelivery({
            ...options(notification),
            runCallback: (effect) => {
              assert.deepEqual(notification.eventNames(), []);
              assert.isTrue(notification.closed);
              callbacks.push(effect);
            },
          }),
          scope,
        );
        const fiber = yield* deliver({
          ...input,
          actions: ["Snooze 10m", "Snooze 1h"],
          onAction: (index) => {
            selected.push(index);
            return CoreRequestClass.pipe(
              Effect.map((requestClass) => assert.strictEqual(requestClass, "interactive")),
            );
          },
        }).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const lateAction = notification.listeners("action")[0];
        notification.emit("action", {}, 1);
        assert.isTrue(yield* Fiber.join(fiber));
        assert.deepEqual(notification.eventNames(), []);
        assert.deepEqual(selected, [1]);
        assert.lengthOf(callbacks, 1);
        yield* callbacks[0]!;
        notification.emit("show");
        notification.emit("click");
        notification.emit("action", {}, 0);
        lateAction?.({}, 0);
        assert.lengthOf(callbacks, 1);
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

  it.effect(
    "interruption closes a pending native notification and fences late delivery events",
    () =>
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
});
