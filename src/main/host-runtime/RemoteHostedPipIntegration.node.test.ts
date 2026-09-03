import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { AvatarOverlayRuntime } from "../avatar/AvatarOverlayRuntime";
import {
  fakeRemoteHostedPipNativePlatform,
  RemoteHostedPipNativePlatform,
} from "../platform/electron/RemoteHostedPipNativePlatform";
import { BrowserUseRuntime } from "./BrowserUseRuntime";
import { ChromeControlRuntime, type ChromeControlRuntimeChange } from "./ChromeControlRuntime";
import { ComputerUseRuntime, type ComputerUseManagedServiceSnapshot } from "./ComputerUseRuntime";
import { RemoteHostedPipRuntime } from "./RemoteHostedPipRuntime";
import { live } from "./RemoteHostedPipIntegration";

it.effect("routes native click, visibility, and avatar events through their semantic owners", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const native = yield* fakeRemoteHostedPipNativePlatform;
    const iabFocus = yield* Deferred.make<{ sessionId: string; tabId: number }>();
    const chromeFocus = yield* Deferred.make<{
      extensionInstanceId: string;
      sessionId: string;
      tabId: string;
    }>();
    const visibilityApplied = yield* Deferred.make<void>();
    const cursorApplied = yield* Deferred.make<void>();
    const chromeReleased = yield* Deferred.make<{
      browserFamily: string;
      extensionInstanceId: string;
    }>();
    const chromeChanges = yield* Queue.unbounded<ChromeControlRuntimeChange>();
    const connectedInstanceChecks: Array<{
      browserFamily: string;
      extensionInstanceId: string;
    }> = [];
    let chromeFocusCallCount = 0;
    let iabFocusCallCount = 0;
    const visibility: Array<{
      taskIds: readonly string[];
      value: "hidden" | "shown";
    }> = [];
    const cursors: Array<{ x: number; y: number } | null> = [];

    const browserUse = BrowserUseRuntime.of({
      availableBackends: () => ["iab"],
      captureRoute: () => Effect.void,
      focusPresentation: (input) =>
        Effect.sync(() => {
          iabFocusCallCount += 1;
        }).pipe(Effect.andThen(Deferred.succeed(iabFocus, input)), Effect.as(true)),
      promoteRoute: () => Effect.void,
      releaseSession: () => Effect.void,
      turnEnded: () => Effect.void,
      turnStarted: () => Effect.void,
    });
    const chrome = ChromeControlRuntime.of({
      available: () => true,
      changes: Stream.fromQueue(chromeChanges),
      focusPresentation: (input) =>
        Effect.sync(() => {
          chromeFocusCallCount += 1;
        }).pipe(Effect.andThen(Deferred.succeed(chromeFocus, input)), Effect.asVoid),
      isConnectedInstance: (browserFamily, extensionInstanceId) => {
        connectedInstanceChecks.push({ browserFamily, extensionInstanceId });
        return true;
      },
      refresh: Effect.succeed({
        bundleSupported: true,
        extensionConnected: true,
        nativeHostInstalled: true,
        providerReady: true,
        reason: null,
        requested: true,
        revision: 1,
        status: "ready",
      }),
      resolveBrowserIconPath: () => null,
      snapshot: () => ({
        bundleSupported: true,
        extensionConnected: true,
        nativeHostInstalled: true,
        providerReady: true,
        reason: null,
        requested: true,
        revision: 1,
        status: "ready",
      }),
    });
    const computerUse = ComputerUseRuntime.of({
      current: () => null,
      ensureReady: Effect.die("unused"),
      managedServiceChanges: Stream.empty,
      managedServiceSnapshot: () => ({ generation: 0, status: "pending" }),
      reconcileManagedService: () => Effect.die("unused"),
    });
    const avatar = AvatarOverlayRuntime.of({
      applyNativeLayoutState: () => Effect.void,
      close: Effect.void,
      handleRendererEvent: () => Effect.succeed(false),
      hide: Effect.void,
      ownsWebContents: () => false,
      setComputerUseCursor: (point) =>
        Effect.sync(() => cursors.push(point)).pipe(
          Effect.andThen(Deferred.succeed(cursorApplied, undefined)),
          Effect.asVoid,
        ),
      toggle: Effect.void,
      wake: Effect.void,
    });
    const remoteHostedPip = RemoteHostedPipRuntime.of({
      deleteTaskVisibility: () => Effect.void,
      diagnosticSnapshot: Effect.succeed([]),
      getAlwaysHide: () => false,
      observeCodexOccurrence: () => Effect.void,
      refresh: Effect.void,
      releaseChromeExtensionInstance: (input) =>
        Deferred.succeed(chromeReleased, input).pipe(Effect.asVoid),
      reportHostLayout: () => Effect.succeed(true),
      resolveBrowserPresentation: (presentationId) => {
        if (presentationId === "iab-presentation") {
          return Effect.succeed({
            backend: "iab" as const,
            browserFamily: null,
            browserId: "iab-browser",
            extensionInstanceId: null,
            presentationId,
            tabId: "7",
            threadId: "thread-iab",
          });
        }
        if (presentationId === "chrome-presentation") {
          return Effect.succeed({
            backend: "chrome" as const,
            browserFamily: "chrome",
            browserId: "chrome-browser",
            extensionInstanceId: "profile-a",
            presentationId,
            tabId: "tab-a",
            threadId: "thread-chrome",
          });
        }
        if (presentationId === "cdp-presentation") {
          return Effect.succeed({
            backend: "cdp" as const,
            browserFamily: null,
            browserId: "cdp-browser",
            extensionInstanceId: null,
            presentationId,
            tabId: "9",
            threadId: "thread-cdp",
          });
        }
        return Effect.succeed(null);
      },
      retireCodexThreads: () => Effect.void,
      retireLocalCodexHost: () => Effect.void,
      revisions: Stream.empty,
      setAlwaysHide: () => Effect.void,
      setMaxDisplaySize: () => Effect.void,
      setTaskVisibilities: (taskIds, value) =>
        Effect.sync(() => visibility.push({ taskIds: [...taskIds], value })).pipe(
          Effect.andThen(Deferred.succeed(visibilityApplied, undefined)),
          Effect.asVoid,
        ),
      setTaskVisibility: () => Effect.void,
      snapshot: Effect.succeed({
        activeTaskIds: [],
        alwaysHidden: false,
        retainedPresentationCount: 0,
        revision: 0,
        taskVisibilityActionAvailable: true,
        taskVisibilities: {},
      }),
    });

    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(AvatarOverlayRuntime, avatar),
            Layer.succeed(BrowserUseRuntime, browserUse),
            Layer.succeed(ChromeControlRuntime, chrome),
            Layer.succeed(ComputerUseRuntime, computerUse),
            Layer.succeed(RemoteHostedPipNativePlatform, native.service),
            Layer.succeed(RemoteHostedPipRuntime, remoteHostedPip),
          ),
        ),
      ),
      scope,
    );
    yield* Effect.yieldNow;

    native.emit({ presentationId: "iab-presentation", type: "browser-content-clicked" });
    assert.deepEqual(yield* Deferred.await(iabFocus), { sessionId: "thread-iab", tabId: 7 });

    native.emit({ presentationId: "chrome-presentation", type: "browser-content-clicked" });
    assert.deepEqual(yield* Deferred.await(chromeFocus), {
      extensionInstanceId: "profile-a",
      sessionId: "thread-chrome",
      tabId: "tab-a",
    });
    assert.deepEqual(connectedInstanceChecks, [
      { browserFamily: "chrome", extensionInstanceId: "profile-a" },
    ]);

    native.emit({ presentationId: "cdp-presentation", type: "browser-content-clicked" });
    yield* Effect.yieldNow;
    assert.strictEqual(iabFocusCallCount, 1);
    assert.strictEqual(chromeFocusCallCount, 1);

    yield* Queue.offer(chromeChanges, {
      connectedInstances: [],
      disconnectedInstances: [
        {
          extensionId: "hehggadaopoacecdllhhajmbjkdcmajg",
          extensionInstanceId: "profile-a",
          family: "chrome",
        },
      ],
      snapshot: {
        bundleSupported: true,
        extensionConnected: false,
        nativeHostInstalled: true,
        providerReady: false,
        reason: "Waiting for a supported ChatGPT browser extension",
        requested: true,
        revision: 2,
        status: "extension-disconnected",
      },
    });
    assert.deepEqual(yield* Deferred.await(chromeReleased), {
      browserFamily: "chrome",
      extensionInstanceId: "profile-a",
    });

    native.emit({
      isVisible: false,
      threadIds: ["thread-a", "thread-b"],
      type: "visibility-requested",
    });
    yield* Deferred.await(visibilityApplied);
    assert.deepEqual(visibility, [{ taskIds: ["thread-a", "thread-b"], value: "hidden" }]);
    native.emit({ isVisible: true, threadIds: [], type: "visibility-requested" });
    yield* Effect.yieldNow;
    assert.strictEqual(visibility.length, 1);

    native.emit({ point: { x: 10, y: 20 }, type: "computer-use-cursor-changed" });
    yield* Deferred.await(cursorApplied);
    assert.deepEqual(cursors, [{ x: 10, y: 20 }]);

    yield* Scope.close(scope, Exit.void);
    native.emit({ point: { x: 30, y: 40 }, type: "computer-use-cursor-changed" });
    yield* Effect.yieldNow;
    assert.deepEqual(cursors, [{ x: 10, y: 20 }]);
  }),
);

it.effect("reconciles a lost Computer Use connection against the exact connected generation", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const native = yield* fakeRemoteHostedPipNativePlatform;
    const firstConnection = yield* Deferred.make<void>();
    const secondConnection = yield* Deferred.make<void>();
    const reconciled: Array<{ generation: number; pid: number }> = [];
    const connectedPids: number[] = [];
    let managedService: ComputerUseManagedServiceSnapshot = {
      executablePath: "/runtime/computer-use",
      generation: 7,
      pid: 7001,
      status: "running",
    };
    const computerUse = ComputerUseRuntime.of({
      current: () => null,
      ensureReady: Effect.die("unused"),
      managedServiceChanges: Stream.make(managedService),
      managedServiceSnapshot: () => managedService,
      reconcileManagedService: (expected) =>
        Effect.sync(() => {
          reconciled.push(expected);
          managedService = {
            executablePath: "/runtime/computer-use",
            generation: 8,
            pid: 8001,
            status: "running",
          };
          return managedService;
        }),
    });
    const nativeService = {
      ...native.service,
      connectHost: (pid: number) =>
        Effect.sync(() => {
          connectedPids.push(pid);
          return true;
        }).pipe(
          Effect.tap(() =>
            Deferred.succeed(
              connectedPids.length === 1 ? firstConnection : secondConnection,
              undefined,
            ),
          ),
        ),
    };

    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(
              AvatarOverlayRuntime,
              AvatarOverlayRuntime.of({} as unknown as AvatarOverlayRuntime["Service"]),
            ),
            Layer.succeed(
              BrowserUseRuntime,
              BrowserUseRuntime.of({} as unknown as BrowserUseRuntime["Service"]),
            ),
            Layer.succeed(
              ChromeControlRuntime,
              ChromeControlRuntime.of({
                changes: Stream.empty,
              } as unknown as ChromeControlRuntime["Service"]),
            ),
            Layer.succeed(ComputerUseRuntime, computerUse),
            Layer.succeed(RemoteHostedPipNativePlatform, nativeService),
            Layer.succeed(
              RemoteHostedPipRuntime,
              RemoteHostedPipRuntime.of({} as unknown as RemoteHostedPipRuntime["Service"]),
            ),
          ),
        ),
      ),
      scope,
    );
    yield* Deferred.await(firstConnection);

    native.emit({ type: "service-connection-lost" });
    yield* Deferred.await(secondConnection);
    assert.deepEqual(reconciled, [{ generation: 7, pid: 7001 }]);
    assert.deepEqual(connectedPids, [7001, 8001]);

    yield* Scope.close(scope, Exit.void);
  }),
);
