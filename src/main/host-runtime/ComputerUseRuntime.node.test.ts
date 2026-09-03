import fs from "node:fs";
import os from "node:os";
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
import { afterEach, vi } from "vite-plus/test";
import { BROWSER_RUNTIME_BUNDLE_DIRECTORY } from "../../shared/browser-runtime-metadata";
import { resolveBrowserRuntimeBundle } from "../codex/browser-runtime-bundle";
import {
  makeTestedBrowserAppServerPair,
  writeBrowserRuntimeFixture,
} from "../codex/browser-runtime-test-fixture";
import {
  ComputerUseHostPlatformError,
  type ComputerUseHostPlatform,
} from "../platform/electron/ComputerUseHostPlatform";
import { ComputerUseRuntime, testLayer } from "./ComputerUseRuntime";

const temporaryRoots: string[] = [];

function makeRuntimeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-computer-use-runtime-"));
  temporaryRoots.push(root);
  const runtimeRoot = path.join(root, "runtime");
  const bundleRoot = path.join(runtimeRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY);
  const manifest = writeBrowserRuntimeFixture(bundleRoot);
  const testedPair = makeTestedBrowserAppServerPair({ bundleRoot, manifest });
  const browserRuntime = resolveBrowserRuntimeBundle({
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
        serviceExecutablePath:
          "/runtime/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
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
  readonly browserRuntime: ReturnType<typeof makeRuntimeFixture>["browserRuntime"];
  readonly terminateManagedServiceOnDispose?: boolean;
}) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      testLayer(
        {
          browserRuntime: input.browserRuntime,
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
    const fixture = makeRuntimeFixture();
    const harness = makeHost();
    const { runtime, scope } = yield* buildRuntime({ ...fixture, host: harness.host });
    assert.deepEqual(runtime.managedServiceSnapshot(), { generation: 0, status: "pending" });

    const expected = {
      appPath: "/runtime/Codex Computer Use.app",
      hostServicesPipePath: "/tmp/host-services.sock",
      serviceExecutablePath: "/runtime/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
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
    const fixture = makeRuntimeFixture();
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
        executablePath: "/runtime/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
        generation: 0,
        status: "ready",
      },
      {
        executablePath: "/runtime/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
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
    const fixture = makeRuntimeFixture();
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
      executablePath: "/runtime/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
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
    const fixture = makeRuntimeFixture();
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
    const fixture = makeRuntimeFixture();
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
    const fixture = makeRuntimeFixture();
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

it.effect("projects unsupported hosts without acquiring native resources", () =>
  Effect.gen(function* () {
    const fixture = makeRuntimeFixture();
    const harness = makeHost({ platform: "linux" });
    const { runtime, scope } = yield* buildRuntime({ ...fixture, host: harness.host });

    assert.deepEqual(yield* runtime.ensureReady, {
      message: "Computer Use is unavailable on linux",
      reason: "platform-unsupported",
      status: "unavailable",
    });
    assert.strictEqual(harness.acquire.mock.calls.length, 0);
    assert.strictEqual(harness.writeConfig.mock.calls.length, 0);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("keeps runtime availability best-effort when config publication fails", () =>
  Effect.gen(function* () {
    const fixture = makeRuntimeFixture();
    const harness = makeHost({
      writeRuntimeConfig: () =>
        Effect.fail(
          new ComputerUseHostPlatformError({
            operation: "config.write",
            cause: new Error("read-only profile"),
          }),
        ),
    });
    const { runtime, scope } = yield* buildRuntime({ ...fixture, host: harness.host });

    assert.strictEqual((yield* runtime.ensureReady).status, "available");
    yield* Scope.close(scope, Exit.void);
  }),
);
