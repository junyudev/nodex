import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { assert, it } from "@effect/vitest";
import type { CodexExecutionHostSettings, CodexSshExecutionHostConfig } from "../../shared/types";
import { CodexEphemeralThreadRouting } from "../codex-runtime/CodexEphemeralThreadRouting";
import { CodexGateway, CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import type { CodexExecutionHostConfig } from "../codex-runtime/CodexEndpointMap";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import { CoreModules, type CoreModuleClients } from "../core-runtime/CoreModules";
import {
  ExecutionHostRuntime,
  live as executionHostRuntimeLive,
  threadHostResolverLive,
  type ExecutionHostRuntimeFactories,
  type RemoteExecutionHostTransport,
} from "./ExecutionHostRuntime";
import {
  ExecutionHostConfiguration,
  ManagedWorktreeConfiguration,
} from "./ExecutionHostConfiguration";
import { WorktreeWorkerRuntime } from "../host-runtime/WorktreeWorkerRuntime";

const sshHost = (
  id: string,
  managedRoot = `/remote/${id}/worktrees`,
): CodexSshExecutionHostConfig => ({
  id,
  displayName: `Host ${id}`,
  kind: "ssh",
  sshAlias: id,
  port: null,
  managedRoot,
  repositoryRoots: [`/remote/${id}/repos`],
  codexBinary: null,
  codexHome: null,
  enabled: true,
});

it.effect("routes ephemeral Threads before the durable Workspace authority", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const durableReads: string[] = [];
      const core = CoreModules.of({
        workspace: {
          read: (read: { readonly kind: string; readonly thread_id?: string }) =>
            Effect.sync(() => {
              durableReads.push(read.thread_id ?? "");
              return {
                value: {
                  kind: "thread",
                  thread: {
                    backend_binding:
                      read.thread_id === "thread:acp"
                        ? {
                            kind: "acp",
                            agent_definition_id: "claude-code",
                            instance_config_id: null,
                          }
                        : { kind: "codex" },
                    execution_host_id: "remote-durable",
                  },
                },
              } as ProjectWorkspaceReadSnapshot;
            }),
        },
      } as unknown as CoreModuleClients);
      const ephemeral = CodexEphemeralThreadRouting.of({
        resolve: (threadId) =>
          Effect.succeed(threadId === "thread:ephemeral" ? "remote-ephemeral" : null),
        register: () => Effect.void,
        remove: () => Effect.void,
      });
      const context = yield* Layer.build(
        threadHostResolverLive.pipe(
          Layer.provide(
            Layer.merge(
              Layer.succeed(CoreModules, core),
              Layer.succeed(CodexEphemeralThreadRouting, ephemeral),
            ),
          ),
        ),
      );
      const resolver = Context.get(context, CodexThreadHostResolver);

      assert.strictEqual(yield* resolver.resolve("thread:ephemeral"), "remote-ephemeral");
      assert.strictEqual(yield* resolver.resolve("thread:durable"), "remote-durable");
      const rejected = yield* resolver.resolve("thread:acp").pipe(Effect.flip);
      assert.strictEqual(rejected.reason, "request");
      assert.strictEqual(rejected.operation, "thread-host.resolve-backend");
      assert.deepStrictEqual(durableReads, ["thread:durable", "thread:acp"]);
    }),
  ),
);

const makeHarness = (
  failedHostId?: string,
  ensureReady?: (
    config: CodexSshExecutionHostConfig,
    signal?: AbortSignal,
  ) => ReturnType<RemoteExecutionHostTransport["ensureReady"]>,
) => {
  let settings: CodexExecutionHostSettings = { sshHosts: [] };
  const registered = new Map<string, CodexExecutionHostConfig>();
  const removed: string[] = [];
  const shutdowns: string[] = [];
  const failedHosts = new Set(failedHostId ? [failedHostId] : []);
  const unsupported = () => Effect.die(new Error("Unsupported test operation"));
  const gateway = CodexGateway.of({
    localHostId: "local",
    requestRawOnHost: () => Effect.die(new Error("Unsupported raw host request")),
    requestRawForThread: () => Effect.die(new Error("Unsupported raw request")),
    events: Stream.empty,
    requestLocal: unsupported,
    requestOnHost: unsupported,
    requestForThread: unsupported,
    notifyLocal: unsupported,
    connection: unsupported,
    connectionChanges: () => Stream.empty,
    awaitReady: unsupported,
    reconcileHost: (config) =>
      Effect.sync(() => {
        registered.set(config.hostId, config);
      }),
    removeHost: (hostId) =>
      Effect.sync(() => {
        registered.delete(hostId);
        removed.push(hostId);
      }),
    restartHost: unsupported,
  });
  const factories: ExecutionHostRuntimeFactories = {
    makeTransport: ({ config }) =>
      ({
        hostId: config.id,
        config,
        ensureReady: (signal) =>
          ensureReady
            ? ensureReady(config, signal)
            : failedHosts.has(config.id)
              ? Promise.reject(new Error("host unavailable"))
              : Promise.resolve({
                  hostId: config.id,
                  home: `/remote/${config.id}`,
                  codexHome: `/remote/${config.id}/.codex`,
                  platform: "linux",
                  architecture: "arm64",
                  nodeVersion: "v24",
                  gitVersion: "git 2",
                  codexVersion: "codex 1",
                }),
        openWorktreeWorker: () => Promise.reject(new Error("not exercised")),
        appServerClientOptions: () => ({ binaryPath: "ssh", args: [] }),
        describe: () => Promise.reject(new Error("not exercised")),
        download: () => Promise.reject(new Error("not exercised")),
        upload: () => Promise.reject(new Error("not exercised")),
        cleanup: () => Promise.reject(new Error("not exercised")),
      }) satisfies RemoteExecutionHostTransport,
    makeWorker: ({ hostId }) =>
      Effect.acquireRelease(
        Effect.succeed(
          WorktreeWorkerRuntime.of({
            hostId,
            request: () => Effect.die("unused"),
          }),
        ),
        () =>
          Effect.sync(() => {
            shutdowns.push(hostId);
          }),
      ),
  };
  const localWorktreeWorker = WorktreeWorkerRuntime.of({
    hostId: "local",
    request: () => Effect.die("unused"),
  });
  const configuration = ExecutionHostConfiguration.of({
    settings: Effect.sync(() => settings),
    update: (input) =>
      Effect.sync(() => {
        settings = { sshHosts: [...input.sshHosts] };
        return settings;
      }),
  });
  const managedWorktrees = ManagedWorktreeConfiguration.of({
    settings: Effect.succeed({ worktreeRoot: null, autoDeleteEnabled: true, autoDeleteLimit: 15 }),
    update: () => Effect.die("unused"),
  });
  const layer = executionHostRuntimeLive({
    runtimeStateHome: "/profile/agent",
    nodexHome: "/profile",
    remoteWorktreeWorkerBundlePath: "/app/remote-worktree-worker.cjs",
    factories,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(CodexGateway, gateway),
        Layer.succeed(WorktreeWorkerRuntime, localWorktreeWorker),
        Layer.succeed(ExecutionHostConfiguration, configuration),
        Layer.succeed(ManagedWorktreeConfiguration, managedWorktrees),
      ),
    ),
  );
  return { failedHosts, layer, registered, removed, shutdowns };
};

it.effect("owns local and dynamic SSH host resources until its Scope closes", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(harness.layer, scope);
    const hosts = Context.get(context, ExecutionHostRuntime);

    assert.deepEqual(
      (yield* hosts.hosts()).map((host) => host.hostId),
      ["local"],
    );
    yield* hosts.updateSettings({ sshHosts: [sshHost("alpha")] });
    assert.deepEqual(
      (yield* hosts.hosts()).map((host) => host.hostId),
      ["alpha", "local"],
    );
    assert.deepEqual([...harness.registered.keys()], ["alpha"]);

    yield* hosts.updateSettings({ sshHosts: [sshHost("alpha", "/remote/alpha/new")] });
    assert.deepEqual(harness.removed, ["alpha"]);
    assert.deepEqual(harness.shutdowns, ["alpha"]);
    assert.strictEqual((yield* hosts.resolve("alpha")).descriptor.managedRoot, "/remote/alpha/new");
    assert.deepEqual([...(yield* SubscriptionRef.get(hosts.activeSshHosts)).keys()], ["alpha"]);

    yield* Scope.close(scope, Exit.void);
    assert.deepEqual(yield* hosts.hosts(), []);
    assert.deepEqual(harness.removed, ["alpha", "alpha"]);
    assert.deepEqual(harness.shutdowns, ["alpha", "alpha"]);
  }),
);

it.effect("keeps healthy hosts active while reporting unavailable peers", () =>
  Effect.gen(function* () {
    const harness = makeHarness("broken");
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(harness.layer, scope);
    const hosts = Context.get(context, ExecutionHostRuntime);

    const result = yield* Effect.result(
      hosts.updateSettings({ sshHosts: [sshHost("healthy"), sshHost("broken")] }),
    );
    assert.isTrue(Result.isFailure(result));
    assert.deepEqual(
      (yield* hosts.hosts()).map((host) => host.hostId),
      ["healthy", "local"],
    );
    assert.deepEqual([...harness.registered.keys()], ["healthy"]);

    harness.failedHosts.delete("broken");
    yield* hosts.reconcile();
    assert.deepEqual(
      (yield* hosts.hosts()).map((host) => host.hostId),
      ["broken", "healthy", "local"],
    );
    assert.deepEqual([...harness.registered.keys()].sort(), ["broken", "healthy"]);

    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("aborts an SSH health probe when the owning application Scope closes", () =>
  Effect.gen(function* () {
    let observedSignal: AbortSignal | undefined;
    let markProbeStarted: (() => void) | undefined;
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve;
    });
    const harness = makeHarness(undefined, (_config, signal) => {
      observedSignal = signal;
      markProbeStarted?.();
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(harness.layer, scope);
    const hosts = Context.get(context, ExecutionHostRuntime);
    const reconcile = yield* hosts
      .updateSettings({ sshHosts: [sshHost("slow")] })
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => probeStarted);

    yield* Scope.close(scope, Exit.void);

    assert.isTrue(observedSignal?.aborted);
    const reconcileExit = yield* Fiber.await(reconcile);
    assert.isTrue(Exit.isFailure(reconcileExit));
    if (Exit.isFailure(reconcileExit)) assert.isTrue(Cause.hasInterruptsOnly(reconcileExit.cause));
    assert.deepEqual([...harness.registered.keys()], []);
  }),
);
