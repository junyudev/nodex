import { describe, afterEach, vi } from "vite-plus/test";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { assert, it } from "@effect/vitest";
import { BROWSER_RUNTIME_BUNDLE_DIRECTORY } from "../../shared/browser-runtime-metadata";
import {
  resolveBrowserRuntimeBundle,
  type BrowserRuntimeAvailability,
} from "../codex/browser-runtime-bundle";
import {
  makeTestedBrowserAppServerPair,
  writeBrowserRuntimeFixture,
} from "../codex/browser-runtime-test-fixture";
import {
  ComputerUseHostPlatformError,
  type ComputerUseHostPlatform,
} from "../platform/electron/ComputerUseHostPlatform";
import { ComputerUseRuntime, testLayer } from "./ComputerUseRuntime";
import { DISABLED_DESKTOP_TOOL_REPL_CONFIG } from "../codex/codex-thread-config";
import { DesktopToolRuntime, testLayer as testLayerDesktopToolRuntime } from "./DesktopToolRuntime";
import type { BrowserPluginReconcileResult } from "../codex/browser-plugin-reconciler";

import { live, HostShellEnvironment } from "./HostShellEnvironment";

describe("ComputerUseRuntime", () => {
  const temporaryRoots: string[] = [];

  async function makeRuntimeFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-computer-use-runtime-"));
    temporaryRoots.push(root);
    const runtimeRoot = path.join(root, "runtime");
    const bundleRoot = path.join(runtimeRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY);
    const manifest = writeBrowserRuntimeFixture(bundleRoot);
    const testedPair = makeTestedBrowserAppServerPair({ bundleRoot, manifest });
    const browserRuntime = await resolveBrowserRuntimeBundle({
      appServerIdentity: testedPair.appServer,
      runtimeRoot,
      targetArch: "arm64",
      targetPlatform: "darwin",
      testedPairs: [testedPair],
    });
    if (browserRuntime.status !== "available") throw new Error(browserRuntime.message);
    return { browserRuntime, root };
  }

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  interface HostHarness {
    readonly acquire: ReturnType<typeof vi.fn>;
    readonly host: ComputerUseHostPlatform;
    readonly release: ReturnType<typeof vi.fn>;
    readonly request: () => (
      method: string,
      params: unknown,
    ) => Effect.Effect<unknown, ComputerUseHostPlatformError>;
    readonly spawn: ReturnType<typeof vi.fn>;
    readonly terminate: ReturnType<typeof vi.fn>;
    readonly writeConfig: ReturnType<typeof vi.fn>;
  }

  function makeHost(overrides: Partial<ComputerUseHostPlatform> = {}): HostHarness {
    let requestHandler:
      | ((method: string, params: unknown) => Effect.Effect<unknown, ComputerUseHostPlatformError>)
      | null = null;
    const acquire = vi.fn();
    const release = vi.fn();
    const spawn = vi.fn();
    const terminate = vi.fn();
    const writeConfig = vi.fn();
    const addon = {
      computerUseServiceProcessMatchesExecutablePath: () => true,
      spawnComputerUseService: async () => 8123,
    };
    const host: ComputerUseHostPlatform = {
      createNativePipeServer: (handler) =>
        Effect.gen(function* () {
          acquire();
          requestHandler = handler;
          yield* Effect.addFinalizer(() => Effect.sync(release));
          return {
            pipePath: "/tmp/host-services.sock",
          };
        }),
      isProcessAlive: () => true,
      loadAddon: Effect.succeed(addon),
      macOSRelease: "15.0",
      materializeApp: () =>
        Effect.succeed({
          appPath: "/runtime/Codex Computer Use.app",
          serviceExecutablePath: path.resolve(
            "/runtime/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
          ),
        }),
      platform: "darwin",
      processMatchesExecutable: () => true,
      spawnService: () => Effect.sync(() => (spawn(), 8123)),
      terminateProcess: (pid) => Effect.sync(() => void terminate(pid)),
      writeRuntimeConfig: (input) =>
        Effect.sync(() => {
          writeConfig(input);
          return "/runtime/config.json";
        }),
      ...overrides,
    };
    return {
      acquire,
      host,
      release,
      request: () => {
        if (!requestHandler) throw new Error("Missing native-pipe request handler");
        return requestHandler;
      },
      spawn,
      terminate,
      writeConfig,
    };
  }

  const buildRuntime = (input: {
    readonly host: ComputerUseHostPlatform;
    readonly root: string;
    readonly browserRuntime: BrowserRuntimeAvailability;
    readonly terminateManagedServiceOnDispose?: boolean;
  }) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        testLayer(
          {
            get browserRuntime() {
              return input.browserRuntime;
            },
            peerAuthorizationMode: "disabled",
            platform: "darwin",
            runtimeStateHome: path.join(input.root, "state"),
            terminateManagedServiceOnDispose: input.terminateManagedServiceOnDispose,
          },
          input.host,
        ),
        scope,
      );
      return { runtime: Context.get(context, ComputerUseRuntime), scope };
    });

  it.effect("owns readiness, native requests, managed service, and release in one Scope", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => makeRuntimeFixture());
      const harness = makeHost();
      let browserRuntime: BrowserRuntimeAvailability = {
        status: "unavailable",
        reason: "not-installed",
        message: "Desktop Tools are not installed.",
      };
      const { runtime, scope } = yield* buildRuntime({
        root: fixture.root,
        host: harness.host,
        get browserRuntime() {
          return browserRuntime;
        },
      });
      assert.deepEqual(runtime.managedServiceSnapshot(), { generation: 0, status: "pending" });
      assert.deepEqual(yield* runtime.ensureReady, {
        status: "unavailable",
        reason: "runtime-unavailable",
        browserRuntimeUnavailableReason: "not-installed",
        message: "Desktop Tools are not installed.",
      });
      browserRuntime = fixture.browserRuntime;

      const expected = {
        appPath: "/runtime/Codex Computer Use.app",
        hostServicesPipePath: "/tmp/host-services.sock",
        serviceExecutablePath: path.resolve(
          "/runtime/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
        ),
        status: "available" as const,
      };
      const results = yield* Effect.all([runtime.ensureReady, runtime.ensureReady], {
        concurrency: 2,
      });
      assert.deepEqual(results, [expected, expected]);
      assert.deepEqual(runtime.current(), expected);
      assert.deepEqual(runtime.managedServiceSnapshot(), {
        executablePath: expected.serviceExecutablePath,
        generation: 0,
        status: "ready",
      });
      assert.strictEqual(harness.acquire.mock.calls.length, 1);
      assert.strictEqual(harness.writeConfig.mock.calls.length, 1);

      const request = harness.request();
      yield* Effect.all([
        request("ensureService", { service: "computer-use" }),
        request("ensureService", { service: "computer-use" }),
      ]);
      assert.strictEqual(harness.spawn.mock.calls.length, 1);
      assert.deepEqual(runtime.managedServiceSnapshot(), {
        executablePath: expected.serviceExecutablePath,
        generation: 1,
        pid: 8123,
        status: "running",
      });
      const rejected = yield* Effect.exit(request("ensureService", { service: "browser" }));
      assert.isTrue(Exit.isFailure(rejected));

      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(harness.release.mock.calls.length, 1);
      assert.isNull(runtime.current());
      assert.deepEqual(runtime.managedServiceSnapshot(), { generation: 1, status: "closed" });
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runtime.ensureReady)));
    }),
  );

  it.effect("publishes generation-fenced managed-service transitions", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => makeRuntimeFixture());
      const harness = makeHost();
      const { runtime, scope } = yield* buildRuntime({ ...fixture, host: harness.host });
      const transitions = yield* Effect.forkChild(
        runtime.managedServiceChanges.pipe(Stream.take(3), Stream.runCollect),
      );
      yield* Effect.yieldNow;

      yield* runtime.ensureReady;
      yield* harness.request()("ensureService", { service: "computer-use" });

      assert.deepEqual(yield* Fiber.join(transitions), [
        { generation: 0, status: "pending" },
        {
          executablePath: path.resolve(
            "/runtime/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
          ),
          generation: 0,
          status: "ready",
        },
        {
          executablePath: path.resolve(
            "/runtime/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
          ),
          generation: 1,
          pid: 8123,
          status: "running",
        },
      ]);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("respawns an invalid exact process and fences stale loss reconciliation", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => makeRuntimeFixture());
      const livePids = new Set([5001, 5002]);
      const pids = [5001, 5002];
      const harness = makeHost({
        isProcessAlive: (pid) => livePids.has(pid),
        processMatchesExecutable: (_addon, pid) => livePids.has(pid),
        spawnService: () => Effect.succeed(pids.shift() ?? null),
      });
      const { runtime, scope } = yield* buildRuntime({ ...fixture, host: harness.host });
      yield* runtime.ensureReady;
      const request = harness.request();

      yield* request("ensureService", { service: "computer-use" });
      yield* request("ensureService", { service: "computer-use" });
      assert.deepEqual(pids, [5002]);
      livePids.delete(5001);
      const reconciled = yield* runtime.reconcileManagedService({ generation: 1, pid: 5001 });
      assert.deepEqual(pids, []);
      assert.deepEqual(reconciled, {
        executablePath: path.resolve(
          "/runtime/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
        ),
        generation: 2,
        pid: 5002,
        status: "running",
      });
      assert.deepEqual(
        yield* runtime.reconcileManagedService({ generation: 1, pid: 5001 }),
        reconciled,
      );
      assert.deepEqual(pids, []);

      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("uses the Effect clock while waiting for a spawned service to become valid", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => makeRuntimeFixture());
      let valid = false;
      const harness = makeHost({
        isProcessAlive: () => valid,
        processMatchesExecutable: () => valid,
      });
      const { runtime, scope } = yield* buildRuntime({ ...fixture, host: harness.host });
      yield* runtime.ensureReady;
      const service = yield* Effect.forkChild(
        harness.request()("ensureService", { service: "computer-use" }),
      );
      yield* Effect.yieldNow;
      assert.strictEqual(harness.spawn.mock.calls.length, 1);

      yield* TestClock.adjust("49 millis");
      valid = true;
      yield* TestClock.adjust("1 millis");
      assert.deepEqual(yield* Fiber.join(service), {});
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("fences a late native-pipe start before closing the owning Scope", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => makeRuntimeFixture());
      const releaseStart = yield* Deferred.make<void>();
      let closeCount = 0;
      const harness = makeHost({
        createNativePipeServer: () =>
          Effect.acquireRelease(
            Deferred.await(releaseStart).pipe(Effect.as({ pipePath: "/tmp/late.sock" })),
            () => Effect.sync(() => void (closeCount += 1)),
          ),
      });
      const { runtime, scope } = yield* buildRuntime({ ...fixture, host: harness.host });
      const ready = yield* Effect.forkChild(runtime.ensureReady);
      yield* Effect.yieldNow;
      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseStart, undefined);

      assert.isTrue(Exit.isFailure(yield* Fiber.await(ready)));
      yield* Fiber.join(closing);
      assert.strictEqual(closeCount, 1);
      assert.isNull(runtime.current());
    }),
  );

  it.effect("terminates only an exact managed process when explicitly requested", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => makeRuntimeFixture());
      const harness = makeHost();
      const { runtime, scope } = yield* buildRuntime({
        ...fixture,
        host: harness.host,
        terminateManagedServiceOnDispose: true,
      });
      yield* runtime.ensureReady;
      yield* harness.request()("ensureService", { service: "computer-use" });
      yield* Scope.close(scope, Exit.void);

      assert.strictEqual(harness.terminate.mock.calls.length, 1);
      assert.deepEqual(harness.terminate.mock.calls[0], [8123]);
    }),
  );

  it.effect(
    "releases a late launched helper when its request is interrupted during Profile close",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() => makeRuntimeFixture());
        const launchStarted = yield* Deferred.make<void>();
        const finishLaunch = yield* Deferred.make<void>();
        const harness = makeHost({
          spawnService: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(launchStarted, undefined);
              yield* Deferred.await(finishLaunch);
              return 8123;
            }),
        });
        const { runtime, scope } = yield* buildRuntime({
          ...fixture,
          host: harness.host,
          terminateManagedServiceOnDispose: true,
        });
        yield* runtime.ensureReady;
        const request = yield* Effect.forkChild(
          harness.request()("ensureService", { service: "computer-use" }),
        );
        yield* Deferred.await(launchStarted);
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(request));
        const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
        yield* Effect.yieldNow;
        yield* Deferred.succeed(finishLaunch, undefined);
        yield* Fiber.join(interrupting);
        yield* Fiber.join(closing);
        assert.isTrue(Exit.isFailure(yield* Fiber.await(request)));
        assert.deepEqual(harness.terminate.mock.calls, [[8123]]);
        assert.strictEqual(runtime.managedServiceSnapshot().status, "closed");
      }),
  );
});

describe("DesktopToolRuntime", () => {
  const testLayer = testLayerDesktopToolRuntime;

  it.effect(
    "host Desktop Tools reconcile before provisioning and independently gate plugin capabilities",
    () =>
      Effect.gen(function* () {
        const root = mkdtempSync(path.join(tmpdir(), "nodex-host-desktop-tools-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(root, { recursive: true, force: true })),
        );
        const bundleRoot = path.join(root, BROWSER_RUNTIME_BUNDLE_DIRECTORY);
        const manifest = writeBrowserRuntimeFixture(bundleRoot);
        const testedPair = makeTestedBrowserAppServerPair({ bundleRoot, manifest });
        const browserRuntime = yield* Effect.promise(() =>
          resolveBrowserRuntimeBundle({
            appServerIdentity: testedPair.appServer,
            runtimeRoot: root,
            targetArch: "arm64",
            targetPlatform: "darwin",
            testedPairs: [testedPair],
          }),
        );
        assert.equal(browserRuntime.status, "available");
        const computerUse = {
          status: "available" as const,
          appPath: "/state/helper.app",
          hostServicesPipePath: "/state/host.sock",
          serviceExecutablePath: "/state/service",
        };
        let chromeReady = false;
        let browserReady = true;
        let computerReady = true;
        let pluginResult: BrowserPluginReconcileResult | null = null;
        const readiness: string[] = [];
        const runtimeStateHome = path.join(root, "state");
        const runtime = yield* DesktopToolRuntime.pipe(
          Effect.provide(
            testLayer({
              browserRuntime,
              codexHome: "/codex",
              codexDesktopToolsCompatible: () => false,
              runtimeStateHome,
              availableBackends: () => ["iab", "chrome"],
              computerUse: ComputerUseRuntime.of({
                current: () => computerUse,
                ensureReady: Effect.sync(() => {
                  readiness.push("helper");
                  return computerUse;
                }),
                managedServiceChanges: Stream.empty,
                managedServiceSnapshot: () => ({ generation: 0, status: "pending" }),
                reconcileManagedService: () => Effect.succeed({ generation: 0, status: "pending" }),
              }),
              plugins: () =>
                Effect.succeed({
                  ensureInstalled: Effect.sync(() => {
                    readiness.push("plugins");
                    pluginResult = {
                      status: "ready",
                      enabled: browserReady,
                      installedVersion: "1.0.0-test",
                      marketplaceRoot: "/reconciled/marketplace",
                      chrome: chromeReady
                        ? {
                            status: "ready",
                            enabled: true,
                            installedVersion: "1.0.0-test",
                            pluginRoot: "/reconciled/chrome",
                          }
                        : {
                            status: "unavailable",
                            reason: "backend-unavailable",
                            message: "unavailable",
                          },
                      computerUse: computerReady
                        ? {
                            status: "ready",
                            enabled: true,
                            installedVersion: "1.0.0-test",
                            pluginRoot: "/reconciled/computer-use",
                          }
                        : {
                            status: "unavailable",
                            reason: "capability-unavailable",
                            message: "unavailable",
                          },
                    };
                    return pluginResult;
                  }),
                  result: Effect.sync(() => pluginResult),
                }),
              artifactTemplatePickerEnabled: Effect.die(
                "host tools must not prepare artifact templates",
              ),
              listPlugins: () => Effect.die("host tools must not inspect foreign plugins"),
              listSkills: () => Effect.die("host tools must not inspect artifact templates"),
              readConfigRequirements: Effect.succeed({
                requirements: null,
                supportsIndependentSpeedModes: false,
              }),
            }),
          ),
        );
        assert.deepEqual(
          yield* runtime.threadConfig("/workspace"),
          DISABLED_DESKTOP_TOOL_REPL_CONFIG,
        );
        assert.deepEqual(readiness, []);
        // Host provisioning starts with no reconciled plugin result.
        assert.isNull(pluginResult);
        const tools = yield* runtime.desktopTools;
        assert.deepEqual(readiness, ["helper", "plugins"]);
        assert.deepEqual(tools?.pluginRoots, [
          path.join("/reconciled/marketplace", "plugins", "browser"),
          "/reconciled/computer-use",
        ]);
        assert.equal(tools?.server.env.BROWSER_USE_AVAILABLE_BACKENDS, "iab");
        assert.isUndefined(tools?.server.env.NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME);
        chromeReady = true;
        const all = yield* runtime.desktopTools;
        assert.deepEqual(all?.pluginRoots, [
          path.join("/reconciled/marketplace", "plugins", "browser"),
          "/reconciled/chrome",
          "/reconciled/computer-use",
        ]);
        assert.equal(all?.server.env.BROWSER_USE_AVAILABLE_BACKENDS, "iab,chrome");
        browserReady = false;
        chromeReady = false;
        computerReady = false;
        assert.isNull(yield* runtime.desktopTools);
      }).pipe(Effect.scoped),
  );
});

describe("HostShellEnvironment", () => {
  it.effect("coalesces discovery within one Scope and rejects admission after release", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      let loads = 0;
      const context = yield* Layer.buildWithScope(
        live({
          baseEnvironment: { PATH: "/usr/bin" },
          platform: "darwin",
          loadInteractiveEnvironment: async () => {
            loads += 1;
            return { PATH: "/opt/bin:/usr/bin" };
          },
        }),
        scope,
      );
      const runtime = Context.get(context, HostShellEnvironment);
      const [first, second] = yield* Effect.all([runtime.load, runtime.recover], {
        concurrency: "unbounded",
      });
      assert.strictEqual(first.PATH, "/opt/bin:/usr/bin");
      assert.deepEqual(second, { status: "captured", environment: { PATH: "/opt/bin:/usr/bin" } });
      assert.strictEqual(loads, 1);

      yield* Scope.close(scope, Exit.void);
      const afterClose = yield* Effect.exit(runtime.load);
      assert.strictEqual(afterClose._tag, "Failure");
    }),
  );

  it.effect("interrupts active discovery when its Scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const context = yield* Layer.buildWithScope(
        live({
          baseEnvironment: { PATH: "/usr/bin" },
          platform: "darwin",
          loadInteractiveEnvironment: (signal) =>
            new Promise<NodeJS.ProcessEnv>((_resolve, reject) => {
              markStarted?.();
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
        }),
        scope,
      );
      const runtime = Context.get(context, HostShellEnvironment);
      const fiber = yield* Effect.forkChild(runtime.load);
      yield* Effect.promise(() => started);
      yield* Scope.close(scope, Exit.void);
      const exit = yield* Fiber.await(fiber);
      assert.strictEqual(exit._tag, "Failure");
    }),
  );

  it.effect("bounds a stalled login shell and aborts the underlying capture", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        live({
          platform: "darwin",
          baseEnvironment: { PATH: "/usr/bin" },
          loadInteractiveEnvironment: (signal) =>
            new Promise((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
        }),
      );
      const shell = Context.get(context, HostShellEnvironment);
      const capture = yield* Effect.forkChild(shell.recover);
      yield* TestClock.adjust("25 seconds");
      assert.deepEqual(yield* Fiber.join(capture), {
        status: "failed",
        reason: "timeout",
        message: "Login shell exceeded 25 seconds",
      });
    }).pipe(Effect.scoped),
  );
});
