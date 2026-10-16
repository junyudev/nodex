import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import type { DesktopNotificationActionPayload } from "../../shared/types";
import {
  DesktopNotificationRuntime,
  layer,
  type DesktopNotificationInstance,
  type DesktopNotificationRuntimeOptions,
} from "./DesktopNotificationRuntime";

class FakeNotification implements DesktopNotificationInstance {
  readonly #listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  closed = false;
  shown = false;

  show(): void {
    this.shown = true;
  }

  close(): void {
    this.closed = true;
    this.emit("close");
  }

  on(event: "action" | "click" | "close" | "failed" | "reply", listener: () => void): void {
    const existing = this.#listeners.get(event) ?? [];
    existing.push(listener);
    this.#listeners.set(event, existing);
  }

  emit(event: "action" | "click" | "close" | "failed" | "reply", ...args: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(...args);
  }
}

const origin = (id = 7, destroyed = false) =>
  ({ id, isDestroyed: () => destroyed }) as Electron.WebContents;

const defaultOptions = (
  overrides: Partial<DesktopNotificationRuntimeOptions> = {},
): DesktopNotificationRuntimeOptions => ({
  isSupported: () => true,
  authorization: { read: Effect.succeed("authorized"), request: Effect.succeed("authorized") },
  createNotification: () => new FakeNotification(),
  homeDirectory: "/tmp",
  logger: { warn: () => undefined, info: () => undefined },
  platform: "linux",
  soundSourcePaths: [],
  ...overrides,
});

const useRuntime = <A>(
  overrides: Partial<DesktopNotificationRuntimeOptions>,
  use: (runtime: DesktopNotificationRuntime["Service"]) => Effect.Effect<A>,
): Effect.Effect<A> =>
  Effect.scoped(
    Layer.build(layer(defaultOptions(overrides))).pipe(
      Effect.flatMap((context) => use(Context.get(context, DesktopNotificationRuntime))),
    ),
  );

it.effect("projects native action, reply, timeout, and sanitized copy contracts", () =>
  Effect.gen(function* () {
    const notifications: FakeNotification[] = [];
    const constructorOptions: Electron.NotificationConstructorOptions[] = [];
    const actions: DesktopNotificationActionPayload[] = [];
    yield* useRuntime(
      {
        createNotification: (input) => {
          constructorOptions.push(input);
          const notification = new FakeNotification();
          notifications.push(notification);
          return notification;
        },
      },
      (runtime) =>
        Effect.sync(() => {
          runtime.show(
            {
              id: "turn-1",
              kind: "turn-complete",
              title: "**Task** <style>bad</style>",
              body: "Done <script>bad()</script> [details](https://example.com)",
              conversationId: "thread-1",
              replyPlaceholder: "Reply to Nodex",
              actions: Array.from({ length: 5 }, (_, index) => ({
                id: `action-${index + 1}`,
                title: `Action ${index + 1}`,
                actionType: "open" as const,
              })),
            },
            origin(),
            (action) => actions.push(action),
          );
          runtime.show(
            {
              id: "question-1",
              kind: "question",
              title: "Need input",
              body: "Answer one question.",
            },
            origin(8),
            () => undefined,
          );
          runtime.show(
            { id: "turn-click", kind: "turn-complete", title: "Complete", body: "Click" },
            origin(9),
            (action) => actions.push(action),
          );
          runtime.show(
            {
              id: "turn-reply",
              kind: "turn-complete",
              title: "Complete",
              body: "Reply",
              replyPlaceholder: "Reply to Nodex",
            },
            origin(10),
            (action) => actions.push(action),
          );
          notifications[0]?.emit("action", {}, 0);
          notifications[0]?.emit("reply", {}, "Ignored after action");
          notifications[2]?.emit("click");
          notifications[3]?.emit("reply", {}, "Ship it");
        }),
    );

    assert.strictEqual(constructorOptions[0]?.title, "Task");
    assert.strictEqual(constructorOptions[0]?.body, "Done details");
    assert.isTrue(constructorOptions[0]?.hasReply === true);
    assert.strictEqual(constructorOptions[0]?.actions?.length, 4);
    assert.strictEqual(constructorOptions[1]?.timeoutType, "never");
    assert.strictEqual(actions.length, 3);
    assert.strictEqual(actions[0]?.actionId, "action-1");
    assert.strictEqual(actions[1]?.actionType, "open");
    assert.strictEqual(actions[2]?.actionType, "reply");
    assert.strictEqual(actions[2]?.reply, "Ship it");
  }),
);

it.effect("replaces exact occurrences while keeping colliding public ids isolated", () =>
  Effect.gen(function* () {
    const notifications: FakeNotification[] = [];
    const removed: string[] = [];
    yield* useRuntime(
      {
        createNotification: () => {
          const notification = new FakeNotification();
          notifications.push(notification);
          return notification;
        },
      },
      (runtime) =>
        Effect.sync(() => {
          const show = (occurrenceId: string, path: string, label: string) =>
            runtime.show(
              {
                id: "question-default-73",
                occurrenceId,
                kind: "question",
                title: "Need input",
                body: label,
                navigationPath: path,
              },
              origin(),
              () => undefined,
              () => removed.push(label),
            );
          show('["question","default","thread-1",73]', "thread:first", "first");
          show('["question","default","thread-1","73"]', "thread:second", "second");
          show('["question","default","thread-1","73"]', "thread:replacement", "replacement");
          runtime.show(
            {
              id: "conversation-question",
              occurrenceId: "conversation-occurrence",
              kind: "question",
              title: "Need input",
              body: "Conversation",
              conversationId: "thread-conversation",
            },
            origin(),
            () => undefined,
            () => removed.push("conversation"),
          );
          runtime.dismiss({ navigationPath: "thread:first" });
          runtime.dismiss({ occurrenceId: '["question","default","thread-1","73"]' });
          runtime.dismiss({ conversationId: "thread-conversation" });
        }),
    );

    assert.isTrue(notifications[0]?.closed === true);
    assert.isTrue(notifications[1]?.closed === true);
    assert.isTrue(notifications[2]?.closed === true);
    assert.isTrue(notifications[3]?.closed === true);
    assert.deepEqual(removed, ["second", "first", "replacement", "conversation"]);
  }),
);

it.effect(
  "withdraws failed, throwing, unsupported, and rendererless occurrences exactly once",
  () =>
    Effect.gen(function* () {
      const notifications: FakeNotification[] = [];
      const remove = vi.fn();
      const logger = { warn: vi.fn(), info: vi.fn() };
      yield* useRuntime(
        {
          logger,
          createNotification: () => {
            const notification = new FakeNotification();
            notifications.push(notification);
            return notification;
          },
        },
        (runtime) =>
          Effect.sync(() => {
            runtime.show(
              {
                id: "question-failed",
                kind: "question",
                title: "Need input",
                body: "Question",
              },
              origin(),
              () => undefined,
              remove,
            );
            notifications[0]?.emit("failed", new Error("native failure"));
            runtime.dismiss({ notificationId: "question-failed" });
          }),
      );
      assert.strictEqual(remove.mock.calls.length, 1);
      expect(logger.warn).toHaveBeenCalledWith(
        "[desktop-notifications] native show failed",
        expect.objectContaining({ notificationId: "question-failed" }),
      );

      const showRemove = vi.fn();
      yield* useRuntime(
        {
          logger,
          createNotification: () => {
            const notification = new FakeNotification();
            notification.show = () => {
              throw new Error("show failure");
            };
            return notification;
          },
        },
        (runtime) =>
          Effect.sync(() =>
            runtime.show(
              {
                id: "question-show-throws",
                kind: "question",
                title: "Need input",
                body: "Question",
              },
              origin(),
              () => undefined,
              showRemove,
            ),
          ),
      );
      assert.strictEqual(showRemove.mock.calls.length, 1);

      const unavailableRemove = vi.fn();
      const createNotification = vi.fn(() => new FakeNotification());
      yield* useRuntime({ isSupported: () => false, createNotification }, (runtime) =>
        Effect.sync(() =>
          runtime.show(
            { id: "unavailable", kind: "question", title: "Need input", body: "Question" },
            origin(),
            () => undefined,
            unavailableRemove,
          ),
        ),
      );
      yield* useRuntime({ createNotification }, (runtime) =>
        Effect.sync(() =>
          runtime.show(
            { id: "destroyed", kind: "question", title: "Need input", body: "Question" },
            origin(9, true),
            () => undefined,
            unavailableRemove,
          ),
        ),
      );
      assert.strictEqual(createNotification.mock.calls.length, 0);
      assert.strictEqual(unavailableRemove.mock.calls.length, 2);
    }),
);

it.effect("closes native resources and fences late actions with the Main Scope", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const notification = new FakeNotification();
    const actions: DesktopNotificationActionPayload[] = [];
    const context = yield* Layer.buildWithScope(
      layer(defaultOptions({ createNotification: () => notification })),
      scope,
    );
    const runtime = Context.get(context, DesktopNotificationRuntime);
    runtime.show(
      { id: "notification-a", kind: "turn-complete", title: "Title", body: "Body" },
      origin(42),
      (action) => actions.push(action),
    );

    yield* Scope.close(scope, Exit.void);
    notification.emit("click");
    assert.isTrue(notification.closed);
    assert.deepEqual(actions, []);
  }),
);

it.effect("isolates cleanup callback failures while releasing all remaining resources", () =>
  Effect.gen(function* () {
    const notifications: FakeNotification[] = [];
    const logger = { warn: vi.fn(), info: vi.fn() };
    yield* useRuntime(
      {
        logger,
        createNotification: () => {
          const notification = new FakeNotification();
          notifications.push(notification);
          return notification;
        },
      },
      (runtime) =>
        Effect.sync(() => {
          runtime.show(
            { id: "throws", kind: "question", title: "Need input", body: "First" },
            origin(),
            () => undefined,
            () => {
              throw new Error("cleanup failure");
            },
          );
          runtime.show(
            { id: "after", kind: "question", title: "Need input", body: "Second" },
            origin(),
            () => undefined,
          );
        }),
    );

    assert.isTrue(notifications.every((notification) => notification.closed));
    expect(logger.warn).toHaveBeenCalledWith(
      "[desktop-notifications] callback cleanup failed",
      expect.objectContaining({ notificationId: "throws" }),
    );
  }),
);

it.effect(
  "waits for native authorization and withdraws denied delivery without changing the task",
  () =>
    Effect.gen(function* () {
      const decision = yield* Deferred.make<"authorized" | "denied">();
      const createNotification = vi.fn(() => new FakeNotification());
      const remove = vi.fn();
      const action = vi.fn();
      const logger = { info: vi.fn(), warn: vi.fn() };
      yield* useRuntime(
        {
          authorization: {
            read: Effect.succeed("not-determined"),
            request: Deferred.await(decision),
          },
          createNotification,
          logger,
        },
        (runtime) =>
          Effect.gen(function* () {
            runtime.show(
              { id: "pending-question", kind: "question", title: "Input needed", body: "Question" },
              origin(),
              action,
              remove,
            );
            yield* Effect.yieldNow;
            assert.strictEqual(createNotification.mock.calls.length, 0);
            yield* Deferred.succeed(decision, "denied");
            yield* Effect.yieldNow;
            assert.strictEqual(createNotification.mock.calls.length, 0);
            assert.strictEqual(remove.mock.calls.length, 1);
            assert.strictEqual(action.mock.calls.length, 0);
            assert.strictEqual(logger.warn.mock.calls.length, 0);
            expect(logger.info).toHaveBeenCalledWith(
              "[desktop-notifications] delivery unavailable",
              { status: "denied", notificationId: "pending-question" },
            );
          }),
      );
      assert.strictEqual(remove.mock.calls.length, 1);
    }),
);

it.effect(
  "never delivers removed or replaced occurrences after a delayed authorization grant",
  () =>
    Effect.gen(function* () {
      const decision = yield* Deferred.make<"authorized">();
      const shown: string[] = [];
      const removed: string[] = [];
      yield* useRuntime(
        {
          authorization: {
            read: Effect.succeed("not-determined"),
            request: Deferred.await(decision),
          },
          createNotification: ({ body }) => {
            shown.push(body ?? "");
            return new FakeNotification();
          },
        },
        (runtime) =>
          Effect.gen(function* () {
            const show = (id: string, body: string, sender = origin()) =>
              runtime.show(
                { id, kind: "question", title: "Input needed", body },
                sender,
                () => undefined,
                () => removed.push(body),
              );
            show("dismissed", "dismissed");
            runtime.dismiss({ notificationId: "dismissed" });
            show("replaced", "old");
            show("replaced", "new");
            show("closed-window", "closed window", origin(99));
            runtime.dismissByOriginWebContentsId(99);
            yield* Deferred.succeed(decision, "authorized");
            yield* Effect.yieldNow;
            assert.deepEqual(shown, ["new"]);
            assert.deepEqual(removed, ["dismissed", "old", "closed window"]);
          }),
      );
      assert.deepEqual(removed, ["dismissed", "old", "closed window", "new"]);
    }),
);

it.effect(
  "closing the Main Scope releases pending authorization callbacks before any native presentation",
  () =>
    Effect.gen(function* () {
      const decision = yield* Deferred.make<"authorized">();
      const createNotification = vi.fn(() => new FakeNotification());
      const remove = vi.fn();
      yield* useRuntime(
        {
          authorization: {
            read: Effect.succeed("not-determined"),
            request: Deferred.await(decision),
          },
          createNotification,
        },
        (runtime) =>
          Effect.sync(() => {
            runtime.show(
              { id: "closing", kind: "question", title: "Input needed", body: "Question" },
              origin(),
              () => undefined,
              remove,
            );
          }),
      );
      yield* Deferred.succeed(decision, "authorized");
      yield* Effect.yieldNow;
      assert.strictEqual(createNotification.mock.calls.length, 0);
      assert.strictEqual(remove.mock.calls.length, 1);
    }),
);
