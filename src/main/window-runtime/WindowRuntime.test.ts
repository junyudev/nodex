import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { assert, it } from "@effect/vitest";
import type { BrowserWindow } from "electron";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createDefaultWorkbenchLayoutSnapshot } from "../../shared/workbench-layout";
import type { WindowRuntimeLifecycleEvent } from "./window-runtime-lifecycle";
import { WindowSessionState } from "../window-session-state";
import { fromState, WindowRuntime } from "./WindowRuntime";

const fakeWindow = (webContentsId: number) => {
  let destroyed = false;
  let focused = false;
  const events = new EventEmitter();
  const sentChannels: string[] = [];
  return {
    window: {
      id: webContentsId,
      destroy: () => {
        destroyed = true;
        events.emit("closed");
      },
      close: () => {
        let prevented = false;
        events.emit("close", { preventDefault: () => (prevented = true) });
        if (prevented) return;
        destroyed = true;
        events.emit("closed");
      },
      getBounds: () => ({ x: 0, y: 0, width: 1_400, height: 900 }),
      isFullScreen: () => false,
      isFocused: () => focused,
      isMaximized: () => false,
      isDestroyed: () => destroyed,
      on: events.on.bind(events),
      removeListener: events.removeListener.bind(events),
      setBackgroundColor: () => undefined,
      setVibrancy: () => undefined,
      webContents: {
        id: webContentsId,
        isDestroyed: () => false,
        send: (channel: string) => sentChannels.push(channel),
      },
    } as unknown as BrowserWindow,
    blur: () => {
      focused = false;
      events.emit("blur");
    },
    focus: () => {
      focused = true;
      events.emit("focus");
    },
    isDestroyed: () => destroyed,
    sentChannels,
  };
};

const sessionLayout = (sessionId: string) => ({
  ...createDefaultWorkbenchLayoutSnapshot(),
  location: {
    kind: "session" as const,
    projectContextId: null,
    sessionId,
  },
});

it.effect("owns window registration, focus, session assignment, and final release", () =>
  Effect.gen(function* () {
    const userDataPath = mkdtempSync(join(tmpdir(), "window-runtime-"));
    const sessions = new WindowSessionState(userDataPath);
    const firstSession = sessions.createFreshSession();
    const secondSession = sessions.createFreshSession();
    const first = fakeWindow(11);
    const second = fakeWindow(22);
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(fromState(sessions), scope);
    const runtime = Context.get(context, WindowRuntime);

    runtime.attach(first.window, firstSession.id);
    runtime.attach(second.window, secondSession.id);
    assert.strictEqual(runtime.count(), 2);
    assert.strictEqual(runtime.getLastFocused(), second.window);
    assert.strictEqual(runtime.resolveSessionId(11), firstSession.id);

    runtime.markFocused(11);
    assert.strictEqual(runtime.getLastFocused(), first.window);
    runtime.release(11, { disposition: "user-close" });
    assert.isFalse(runtime.has(11));
    assert.isNull(runtime.resolveSessionId(11));

    yield* Scope.close(scope, Exit.void);
    assert.isTrue(second.isDestroyed());
    assert.strictEqual(runtime.count(), 0);
    assert.isNull(runtime.resolveSessionId(22));
  }),
);

it.effect("owns the bounded renderer flush handshake before a user close", () =>
  Effect.gen(function* () {
    const userDataPath = mkdtempSync(join(tmpdir(), "window-close-runtime-"));
    const sessions = new WindowSessionState(userDataPath);
    const windowSession = sessions.createFreshSession();
    const subject = fakeWindow(33);
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(fromState(sessions), scope);
    const runtime = Context.get(context, WindowRuntime);
    runtime.attach(subject.window, windowSession.id);

    subject.window.close();
    assert.isTrue(runtime.has(33));
    assert.deepStrictEqual(subject.sentChannels, ["app:flush-before-close"]);

    runtime.acknowledgeClose(33);
    assert.isTrue(subject.isDestroyed());
    assert.isFalse(runtime.has(33));
    assert.isNull(runtime.resolveSessionId(33));

    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("closes an unresponsive renderer through a Scope-owned deadline", () =>
  Effect.gen(function* () {
    const userDataPath = mkdtempSync(join(tmpdir(), "window-close-deadline-"));
    const sessions = new WindowSessionState(userDataPath);
    const windowSession = sessions.createFreshSession();
    const subject = fakeWindow(44);
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(fromState(sessions), scope);
    const runtime = Context.get(context, WindowRuntime);
    runtime.attach(subject.window, windowSession.id);

    subject.window.close();
    assert.isFalse(subject.isDestroyed());
    yield* TestClock.adjust("1500 millis");
    yield* Effect.yieldNow;

    assert.isTrue(subject.isDestroyed());
    assert.isFalse(runtime.has(44));
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("publishes bounded primary lifecycle projections as one URL changes layouts", () =>
  Effect.gen(function* () {
    const userDataPath = mkdtempSync(join(tmpdir(), "window-lifecycle-runtime-"));
    const sessions = new WindowSessionState(userDataPath);
    const windowSession = sessions.createFreshSession();
    const subject = fakeWindow(55);
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(fromState(sessions), scope);
    const runtime = Context.get(context, WindowRuntime);
    const collected = yield* runtime.events.pipe(
      Stream.take(6),
      Stream.runCollect,
      Effect.forkIn(scope, { startImmediately: true }),
    );

    runtime.attach(subject.window, windowSession.id);
    subject.focus();
    runtime.saveLayout(55, {
      layout: sessionLayout("session-a"),
      revision: 1,
      sessionId: windowSession.id,
    });
    runtime.saveLayout(55, {
      layout: {
        ...createDefaultWorkbenchLayoutSnapshot(),
        location: {
          kind: "settings",
          path: "/appearance",
          returnTo: {
            kind: "session",
            projectContextId: null,
            sessionId: "session-b",
          },
        },
      },
      revision: 2,
      sessionId: windowSession.id,
    });
    subject.blur();
    runtime.release(55, { disposition: "user-close" });

    const events = (yield* Fiber.join(collected)) as readonly WindowRuntimeLifecycleEvent[];
    assert.deepEqual(
      events.map((event) => event.kind),
      [
        "registered",
        "focus-changed",
        "layout-changed",
        "layout-changed",
        "focus-changed",
        "released",
      ],
    );
    assert.deepEqual(
      events.map((event) => event.revision),
      [1, 2, 3, 4, 5, 6],
    );
    const layoutChanges = events.filter((event) => event.kind === "layout-changed");
    assert.deepEqual(
      layoutChanges.map(({ previousActiveSessionId, window }) => ({
        active: window.activeSessionId,
        previous: previousActiveSessionId,
      })),
      [
        { active: "session-a", previous: null },
        { active: "session-b", previous: "session-a" },
      ],
    );
    assert.deepEqual(runtime.snapshot(), { revision: 6, windows: [] });

    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("registers auxiliary windows without granting or persisting a Window Session", () =>
  Effect.gen(function* () {
    const userDataPath = mkdtempSync(join(tmpdir(), "window-auxiliary-runtime-"));
    const sessions = new WindowSessionState(userDataPath);
    const windowSession = sessions.createFreshSession();
    const primary = fakeWindow(66);
    const auxiliary = fakeWindow(77);
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(fromState(sessions), scope);
    const runtime = Context.get(context, WindowRuntime);
    runtime.attach(primary.window, windowSession.id);

    runtime.registerAuxiliary(auxiliary.window, "avatar-overlay");
    assert.strictEqual(runtime.count(), 1);
    assert.deepEqual(runtime.all(), [primary.window]);
    assert.isNull(runtime.get(77));
    assert.isFalse(runtime.has(77));
    assert.isNull(runtime.resolveSessionId(77));
    assert.strictEqual(runtime.getRegisteredWindow(77), auxiliary.window);
    assert.deepInclude(runtime.snapshot().windows, {
      focusSequence: null,
      focused: false,
      kind: "auxiliary",
      role: "avatar-overlay",
      webContentsId: 77,
      windowId: 77,
    });

    yield* Scope.close(scope, Exit.void);
    assert.isTrue(primary.isDestroyed());
    assert.isTrue(auxiliary.isDestroyed());
    assert.isNull(runtime.resolveSessionId(77));
  }),
);
