import { describe, expect, test, vi } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { assert, it } from "@effect/vitest";
import type { BrowserWindow, WebContents } from "electron";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createDefaultWorkbenchLayoutSnapshot } from "../../shared/workbench-layout";
import {
  type WindowRuntimeLifecycleEvent,
  selectPreferredWindowRuntimeWindow,
  type WindowRuntimeSnapshot,
  type WindowRuntimeWindowSnapshot,
} from "./window-runtime-lifecycle";
import { readEffectiveLinkOpeningSettings } from "../settings/effective-link-opening";
import { WindowSessionState, type AcquiredWindowSession } from "../window-session-state";
import { fromState, WindowRuntime, type WindowRuntimeService } from "./WindowRuntime";
import { Effect as Effectapplicationwindowcoordinator } from "effect";
import type { WindowSessionRecord } from "../../shared/window-session";
import { createApplicationWindowCoordinator } from "./application-window-coordinator";
import { type WindowCleanupReport, make, type ShutdownWindow } from "./WindowShutdown";
import {
  resolveApplicationWindowLinkDestination,
  installApplicationWindowLinkRouting,
} from "./application-window-link-opening";
import { resolveLinkOpenRequest } from "../../shared/link-opening";
import { DEFAULT_LINK_OPENING_SETTINGS } from "../../shared/link-opening-settings";

describe("WindowRuntime", () => {
  const fakeWindow = (webContentsId: number) => {
    let destroyed = false;
    let focused = false;
    let hidden = false;
    const events = new EventEmitter();
    const rendererEvents = new EventEmitter();
    const sentChannels: string[] = [];
    const whileAlive = <A>(value: A): A => {
      if (destroyed) throw new Error("Object has been destroyed");
      return value;
    };
    const webContents = {
      get id() {
        return whileAlive(webContentsId);
      },
      on: rendererEvents.on.bind(rendererEvents),
      removeListener: rendererEvents.removeListener.bind(rendererEvents),
      isDestroyed: () => destroyed,
      send: (channel: string) => sentChannels.push(channel),
    };
    return {
      window: {
        get id() {
          return whileAlive(webContentsId);
        },
        destroy: () => {
          destroyed = true;
          events.emit("closed");
        },
        hide: () => {
          hidden = true;
        },
        close: () => {
          let prevented = false;
          events.emit("close", { preventDefault: () => (prevented = true) });
          if (prevented) return;
          destroyed = true;
          events.emit("closed");
        },
        getBounds: () => whileAlive({ x: 0, y: 0, width: 1_400, height: 900 }),
        isFullScreen: () => whileAlive(false),
        isFocused: () => whileAlive(focused),
        isMaximized: () => whileAlive(false),
        isDestroyed: () => destroyed,
        on: events.on.bind(events),
        removeListener: events.removeListener.bind(events),
        setBackgroundColor: () => undefined,
        setVibrancy: () => undefined,
        get webContents() {
          return whileAlive(webContents);
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
      isHidden: () => hidden,
      sentChannels,
      rendererEvents,
    };
  };

  const sessionLayout = (sessionId: string) => {
    const location = {
      kind: "session" as const,
      projectContextId: null,
      sessionId,
    };
    return {
      ...createDefaultWorkbenchLayoutSnapshot(),
      location,
      homeLocation: location,
    };
  };

  it.effect(
    "revokes exact renderer identities on navigation, process loss, and window release",
    () =>
      Effect.gen(function* () {
        const sessions = new WindowSessionState(mkdtempSync(join(tmpdir(), "window-renderer-")));
        const subject = fakeWindow(81);
        const other = fakeWindow(82);
        const scope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(fromState(sessions), scope);
        const runtime = Context.get(context, WindowRuntime);
        runtime.attach(subject.window, sessions.createFreshSession().id);
        runtime.attach(other.window, sessions.createFreshSession().id);
        assert.isNull(runtime.resolveRendererGeneration(81));
        subject.rendererEvents.emit("did-navigate");
        other.rendererEvents.emit("did-navigate");
        const first = runtime.resolveRendererGeneration(81);
        const otherGeneration = runtime.resolveRendererGeneration(82);
        assert.isString(first);
        assert.notEqual(first, otherGeneration);
        assert.equal(runtime.claimPresentationGeneration(81, "owner-a"), first);
        assert.equal(runtime.claimPresentationGeneration(81, "owner-a"), first);
        runtime.markRendererInitialized(81);

        subject.rendererEvents.emit("did-start-navigation", {
          isMainFrame: false,
          isSameDocument: false,
        });
        subject.rendererEvents.emit("did-start-navigation", {
          isMainFrame: true,
          isSameDocument: true,
        });
        assert.equal(runtime.resolveRendererGeneration(81), first);
        assert.isTrue(runtime.isRendererInitialized(81));

        const collected = yield* runtime.events.pipe(
          Stream.take(4),
          Stream.runCollect,
          Effect.forkIn(scope, { startImmediately: true }),
        );
        subject.rendererEvents.emit("did-start-navigation", {
          isMainFrame: true,
          isSameDocument: false,
        });
        assert.isNull(runtime.resolveRendererGeneration(81));
        assert.isFalse(runtime.isRendererInitialized(81));
        subject.rendererEvents.emit("did-navigate");
        const second = runtime.resolveRendererGeneration(81);
        assert.isString(second);
        assert.notEqual(second, first);
        subject.rendererEvents.emit("render-process-gone");
        assert.isNull(runtime.resolveRendererGeneration(81));
        runtime.release(81, { disposition: "unexpected" });
        assert.isNull(runtime.resolveRendererGeneration(81));
        assert.equal(runtime.resolveRendererGeneration(82), otherGeneration);
        const events = yield* Fiber.join(collected);
        assert.deepEqual(
          events.map((event) => event.kind),
          ["renderer-changed", "renderer-changed", "renderer-changed", "released"],
        );
        const changes = events.filter((event) => event.kind === "renderer-changed");
        assert.deepEqual(
          changes.map((event) => [
            event.previousRendererGeneration,
            event.window.rendererGeneration,
          ]),
          [
            [first, null],
            [null, second],
            [second, null],
          ],
        );
        assert.equal(subject.rendererEvents.listenerCount("did-navigate"), 0);
        assert.equal(subject.rendererEvents.listenerCount("did-start-navigation"), 0);
        assert.equal(subject.rendererEvents.listenerCount("render-process-gone"), 0);
        yield* Scope.close(scope, Exit.void);
        assert.equal(other.rendererEvents.listenerCount("did-navigate"), 0);
      }),
  );

  it.effect(
    "replaces presentation generations independently of initialization and other windows",
    () =>
      Effect.gen(function* () {
        const sessions = new WindowSessionState(
          mkdtempSync(join(tmpdir(), "window-presentation-")),
        );
        const subject = fakeWindow(83);
        const scope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(fromState(sessions), scope);
        const runtime = Context.get(context, WindowRuntime);
        runtime.attach(subject.window, sessions.createFreshSession().id);
        assert.isNull(runtime.claimPresentationGeneration(83, "owner-before-navigation"));
        subject.rendererEvents.emit("did-navigate");
        const first = runtime.claimPresentationGeneration(83, "owner-a");
        runtime.markRendererInitialized(83);
        const second = runtime.claimPresentationGeneration(83, "owner-b");
        assert.isString(second);
        assert.notEqual(second, first);
        assert.equal(runtime.claimPresentationGeneration(83, "owner-b"), second);
        assert.isTrue(runtime.isRendererInitialized(83));
        assert.equal(runtime.resolveRendererGeneration(83), second);
        yield* Scope.close(scope, Exit.void);
      }),
  );

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
      const layout = sessionLayout("last-session");
      runtime.saveLayout(33, { layout, revision: 1, sessionId: windowSession.id });
      runtime.markRendererInitialized(33);
      const collected = yield* runtime.events.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkIn(scope, { startImmediately: true }),
      );

      subject.window.close();
      assert.isTrue(runtime.has(33));
      assert.deepStrictEqual(subject.sentChannels, ["app:flush-before-close"]);

      runtime.acknowledgeClose(33);
      assert.isTrue(subject.isDestroyed());
      assert.isFalse(runtime.has(33));
      assert.isNull(runtime.resolveSessionId(33));
      assert.isFalse(runtime.isRendererInitialized(33));
      assert.deepInclude((yield* Fiber.join(collected))[0], {
        kind: "released",
        window: {
          activeSessionId: "last-session",
          focusSequence: null,
          focused: false,
          kind: "primary",
          layoutRevision: 1,
          rendererGeneration: null,
          webContentsId: 33,
          windowId: 33,
          windowSessionId: windowSession.id,
        },
      });
      yield* Effect.promise(() => sessions.flush());
      assert.deepInclude(new WindowSessionState(userDataPath).readCatalog()?.sessions[0], {
        bounds: { x: 0, y: 0, width: 1_400, height: 900, mode: "normal" },
        layout,
        layoutRevision: 1,
      });
      assert.strictEqual(sessions.readCatalog()?.sessions[0]?.lifecycle.state, "closed");
      assert.equal(subject.rendererEvents.listenerCount("did-navigate"), 0);
      assert.equal(subject.rendererEvents.listenerCount("did-start-navigation"), 0);
      assert.equal(subject.rendererEvents.listenerCount("render-process-gone"), 0);
      runtime.acknowledgeClose(33);

      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect(
    "retains the last tray window and its renderer, then closes it through ordinary quit",
    () =>
      Effect.gen(function* () {
        const sessions = new WindowSessionState(
          mkdtempSync(join(tmpdir(), "window-tray-runtime-")),
        );
        const first = fakeWindow(331);
        const last = fakeWindow(332);
        const scope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(
          fromState(sessions, undefined, () => true),
          scope,
        );
        const runtime = Context.get(context, WindowRuntime);
        runtime.attach(first.window, sessions.createFreshSession().id);
        const retainedSessionId = sessions.createFreshSession().id;
        runtime.attach(last.window, retainedSessionId);
        runtime.markRendererInitialized(332);
        first.window.close();
        runtime.acknowledgeClose(331);
        assert.isTrue(first.isDestroyed());
        last.window.close();
        assert.isTrue(last.isHidden());
        assert.isFalse(last.isDestroyed());
        assert.isTrue(runtime.isRendererInitialized(332));
        assert.equal(runtime.resolveSessionId(332), retainedSessionId);
        assert.deepEqual(last.sentChannels, []);
        runtime.beginApplicationQuit();
        last.window.close();
        assert.deepEqual(last.sentChannels, ["app:flush-before-close"]);
        runtime.acknowledgeClose(332);
        assert.isTrue(last.isDestroyed());
        assert.equal(runtime.count(), 0);
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

      runtime.registerAuxiliary(auxiliary.window, "mini");
      assert.isTrue(runtime.hasAppRenderer(66));
      assert.isTrue(runtime.hasAppRenderer(77));
      assert.isTrue(runtime.hasAuxiliaryRole(77, "mini"));
      assert.isFalse(runtime.hasAuxiliaryRole(66, "mini"));
      assert.deepEqual(runtime.appRenderers(), [primary.window, auxiliary.window]);
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
        role: "mini",
        webContentsId: 77,
        windowId: 77,
      });

      yield* Scope.close(scope, Exit.void);
      assert.isTrue(primary.isDestroyed());
      assert.isTrue(auxiliary.isDestroyed());
      assert.isNull(runtime.resolveSessionId(77));
    }),
  );

  it.effect(
    "refreshes caption chrome for every live primary window and releases theme observation",
    () =>
      Effect.gen(function* () {
        const sessions = new WindowSessionState(mkdtempSync(join(tmpdir(), "window-theme-")));
        const first = fakeWindow(91);
        const second = fakeWindow(92);
        const calls: Array<{ id: number; dark: boolean }> = [];
        let dark = false;
        let notify: (() => void) | null = null;
        const scope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(
          fromState(sessions, {
            apply: (window) => {
              calls.push({ id: window.webContents.id, dark });
            },
            forget: () => {},
            subscribeToTheme: (listener) => {
              notify = listener;
              return () => {
                notify = null;
              };
            },
          }),
          scope,
        );
        const runtime = Context.get(context, WindowRuntime);
        runtime.attach(first.window, sessions.createFreshSession().id);
        runtime.attach(second.window, sessions.createFreshSession().id);
        calls.length = 0;
        dark = true;
        (notify as (() => void) | null)?.();
        assert.deepEqual(calls, [
          { id: 91, dark: true },
          { id: 92, dark: true },
        ]);
        runtime.release(91, { disposition: "user-close" });
        calls.length = 0;
        dark = false;
        (notify as (() => void) | null)?.();
        assert.deepEqual(calls, [{ id: 92, dark: false }]);
        yield* Scope.close(scope, Exit.void);
        assert.isNull(notify);
      }),
  );
});

describe("application-window-coordinator", () => {
  const Effect = Effectapplicationwindowcoordinator;
  const cleanReport: WindowCleanupReport = {
    alreadyClosed: 0,
    destroyed: 0,
    failed: 0,
    failures: [],
    graceful: 0,
    total: 0,
  };

  const session = (id: string): WindowSessionRecord => ({ id }) as WindowSessionRecord;

  const browserWindow = (id: number, sent: string[] = []): BrowserWindow =>
    ({
      focus: vi.fn(),
      isDestroyed: () => false,
      isMinimized: () => false,
      show: vi.fn(),
      webContents: {
        id,
        isDestroyed: () => false,
        send: (channel: string) => sent.push(channel),
      },
    }) as unknown as BrowserWindow;

  describe("application window coordinator", () => {
    test("reopens a primary window and delivers recording navigation after renderer readiness", () => {
      const sent: string[] = [];
      const window = browserWindow(7, sent);
      const send = vi.spyOn(window.webContents, "send");
      let current: BrowserWindow | null = null;
      let initialized = false;
      const create = vi.fn(() => {
        current = window;
        return window;
      });
      const coordinator = createApplicationWindowCoordinator({
        closeAll: () => Effect.succeed(cleanReport),
        create,
        focusedWindow: () => null,
        reportFailure: vi.fn(),
        restoreInitial: () => null,
        windows: {
          acquireSessionForNewWindow: () => ({ kind: "new", session: session("recovery") }),
          getLastFocused: () => current,
          get: () => current,
          isRendererInitialized: () => initialized,
        } as unknown as WindowRuntimeService,
      });
      expect(coordinator.openDictationRecording("recording-a")).toBe(true);
      expect(create).toHaveBeenCalledOnce();
      expect(send).not.toHaveBeenCalled();
      initialized = true;
      coordinator.flushDictationRecording(8);
      expect(send).not.toHaveBeenCalled();
      coordinator.flushDictationRecording(7);
      coordinator.flushDictationRecording(7);
      expect(send).toHaveBeenCalledExactlyOnceWith("dictation:open-recording", {
        recordingId: "recording-a",
      });
      expect(coordinator.openDictationRecording("recording-b")).toBe(true);
      expect(create).toHaveBeenCalledOnce();
      expect(send).toHaveBeenLastCalledWith("dictation:open-recording", {
        recordingId: "recording-b",
      });
      coordinator.stop();
      expect(coordinator.openDictationRecording("recording-c")).toBe(false);
    });

    test.each(["primary", "mini"] as const)(
      "delegates a new-window request to an initialized primary renderer when %s has focus",
      (focusedRole) => {
        const sent: string[] = [];
        const captureMessages: string[] = [];
        const source = browserWindow(7, sent);
        const capture = browserWindow(8, captureMessages);
        const create = vi.fn();
        const coordinator = createApplicationWindowCoordinator({
          closeAll: () => Effect.succeed(cleanReport),
          create,
          focusedWindow: () => (focusedRole === "primary" ? source : capture),
          reportFailure: vi.fn(),
          restoreInitial: () => null,
          windows: {
            get: (id: number) => (id === source.webContents.id ? source : null),
            getLastFocused: () => source,
            hasClosedSessionAvailable: () => false,
            isRendererInitialized: () => true,
          } as unknown as WindowRuntimeService,
        });

        coordinator.requestNew();
        expect(sent).toEqual(["request-new-window"]);
        expect(captureMessages).toEqual([]);
        expect(create).not.toHaveBeenCalled();

        coordinator.stop();
        coordinator.requestNew();
        expect(sent).toEqual(["request-new-window"]);
      },
    );

    test("rolls back a reopened durable session when native window creation fails", () => {
      const reopened = session("window-reopened");
      const previousRecord = session("window-reopened");
      const acquired = {
        kind: "reopened",
        session: reopened,
        previousRecord,
      } as AcquiredWindowSession;
      const rollback = vi.fn();
      const reportFailure = vi.fn();
      const coordinator = createApplicationWindowCoordinator({
        closeAll: () => Effect.succeed(cleanReport),
        create: () => {
          throw new Error("native creation failed");
        },
        focusedWindow: () => null,
        reportFailure,
        restoreInitial: () => null,
        windows: {
          acquireSessionForNewWindow: () => acquired,
          getLastFocused: () => null,
          hasClosedSessionAvailable: () => true,
          rollbackReopenSession: rollback,
        } as unknown as WindowRuntimeService,
      });

      coordinator.requestNew();

      expect(rollback).toHaveBeenCalledWith(previousRecord);
      expect(reportFailure).toHaveBeenCalledWith({
        cause: expect.any(Error),
        operation: "acquire",
        windowSessionId: "window-reopened",
      });
    });

    test.each([{ browserUrl: "https://example.com/path" }, { page: { pageId: "page-1" } }])(
      "opens a targeted window instead of reopening a closed session (%j)",
      (request) => {
        const cloned = session("window-target");
        const created = browserWindow(9);
        const create = vi.fn(() => created);
        const acquireSessionForNewWindow = vi.fn();
        const cloneSessionForWindow = vi.fn(() => cloned);
        const coordinator = createApplicationWindowCoordinator({
          closeAll: () => Effect.succeed(cleanReport),
          create,
          focusedWindow: () => null,
          reportFailure: vi.fn(),
          restoreInitial: () => null,
          windows: {
            acquireSessionForNewWindow,
            cloneSessionForWindow,
            hasClosedSessionAvailable: () => true,
          } as unknown as WindowRuntimeService,
        });
        coordinator.openForRequest(3, request);

        expect(acquireSessionForNewWindow).not.toHaveBeenCalled();
        expect(cloneSessionForWindow).toHaveBeenCalledExactlyOnceWith(3, request);
        expect(create).toHaveBeenCalledExactlyOnceWith(cloned);
        expect(created.show).toHaveBeenCalledOnce();
        expect(created.focus).toHaveBeenCalledOnce();
      },
    );

    it.effect("clones explicit Project context and owns quit preparation", () =>
      Effect.gen(function* () {
        const cloned = session("window-cloned");
        const created = browserWindow(9);
        const create = vi.fn(() => created);
        const beginApplicationQuit = vi.fn();
        const closeAll = vi.fn(() => Effect.succeed(cleanReport));
        const all = [created];
        const cloneSessionForWindow = vi.fn(() => cloned);
        const coordinator = createApplicationWindowCoordinator({
          closeAll,
          create,
          focusedWindow: () => null,
          reportFailure: vi.fn(),
          restoreInitial: () => null,
          windows: {
            all: () => all,
            beginApplicationQuit,
            cloneSessionForWindow,
          } as unknown as WindowRuntimeService,
        });

        coordinator.openForRequest(3, { activeProjectSessionId: "session-1" });
        expect(cloneSessionForWindow).toHaveBeenCalledWith(3, {
          activeProjectSessionId: "session-1",
        });
        expect(create).toHaveBeenCalledWith(cloned);
        expect(created.show).toHaveBeenCalledOnce();
        expect(created.focus).toHaveBeenCalledOnce();

        yield* coordinator.prepareQuit;
        expect(beginApplicationQuit).toHaveBeenCalledOnce();
        expect(closeAll).toHaveBeenCalledWith(all);
        coordinator.openForRequest(3, { activeProjectSessionId: "session-1" });
        expect(create).toHaveBeenCalledOnce();
      }),
    );
  });
});

describe("WindowShutdown", () => {
  class FakeWindow extends EventEmitter implements ShutdownWindow {
    readonly id: number;
    closeCalls = 0;
    destroyCalls = 0;
    destroyed = false;
    closeFailure: unknown = undefined;
    destroyFailure: unknown = undefined;

    constructor(id: number) {
      super();
      this.id = id;
    }

    close(): void {
      this.closeCalls += 1;
      if (this.closeFailure !== undefined) throw this.closeFailure;
    }

    destroy(): void {
      this.destroyCalls += 1;
      if (this.destroyFailure !== undefined) throw this.destroyFailure;
      this.destroyed = true;
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    finishClose(): void {
      this.destroyed = true;
      this.emit("closed");
    }
  }

  it.effect("closes every window within a deadline and reports exact escalation", () =>
    Effect.gen(function* () {
      const graceful = new FakeWindow(1);
      const timedOut = new FakeWindow(2);
      const closeThrows = new FakeWindow(3);
      closeThrows.closeFailure = new Error("close failed");
      const destroyThrows = new FakeWindow(4);
      destroyThrows.destroyFailure = new Error("destroy failed");
      const alreadyClosed = new FakeWindow(5);
      alreadyClosed.destroyed = true;
      const shutdown = make("1 second");

      const fiber = yield* shutdown
        .closeAll([graceful, timedOut, closeThrows, destroyThrows, alreadyClosed])
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      graceful.finishClose();
      yield* TestClock.adjust("1 second");
      const report = yield* Fiber.join(fiber);

      expect(report).toEqual({
        alreadyClosed: 1,
        destroyed: 2,
        failed: 1,
        failures: [{ phase: "destroy", reason: "destroy failed", windowId: 4 }],
        graceful: 1,
        total: 5,
      });
      expect(timedOut.destroyCalls).toBe(1);
      expect(closeThrows.destroyCalls).toBe(1);
      expect(destroyThrows.destroyCalls).toBe(1);
      expect(graceful.listenerCount("closed")).toBe(0);
      expect(timedOut.listenerCount("closed")).toBe(0);
      expect(closeThrows.listenerCount("closed")).toBe(0);
      expect(destroyThrows.listenerCount("closed")).toBe(0);
    }),
  );

  it.effect("is idempotent for windows that are already gone", () =>
    Effect.gen(function* () {
      const window = new FakeWindow(7);
      window.destroyed = true;

      const report = yield* make(0).closeAll([window]);

      expect(report.alreadyClosed).toBe(1);
      expect(window.closeCalls).toBe(0);
      expect(window.destroyCalls).toBe(0);
    }),
  );
});

describe("application-window-link-opening", () => {
  describe("trusted application window link fallback", () => {
    function fixture() {
      const contents = new EventEmitter();
      let popup: Parameters<WebContents["setWindowOpenHandler"]>[0] | undefined;
      const open = vi.fn();
      const webContents = Object.assign(contents, {
        setWindowOpenHandler: (handler: typeof popup) => {
          popup = handler;
        },
      }) as unknown as WebContents;
      installApplicationWindowLinkRouting({
        webContents,
        isAppUrl: (url) => url.startsWith("nodex://app/"),
        openLink: open,
      });
      const windowOpen = (url: string, disposition = "default") =>
        popup!({ url, disposition } as Parameters<NonNullable<typeof popup>>[0]);
      return { contents, open, windowOpen };
    }
    test("denies native popups and sends HTTP destinations through the same preference decision", () => {
      const f = fixture();
      expect(f.windowOpen("https://example.com")).toEqual({ action: "deny" });
      const request = f.open.mock.calls[0]![0];
      expect(request).toEqual({
        url: "https://example.com",
        initiator: "window_open",
        disposition: "default",
      });
      expect(resolveLinkOpenRequest({ request, browserAvailable: true })?.target).toBe(
        "external-browser",
      );
      expect(
        resolveLinkOpenRequest({
          request,
          browserAvailable: true,
          preferences: { ...DEFAULT_LINK_OPENING_SETTINGS, openLinkInTarget: "in-app-browser" },
        })?.target,
      ).toBe("in-app-browser");
      f.windowOpen("https://example.com", "background-tab");
      expect(f.open).toHaveBeenLastCalledWith({ ...request, disposition: "new-background-tab" });
      for (const disposition of ["foreground-tab", "new-window", "other"]) {
        f.windowOpen("https://example.com", disposition);
        expect(f.open).toHaveBeenLastCalledWith(request);
      }
    });
    it.effect("reads configured GitHub hosts only for the enabled personal Space", () =>
      Effect.gen(function* () {
        const sources = [
          { kind: "github", enabled: false, config: { host: "GITHUB.EXAMPLE" } },
          { kind: "github", enabled: true, config: { host: "github.com" } },
        ];
        const read = vi.fn(() =>
          Effect.succeed({ value: { kind: "sources", value: { kind: "sources", sources } } }),
        );
        const input = {
          preferences: DEFAULT_LINK_OPENING_SETTINGS,
          personalSpaceId: "personal",
          workspace: { read } as unknown as Parameters<
            typeof readEffectiveLinkOpeningSettings
          >[0]["workspace"],
        };
        for (const settings of [
          { ...input, activeSpaceId: "team" },
          {
            ...input,
            activeSpaceId: undefined,
            preferences: { ...input.preferences, openGitHubThreadsInNodex: false },
          },
        ]) {
          expect((yield* readEffectiveLinkOpeningSettings(settings)).nativeGitHubHosts).toEqual([]);
        }
        expect(read).not.toHaveBeenCalled();
        const effective = yield* readEffectiveLinkOpeningSettings({
          ...input,
          activeSpaceId: undefined,
        });
        expect(effective.nativeGitHubHosts).toEqual(["github.example", "github.com"]);
      }),
    );
    test("forwards a plain GitHub popup unchanged even in a Scene without Browser", () => {
      const f = fixture();
      const url = "https://github.com/org/repo/pull/9/files#r20";
      const preferences = { ...DEFAULT_LINK_OPENING_SETTINGS, nativeGitHubHosts: ["github.com"] };
      f.windowOpen(url);
      const request = f.open.mock.calls[0]![0];
      expect(
        resolveApplicationWindowLinkDestination(request, preferences, { kind: "library" }),
      ).toEqual({
        kind: "workbench",
        request: { url, initiator: "window_open", disposition: "default" },
      });
      expect(
        resolveApplicationWindowLinkDestination(request, DEFAULT_LINK_OPENING_SETTINGS, {
          kind: "library",
        }),
      ).toEqual({ kind: "external", url });
      f.windowOpen(url, "background-tab");
      const background = f.open.mock.calls[1]![0];
      expect(
        resolveApplicationWindowLinkDestination(background, preferences, { kind: "library" }),
      ).toEqual({ kind: "external", url });
    });
    test("opens permitted non-HTTP schemes explicitly externally and rejects unsupported schemes", () => {
      const f = fixture();
      f.windowOpen("mailto:a@example.com");
      expect(f.open).toHaveBeenCalledWith({
        url: "mailto:a@example.com",
        initiator: "window_open",
        openTarget: "external-browser",
      });
      f.open.mockClear();
      for (const url of ["javascript:alert(1)", "data:text/html,hi", "unknown://path"])
        expect(f.windowOpen(url)).toEqual({ action: "deny" });
      expect(f.open).not.toHaveBeenCalled();
    });
    test("keeps app navigation internal and prevents external main-frame navigation before routing it", () => {
      const f = fixture();
      const preventDefault = vi.fn();
      f.contents.emit("will-navigate", { preventDefault }, "nodex://app/index.html");
      expect(preventDefault).not.toHaveBeenCalled();
      f.contents.emit("will-navigate", { preventDefault }, "http://localhost:3000");
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(
        resolveLinkOpenRequest({ request: f.open.mock.calls[0]![0], browserAvailable: true })
          ?.target,
      ).toBe("in-app-browser");
    });
  });
});

describe("window-runtime-lifecycle", () => {
  function primary(
    webContentsId: number,
    overrides: Partial<WindowRuntimeWindowSnapshot> = {},
  ): WindowRuntimeWindowSnapshot {
    return {
      activeSessionId: `session-${webContentsId}`,
      focusSequence: null,
      focused: false,
      kind: "primary",
      layoutRevision: 1,
      rendererGeneration: "generation-1",
      webContentsId,
      windowId: webContentsId,
      windowSessionId: `window-session-${webContentsId}`,
      ...overrides,
    } as WindowRuntimeWindowSnapshot;
  }

  const eligiblePrimary = (window: WindowRuntimeWindowSnapshot): boolean =>
    window.kind === "primary" && window.activeSessionId !== null;

  describe("selectPreferredWindowRuntimeWindow", () => {
    test("prefers focused, then most recently focused eligible windows", () => {
      const snapshot: WindowRuntimeSnapshot = {
        revision: 5,
        windows: [
          primary(1, { focusSequence: 3 }),
          primary(2, { focusSequence: 8 }),
          primary(3, { focusSequence: 5, focused: true }),
        ],
      };

      expect(selectPreferredWindowRuntimeWindow(snapshot, eligiblePrimary)?.webContentsId).toBe(3);
      expect(
        selectPreferredWindowRuntimeWindow(
          {
            ...snapshot,
            windows: snapshot.windows.map((window) => ({ ...window, focused: false })),
          },
          eligiblePrimary,
        )?.webContentsId,
      ).toBe(2);
    });

    test("uses a sole never-focused eligible window and rejects ambiguous candidates", () => {
      const sole = primary(1);
      expect(
        selectPreferredWindowRuntimeWindow({ revision: 0, windows: [sole] }, eligiblePrimary),
      ).toEqual(sole);
      expect(
        selectPreferredWindowRuntimeWindow(
          { revision: 0, windows: [sole, primary(2)] },
          eligiblePrimary,
        ),
      ).toBeNull();
    });
  });
});
