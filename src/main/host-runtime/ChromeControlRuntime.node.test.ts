import { describe, expect, test, vi } from "vite-plus/test";
import path from "node:path";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolveChromeHostRegistration } from "../browser-use/chrome/ChromeHostRegistrationPolicy";
import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import {
  ChromeHostRegistrationInUse,
  type ChromeNativeHostInstallResult,
} from "../browser-use/chrome/ChromeNativeHostInstaller";
import {
  makeChromeControlRuntime,
  resolveChromeNativeHostNodeModuleDirs,
  type ChromeControlExtensionRegistryPort,
  type ChromeControlRuntimePorts,
  ChromeControlRuntime,
  type ChromeControlRuntimeChange,
} from "./ChromeControlRuntime";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import { AvatarOverlayRuntime } from "../avatar/AvatarOverlayRuntime";
import {
  fakeRemoteHostedPipNativePlatform,
  RemoteHostedPipNativePlatform,
} from "../platform/electron/RemoteHostedPipNativePlatform";
import { BrowserUseRuntime } from "./BrowserUseRuntime";
import { ComputerUseRuntime, type ComputerUseManagedServiceSnapshot } from "./ComputerUseRuntime";
import { RemoteHostedPipRuntime } from "./RemoteHostedPipRuntime";
import { live } from "./RemoteHostedPipIntegration";

describe("ChromeControlRuntime", () => {
  test("projects only the packaged runtime Node module root into the native-host registry", () => {
    expect(
      resolveChromeNativeHostNodeModuleDirs("/runtime", [
        "runtime/lib/node_modules",
        "marketplace/plugins/browser/node_modules",
      ]),
    ).toEqual([path.join("/runtime", "runtime", "lib", "node_modules")]);
  });

  const extensionId = "hehggadaopoacecdllhhajmbjkdcmajg";
  const peerIdentity = { signingIdentifier: "com.openai.chrome-host", teamId: "TESTTEAM1A" };
  const installResult: ChromeNativeHostInstallResult = {
    manifestPaths: ["/profile/chrome/native-messaging.json"],
    nativeHostPath: "/profile/chrome/native-host",
    peerIdentity,
    registryPaths: ["/profile/chrome/chrome-native-hosts-v2.json"],
  };

  function makeRegistry(): ChromeControlExtensionRegistryPort & {
    connect: (extensionInstanceId: string, family?: string) => void;
    disconnect: () => void;
    focused: Array<{ extensionInstanceId: string; sessionId: string; tabId: string }>;
    stopped: boolean;
    subscribed: Promise<void>;
  } {
    let connected: { readonly extensionInstanceId: string; readonly family: string } | null = null;
    let revision = 0;
    const focused: Array<{ extensionInstanceId: string; sessionId: string; tabId: string }> = [];
    const listeners = new Set<Parameters<ChromeControlExtensionRegistryPort["subscribe"]>[0]>();
    let resolveSubscribed: () => void = () => undefined;
    const subscribed = new Promise<void>((resolve) => {
      resolveSubscribed = resolve;
    });
    const snapshot = () => ({
      instances: connected
        ? [
            {
              extensionId,
              extensionInstanceId: connected.extensionInstanceId,
              family: connected.family,
            },
          ]
        : [],
      providerReady: connected !== null,
      revision,
    });
    const publish = () => {
      const next = snapshot();
      for (const listener of listeners) listener(next);
    };
    return {
      connect: (extensionInstanceId, family = "chrome") => {
        connected = { extensionInstanceId, family };
        revision += 1;
        publish();
      },
      disconnect: () => {
        connected = null;
        revision += 1;
        publish();
      },
      focusPresentation: async (input) => {
        focused.push(input);
      },
      focused,
      refresh: async () => snapshot(),
      snapshot,
      start: async () => snapshot(),
      stop() {
        this.stopped = true;
      },
      stopped: false,
      subscribed,
      subscribe(listener) {
        listeners.add(listener);
        resolveSubscribed();
        return () => listeners.delete(listener);
      },
    };
  }

  function makePorts(
    registry: ChromeControlExtensionRegistryPort,
    overrides: Partial<ChromeControlRuntimePorts> = {},
  ): ChromeControlRuntimePorts {
    return {
      browserIconPaths: new Map([["chrome", "/runtime/chrome/assets/google-chrome.png"]]),
      bundleSupported: true,
      registrationKind: "production",
      installNativeHost: async () => installResult,
      makeRegistry: () => registry,
      requested: true,
      runtimeUnavailableReason: null,
      ...overrides,
    };
  }

  it.effect("publishes exact Chrome instance readiness and disconnection changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = makeRegistry();
        let installedPeerIdentity: typeof peerIdentity | null = null;
        const runtime = yield* makeChromeControlRuntime(
          makePorts(registry, {
            makeRegistry: (identity) => {
              installedPeerIdentity = identity;
              return registry;
            },
          }),
        );

        expect(installedPeerIdentity).toEqual(peerIdentity);
        expect(runtime.available()).toBe(false);
        expect(runtime.snapshot()).toMatchObject({
          bundleSupported: true,
          nativeHostInstalled: true,
          providerReady: false,
          requested: true,
          status: "extension-disconnected",
        });
        expect(runtime.resolveBrowserIconPath("chrome")).toBe(
          "/runtime/chrome/assets/google-chrome.png",
        );
        expect(runtime.resolveBrowserIconPath("edge")).toBeNull();

        const changesFiber = yield* runtime.changes.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.promise(() => registry.subscribed);

        registry.connect("profile-a");
        expect(runtime.available()).toBe(true);
        expect(runtime.isConnectedInstance("chrome", "profile-a")).toBe(true);
        expect(runtime.isConnectedInstance("edge", "profile-a")).toBe(false);
        expect(runtime.isConnectedInstance("chrome", "profile-b")).toBe(false);
        yield* runtime.focusPresentation({
          extensionInstanceId: "profile-a",
          sessionId: "thread-1",
          tabId: "7",
        });
        registry.disconnect();

        const changes = yield* Fiber.join(changesFiber);
        expect(changes).toEqual([
          {
            connectedInstances: [
              { extensionId, extensionInstanceId: "profile-a", family: "chrome" },
            ],
            disconnectedInstances: [],
            snapshot: expect.objectContaining({
              providerReady: true,
              revision: 1,
              status: "ready",
            }),
          },
          {
            connectedInstances: [],
            disconnectedInstances: [
              { extensionId, extensionInstanceId: "profile-a", family: "chrome" },
            ],
            snapshot: expect.objectContaining({
              providerReady: false,
              revision: 2,
              status: "extension-disconnected",
            }),
          },
        ]);
        expect(runtime.isConnectedInstance("chrome", "profile-a")).toBe(false);
        expect(registry.focused).toEqual([
          { extensionInstanceId: "profile-a", sessionId: "thread-1", tabId: "7" },
        ]);
      }),
    ),
  );

  it.effect("does not construct a provider when native-host installation fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = makeRegistry();
        let registryCreations = 0;
        const runtime = yield* makeChromeControlRuntime(
          makePorts(registry, {
            installNativeHost: async () => {
              throw new Error("wrong signing team");
            },
            makeRegistry: () => {
              registryCreations += 1;
              return registry;
            },
          }),
        );

        expect(registryCreations).toBe(0);
        expect(runtime.snapshot()).toMatchObject({
          nativeHostInstalled: false,
          providerReady: false,
          reason: "wrong signing team",
          requested: true,
          status: "faulted",
        });
        expect(
          yield* Effect.exit(
            runtime.focusPresentation({
              extensionInstanceId: "profile-a",
              sessionId: "thread-1",
              tabId: "7",
            }),
          ),
        ).toMatchObject({ _tag: "Failure" });
      }),
    ),
  );

  it.effect("reports an unavailable, unrequested bundle without touching installation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = makeRegistry();
        let installs = 0;
        let registryCreations = 0;
        const runtime = yield* makeChromeControlRuntime(
          makePorts(registry, {
            bundleSupported: false,
            installNativeHost: async () => {
              installs += 1;
              return installResult;
            },
            makeRegistry: () => {
              registryCreations += 1;
              return registry;
            },
            requested: false,
            runtimeUnavailableReason: "not-bundled",
          }),
        );

        expect(installs).toBe(0);
        expect(registryCreations).toBe(0);
        expect(runtime.snapshot()).toMatchObject({
          bundleSupported: false,
          reason: "not-bundled",
          requested: false,
          status: "runtime-unavailable",
        });
      }),
    ),
  );

  it.live("leaves the user home untouched when a development instance has no registration", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(tmpdir(), "nodex-chrome-disabled-"))),
          (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
        );
        const originalHome = process.env.HOME;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            process.env.HOME = home;
          }),
          () =>
            Effect.sync(() => {
              if (originalHome === undefined) delete process.env.HOME;
              else process.env.HOME = originalHome;
            }),
        );
        const registration = resolveChromeHostRegistration({
          isPackaged: false,
          platform: "darwin",
          isolatedRunId: "dev",
          homeDirectory: homedir(),
          nodexHome: path.join(home, "profile"),
          personalNodexHome: path.join(home, ".nodex"),
          launchMode: undefined,
          hasScenarioHome: false,
        });
        const installNativeHost = vi.fn(async () => {
          await writeFile(path.join(home, "unexpected-registration"), "");
          return installResult;
        });
        const runtime = yield* makeChromeControlRuntime(
          makePorts(makeRegistry(), {
            installNativeHost,
            registrationKind: registration.kind,
          }),
        );
        expect(runtime.snapshot()).toMatchObject({
          status: "registration-disabled",
          nativeHostInstalled: false,
          providerReady: false,
          reason: expect.stringContaining("--register-browser-host"),
        });
        expect(installNativeHost).not.toHaveBeenCalled();
        expect(yield* Effect.promise(() => readdir(home))).toEqual([]);
      }),
    ),
  );

  it.effect("identifies a temporary registration in Settings and gives it back on close", () =>
    Effect.gen(function* () {
      const releaseRegistration = vi.fn(async () => undefined);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeChromeControlRuntime(
            makePorts(makeRegistry(), {
              installNativeHost: async () => ({ ...installResult, releaseRegistration }),
              registrationKind: "development",
            }),
          );
          expect(runtime.snapshot()).toMatchObject({
            status: "extension-disconnected",
            nativeHostInstalled: true,
            reason: "Registered for this development instance.",
          });
        }),
      );
      expect(releaseRegistration).toHaveBeenCalledOnce();
    }),
  );

  it.effect("reports an existing registration owner without claiming the provider is ready", () =>
    Effect.gen(function* () {
      const runtime = yield* makeChromeControlRuntime(
        makePorts(makeRegistry(), {
          installNativeHost: async () => {
            throw new ChromeHostRegistrationInUse();
          },
        }),
      );
      expect(runtime.snapshot()).toMatchObject({
        status: "registration-in-use",
        nativeHostInstalled: false,
        providerReady: false,
      });
    }),
  );

  it.effect(
    "projects Windows registration conflicts, enables the provider after takeover, and turns it off",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = makeRegistry();
          const runtime = yield* makeChromeControlRuntime(
            makePorts(registry, {
              windows: {
                makeRegistry: () => registry,
                reconcile: async (action) => {
                  if (action?.kind === "disable") return { status: "disabled" };
                  if (action?.kind === "takeover") return { status: "owned", canGiveBack: true };
                  return {
                    status: "registration-in-use",
                    owner: "app",
                    takeoverToken: "test",
                    manifestPaths: ["C:\\Other App\\manifest.json"],
                  };
                },
              },
            }),
          );
          expect(runtime.snapshot()).toMatchObject({
            status: "registration-in-use",
            providerReady: false,
            windows: { owner: "app" },
          });
          expect(
            yield* runtime.updateWindowsRegistration!({ kind: "takeover", token: "test" }),
          ).toMatchObject({
            status: "extension-disconnected",
            windows: { canGiveBack: true },
          });
          registry.connect("windows-instance");
          expect(runtime.snapshot().status).toBe("ready");
          expect(yield* runtime.updateWindowsRegistration!({ kind: "disable" })).toMatchObject({
            status: "disabled",
            providerReady: false,
            requested: false,
          });
          expect(registry.stopped).toBe(true);
        }),
      ),
  );
});

describe("RemoteHostedPipIntegration", () => {
  it.effect(
    "routes native click, visibility, and avatar events through their semantic owners",
    () =>
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
          endSessionActivity: () => Effect.void,
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
          observeRuntimeActivity: () => Effect.void,
          retireRuntimeLease: () => Effect.void,
          retireTasks: () => Effect.void,
          retireLocalCodexHost: () => Effect.void,
          revisions: Stream.empty,
          setAlwaysHide: () => Effect.void,
          setMaxDisplaySize: () => Effect.void,
          setTaskVisibilities: () => Effect.void,
          setNativeTaskVisibilities: (taskIds, value) =>
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

  it.effect(
    "reconciles a lost Computer Use connection against the exact connected generation",
    () =>
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
});
