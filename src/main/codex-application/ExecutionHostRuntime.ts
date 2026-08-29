import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type {
  CodexExecutionHostSettings,
  CodexSshExecutionHostConfig,
  UpdateCodexExecutionHostSettingsInput,
} from "../../shared/types";
import { CodexEphemeralThreadRouting } from "../codex-runtime/CodexEphemeralThreadRouting";
import { CodexGateway, CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { CoreModules } from "../core-runtime/CoreModules";
import {
  CODEX_APP_LOCAL_HOST_DISPLAY_NAME,
  CODEX_APP_LOCAL_HOST_ID,
} from "../codex/codex-app-meta-thread-tools";
import {
  CodexLocalExecutionHostFileTransfer,
  type CodexExecutionHostFileDescriptor,
  type CodexExecutionHostFileTransferPort,
} from "../codex/codex-execution-host-file-transfer";
import { makeCodexRemoteWorktreeWorker } from "../codex/codex-remote-worktree-worker";
import {
  CodexSshExecutionHostTransport,
  type CodexSshExecutionHostHealth,
} from "../codex/codex-ssh-execution-host";
import type {
  CodexWorktreeWorkerOperation,
  CodexWorktreeWorkerRequest,
} from "../codex/codex-worktree-worker-protocol";
import {
  type WorktreeWorkerRequestOptions,
  WorktreeWorkerRuntime,
  type WorktreeWorkerSuccessValue,
} from "../host-runtime/WorktreeWorkerRuntime";
import { getLogger } from "../logging/logger";
import { makeCodexProcessExecutionHost } from "../platform/node/CodexProcessExecutionHost";
import {
  ExecutionHostConfiguration,
  ManagedWorktreeConfiguration,
} from "./ExecutionHostConfiguration";

const WORKTREE_CAPABILITIES = [
  "create",
  "list",
  "inspect",
  "snapshot",
  "remove",
  "restore",
  "set-owner",
  "prepare-handoff",
  "rollback-handoff",
  "cleanup-handoff",
  "export-handoff",
  "import-handoff",
  "cleanup-transfer-handoff",
] as const satisfies readonly CodexWorktreeWorkerOperation[];

export interface RemoteExecutionHostTransport extends CodexExecutionHostFileTransferPort {
  readonly hostId: string;
  readonly config: CodexSshExecutionHostConfig;
  readonly ensureReady: (signal?: AbortSignal) => Promise<CodexSshExecutionHostHealth>;
  readonly openWorktreeWorker: (signal?: AbortSignal) => Promise<ChildProcessWithoutNullStreams>;
  readonly appServerClientOptions: CodexSshExecutionHostTransport["appServerClientOptions"];
}

export interface ExecutionHostRuntimeFactories {
  readonly makeTransport: (input: {
    readonly config: CodexSshExecutionHostConfig;
    readonly workerBundlePath: string;
  }) => RemoteExecutionHostTransport;
  readonly makeWorker: (input: {
    readonly hostId: string;
    readonly openWorker: (signal: AbortSignal) => Promise<ChildProcessWithoutNullStreams>;
    readonly onInfrastructureError: (error: Error) => void;
  }) => Effect.Effect<WorktreeWorkerRuntime["Service"], never, Scope.Scope>;
}

export interface ExecutionHostRuntimeOptions {
  readonly runtimeStateHome: string;
  readonly nodexHome: string;
  readonly remoteWorktreeWorkerBundlePath: string;
  readonly factories?: ExecutionHostRuntimeFactories;
}

export interface ExecutionHostDescriptor {
  readonly hostId: string;
  readonly displayName: string;
  readonly kind: "local" | "ssh";
  readonly nodexHome: string;
  readonly codexHome: string;
  readonly managedRoot: string;
  readonly handoffStagingRoot: string;
  readonly repositoryRoots: readonly string[];
  readonly capabilities: readonly CodexWorktreeWorkerOperation[];
  readonly supportsFileTransfer: boolean;
}

export interface ExecutionHostFileTransfer {
  readonly describe: (
    sourcePath: string,
  ) => Effect.Effect<CodexExecutionHostFileDescriptor, ExecutionHostRuntimeError>;
  readonly download: (input: {
    readonly source: CodexExecutionHostFileDescriptor;
    readonly destinationPath: string;
  }) => Effect.Effect<CodexExecutionHostFileDescriptor, ExecutionHostRuntimeError>;
  readonly upload: (input: {
    readonly localPath: string;
    readonly operationId: string;
    readonly fileName: string;
    readonly sha256: string;
    readonly size: number;
  }) => Effect.Effect<CodexExecutionHostFileDescriptor, ExecutionHostRuntimeError>;
  readonly cleanup: (operationId: string) => Effect.Effect<void, ExecutionHostRuntimeError>;
}

export interface ExecutionHost {
  readonly descriptor: ExecutionHostDescriptor;
  readonly transfer: ExecutionHostFileTransfer | null;
  readonly request: <Operation extends CodexWorktreeWorkerOperation>(
    request: Extract<CodexWorktreeWorkerRequest, { readonly operation: Operation }>,
    options?: WorktreeWorkerRequestOptions,
  ) => Effect.Effect<WorktreeWorkerSuccessValue<Operation>, ExecutionHostRuntimeError>;
}

export class ExecutionHostRuntimeError extends Schema.TaggedError<ExecutionHostRuntimeError>()(
  "ExecutionHostRuntimeError",
  {
    operation: Schema.String,
    hostId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {}

export class ExecutionHostRuntime extends Context.Service<
  ExecutionHostRuntime,
  {
    readonly activeSshHosts: SubscriptionRef.SubscriptionRef<
      ReadonlyMap<string, CodexSshExecutionHostConfig>
    >;
    readonly hosts: (
      operation?: CodexWorktreeWorkerOperation,
    ) => Effect.Effect<readonly ExecutionHostDescriptor[]>;
    readonly get: (hostId: string) => Effect.Effect<ExecutionHost | null>;
    readonly resolve: (
      hostId: string,
      operation?: CodexWorktreeWorkerOperation,
    ) => Effect.Effect<ExecutionHost, ExecutionHostRuntimeError>;
    readonly updateLocalManagedRoot: (
      managedRoot: string,
    ) => Effect.Effect<void, ExecutionHostRuntimeError>;
    readonly settings: Effect.Effect<CodexExecutionHostSettings, ExecutionHostRuntimeError>;
    readonly updateSettings: (
      input: UpdateCodexExecutionHostSettingsInput,
    ) => Effect.Effect<CodexExecutionHostSettings, ExecutionHostRuntimeError>;
    readonly reconcile: (
      settings?: CodexExecutionHostSettings,
    ) => Effect.Effect<void, ExecutionHostRuntimeError>;
  }
>()("nodex/main/codex-application/ExecutionHostRuntime") {}

interface RegisteredExecutionHost {
  readonly descriptor: ExecutionHostDescriptor;
  readonly worker: WorktreeWorkerRuntime["Service"];
  readonly transfer: CodexExecutionHostFileTransferPort | null;
}

class ActiveRemoteHost extends Context.Service<
  ActiveRemoteHost,
  {
    readonly config: CodexSshExecutionHostConfig;
    readonly worker: WorktreeWorkerRuntime["Service"];
  }
>()("nodex/main/codex-application/ExecutionHostRuntime/ActiveRemoteHost") {}

const defaultFactories: ExecutionHostRuntimeFactories = {
  makeTransport: (input) => new CodexSshExecutionHostTransport(input),
  makeWorker: makeCodexRemoteWorktreeWorker,
};

const sameConfig = (
  left: CodexSshExecutionHostConfig | undefined,
  right: CodexSshExecutionHostConfig | undefined,
): boolean =>
  left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right);

export const live = (
  options: ExecutionHostRuntimeOptions,
): Layer.Layer<
  ExecutionHostRuntime,
  ExecutionHostRuntimeError,
  CodexGateway | WorktreeWorkerRuntime | ExecutionHostConfiguration | ManagedWorktreeConfiguration
> =>
  Layer.effect(
    ExecutionHostRuntime,
    Effect.gen(function* () {
      const gateway = yield* CodexGateway;
      const localWorktreeWorker = yield* WorktreeWorkerRuntime;
      const configuration = yield* ExecutionHostConfiguration;
      const managedWorktreeConfiguration = yield* ManagedWorktreeConfiguration;
      const factories = options.factories ?? defaultFactories;
      const logger = getLogger({ component: "execution-host-runtime" });
      const runtimeStateHome = path.resolve(options.runtimeStateHome);
      const nodexHome = path.resolve(options.nodexHome);
      const remoteWorktreeWorkerBundlePath = path.resolve(options.remoteWorktreeWorkerBundlePath);
      const error = (operation: string, cause: unknown, hostId?: string) =>
        new ExecutionHostRuntimeError({ operation, cause, ...(hostId ? { hostId } : {}) });
      const activeSshHosts = yield* SubscriptionRef.make<
        ReadonlyMap<string, CodexSshExecutionHostConfig>
      >(new Map());
      const desiredSshHosts = yield* Ref.make<ReadonlyMap<string, CodexSshExecutionHostConfig>>(
        new Map(),
      );
      const registrations = yield* Ref.make<ReadonlyMap<string, RegisteredExecutionHost>>(
        new Map(),
      );
      const mutationLock = yield* Semaphore.make(1);

      const register = (registration: RegisteredExecutionHost) =>
        Effect.gen(function* () {
          const hostId = registration.descriptor.hostId.trim();
          if (!hostId) return yield* error("register-host", new Error("Host id is required"));
          if (registration.worker.hostId !== hostId) {
            return yield* error(
              "register-host",
              new Error("Worktree worker identity does not match its execution host"),
              hostId,
            );
          }
          yield* Ref.update(registrations, (current) => new Map(current).set(hostId, registration));
        });
      const unregister = (hostId: string, worker: WorktreeWorkerRuntime["Service"]) =>
        Ref.modify(registrations, (current) => {
          const normalized = hostId.trim();
          if (current.get(normalized)?.worker !== worker) return [false, current] as const;
          const next = new Map(current);
          next.delete(normalized);
          return [true, next] as const;
        });
      const transferCapability = (
        hostId: string,
        port: CodexExecutionHostFileTransferPort | null,
      ): ExecutionHostFileTransfer | null => {
        if (!port) return null;
        const attempt = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>) =>
          Effect.tryPromise({
            try: run,
            catch: (cause) => error(`transfer-${operation}`, cause, hostId),
          });
        return {
          describe: (sourcePath) =>
            attempt("describe", (signal) => port.describe(sourcePath, signal)),
          download: (input) => attempt("download", (signal) => port.download({ ...input, signal })),
          upload: (input) => attempt("upload", (signal) => port.upload({ ...input, signal })),
          cleanup: (operationId) =>
            Effect.tryPromise({
              try: () => port.cleanup(operationId),
              catch: (cause) => error("transfer-cleanup", cause, hostId),
            }),
        };
      };
      const capability = (registration: RegisteredExecutionHost): ExecutionHost => {
        const hostId = registration.descriptor.hostId;
        return {
          descriptor: { ...registration.descriptor },
          transfer: transferCapability(hostId, registration.transfer),
          request: (request, requestOptions) =>
            registration.worker
              .request(request, requestOptions)
              .pipe(
                Effect.mapError((cause) => error(`worktree-${request.operation}`, cause, hostId)),
              ),
        };
      };
      const hosts = (operation?: CodexWorktreeWorkerOperation) =>
        Ref.get(registrations).pipe(
          Effect.map((current) =>
            [...current.values()]
              .filter((host) => !operation || host.descriptor.capabilities.includes(operation))
              .map((host) => ({ ...host.descriptor }))
              .sort((left, right) => left.displayName.localeCompare(right.displayName)),
          ),
        );
      const get = (hostId: string) =>
        Ref.get(registrations).pipe(
          Effect.map((current) => {
            const registration = current.get(hostId.trim());
            return registration ? capability(registration) : null;
          }),
        );
      const resolve = (hostId: string, operation?: CodexWorktreeWorkerOperation) =>
        get(hostId).pipe(
          Effect.flatMap((host) => {
            const normalized = hostId.trim();
            if (!host) {
              return Effect.fail(
                error(
                  "resolve-host",
                  new Error(`Execution host is unavailable: ${normalized || "<empty>"}`),
                  normalized,
                ),
              );
            }
            if (!operation || host.descriptor.capabilities.includes(operation)) {
              return Effect.succeed(host);
            }
            return Effect.fail(
              error(
                "resolve-host-capability",
                new Error(`Execution host ${normalized} does not support worktree ${operation}`),
                normalized,
              ),
            );
          }),
        );

      const managedWorktreeSettings = yield* managedWorktreeConfiguration.settings.pipe(
        Effect.mapError((cause) => error("read-managed-worktree-settings", cause)),
      );
      const localManagedRoot =
        managedWorktreeSettings.worktreeRoot ?? path.join(nodexHome, "worktrees");
      const handoffStagingRoot = path.join(runtimeStateHome, "handoffs");
      const localFileTransfer = new CodexLocalExecutionHostFileTransfer({
        hostId: CODEX_APP_LOCAL_HOST_ID,
        stagingRoot: handoffStagingRoot,
        allowedReadRoots: [runtimeStateHome, localManagedRoot],
      });
      yield* register({
        descriptor: {
          hostId: CODEX_APP_LOCAL_HOST_ID,
          displayName: CODEX_APP_LOCAL_HOST_DISPLAY_NAME ?? "Local",
          kind: "local",
          nodexHome,
          codexHome: runtimeStateHome,
          managedRoot: localManagedRoot,
          handoffStagingRoot,
          repositoryRoots: [],
          capabilities: WORKTREE_CAPABILITIES,
          supportsFileTransfer: true,
        },
        worker: localWorktreeWorker,
        transfer: localFileTransfer,
      });
      yield* Effect.addFinalizer(() =>
        unregister(CODEX_APP_LOCAL_HOST_ID, localWorktreeWorker).pipe(Effect.asVoid),
      );

      const releaseRemoteHost = (host: ActiveRemoteHost["Service"]): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* unregister(host.config.id, host.worker);
          const release = yield* gateway.removeHost(host.config.id).pipe(Effect.result);
          yield* SubscriptionRef.update(activeSshHosts, (current) => {
            const next = new Map(current);
            next.delete(host.config.id);
            return next;
          });
          if (release._tag === "Success") return;
          yield* Effect.logWarning("Could not fully release SSH execution host").pipe(
            Effect.annotateLogs({ hostId: host.config.id, cause: String(release.failure) }),
          );
        });

      const remoteHostLayer = (
        hostId: string,
      ): Layer.Layer<ActiveRemoteHost, ExecutionHostRuntimeError> =>
        Layer.unwrap(
          Ref.get(desiredSshHosts).pipe(
            Effect.map((desired) => {
              const config = desired.get(hostId);
              if (!config) {
                return Layer.effect(
                  ActiveRemoteHost,
                  Effect.fail(
                    error("resolve-config", new Error("Execution host is not desired"), hostId),
                  ),
                );
              }
              return Layer.effect(
                ActiveRemoteHost,
                Effect.acquireRelease(
                  Effect.gen(function* () {
                    const transport = yield* Effect.try({
                      try: () =>
                        factories.makeTransport({
                          config,
                          workerBundlePath: remoteWorktreeWorkerBundlePath,
                        }),
                      catch: (cause) => error("construct-transport", cause, hostId),
                    });
                    const health = yield* Effect.tryPromise({
                      try: (signal) => transport.ensureReady(signal),
                      catch: (cause) => error("prepare", cause, hostId),
                    });
                    const worker = yield* factories.makeWorker({
                      hostId,
                      openWorker: (signal) => transport.openWorktreeWorker(signal),
                      onInfrastructureError: (cause) => {
                        logger.error("Remote worktree worker failed", {
                          hostId,
                          error: cause.message,
                        });
                      },
                    });
                    const host = ActiveRemoteHost.of({ config, worker });
                    yield* Effect.gen(function* () {
                      const endpointConfig = yield* Effect.try({
                        try: () =>
                          makeCodexProcessExecutionHost(hostId, transport.appServerClientOptions()),
                        catch: (cause) => error("configure-endpoint", cause, hostId),
                      });
                      yield* gateway
                        .reconcileHost(endpointConfig)
                        .pipe(
                          Effect.mapError((cause) => error("register-endpoint", cause, hostId)),
                        );
                      yield* register({
                        descriptor: {
                          hostId,
                          displayName: config.displayName,
                          kind: "ssh",
                          nodexHome: path.posix.join(health.home, ".nodex"),
                          codexHome: health.codexHome,
                          managedRoot: config.managedRoot,
                          handoffStagingRoot: path.posix.join(health.codexHome, "nodex-handoffs"),
                          repositoryRoots: [...config.repositoryRoots],
                          capabilities: WORKTREE_CAPABILITIES,
                          supportsFileTransfer: true,
                        },
                        worker,
                        transfer: transport,
                      });
                      yield* SubscriptionRef.update(activeSshHosts, (current) => {
                        const next = new Map(current);
                        next.set(hostId, config);
                        return next;
                      });
                    }).pipe(
                      Effect.onError(() =>
                        unregister(hostId, worker).pipe(
                          Effect.andThen(gateway.removeHost(hostId).pipe(Effect.ignore)),
                        ),
                      ),
                    );
                    return host;
                  }),
                  releaseRemoteHost,
                  { interruptible: true },
                ),
              );
            }),
          ),
        );

      const remoteHosts = yield* LayerMap.make(remoteHostLayer, { idleTimeToLive: "Infinity" });
      const readSettings = configuration.settings.pipe(
        Effect.mapError((cause) => error("read-settings", cause)),
      );
      const reconcileUnlocked = Effect.fn("ExecutionHostRuntime.reconcileUnlocked")(function* (
        settings: CodexExecutionHostSettings,
      ) {
        const desired = new Map(
          settings.sshHosts.filter((host) => host.enabled).map((host) => [host.id, host]),
        );
        const active = yield* SubscriptionRef.get(activeSshHosts);
        yield* Ref.set(desiredSshHosts, desired);
        const staleHostIds = [...active.entries()].flatMap(([hostId, config]) =>
          sameConfig(config, desired.get(hostId)) ? [] : [hostId],
        );
        yield* Effect.forEach(staleHostIds, remoteHosts.invalidate, {
          concurrency: "unbounded",
          discard: true,
        });
        yield* Effect.forEach(
          [...desired.keys()].filter((hostId) => !active.has(hostId)),
          remoteHosts.invalidate,
          { concurrency: "unbounded", discard: true },
        );
        const outcomes = yield* Effect.forEach(
          [...desired.keys()],
          (hostId) =>
            Effect.scoped(remoteHosts.contextEffect(hostId)).pipe(
              Effect.matchEffect({
                onFailure: (cause) =>
                  remoteHosts.invalidate(hostId).pipe(Effect.as({ hostId, cause })),
                onSuccess: () => Effect.succeed(null),
              }),
            ),
          { concurrency: 2 },
        );
        const failures = outcomes.flatMap((outcome) => (outcome ? [outcome] : []));
        if (failures.length === 0) return;
        return yield* error(
          "reconcile",
          new AggregateError(
            failures.map(
              ({ hostId, cause }) =>
                new Error(`Could not activate SSH execution host ${hostId}: ${cause.message}`, {
                  cause,
                }),
            ),
            "One or more SSH execution hosts are unavailable",
          ),
        );
      });
      const reconcile = (settings?: CodexExecutionHostSettings) =>
        (settings === undefined ? readSettings : Effect.succeed(settings)).pipe(
          Effect.flatMap(reconcileUnlocked),
          mutationLock.withPermits(1),
        );

      return ExecutionHostRuntime.of({
        activeSshHosts,
        hosts,
        get,
        resolve,
        updateLocalManagedRoot: (managedRoot) =>
          Effect.gen(function* () {
            const normalized = managedRoot.trim();
            if (!normalized) {
              return yield* error(
                "update-local-managed-root",
                new Error("Execution host managed root is required"),
                CODEX_APP_LOCAL_HOST_ID,
              );
            }
            yield* Ref.update(registrations, (current) => {
              const local = current.get(CODEX_APP_LOCAL_HOST_ID);
              if (!local) return current;
              return new Map(current).set(CODEX_APP_LOCAL_HOST_ID, {
                ...local,
                descriptor: { ...local.descriptor, managedRoot: normalized },
                transfer: new CodexLocalExecutionHostFileTransfer({
                  hostId: CODEX_APP_LOCAL_HOST_ID,
                  stagingRoot: handoffStagingRoot,
                  allowedReadRoots: [runtimeStateHome, normalized],
                }),
              });
            });
          }),
        settings: readSettings,
        reconcile,
        updateSettings: (input) =>
          configuration.update(input).pipe(
            Effect.mapError((cause) => error("update-settings", cause)),
            Effect.tap(reconcileUnlocked),
            mutationLock.withPermits(1),
          ),
      });
    }),
  );

/** Resolves routing from Core's durable Workspace authority, never from RPC payload heuristics. */
export const threadHostResolverLive: Layer.Layer<
  CodexThreadHostResolver,
  never,
  CodexEphemeralThreadRouting | CoreModules
> = Layer.effect(
  CodexThreadHostResolver,
  Effect.gen(function* () {
    const ephemeral = yield* CodexEphemeralThreadRouting;
    const core = yield* CoreModules;
    return CodexThreadHostResolver.of({
      resolve: (threadId) =>
        ephemeral.resolve(threadId).pipe(
          Effect.flatMap((ephemeralHostId) => {
            if (ephemeralHostId) return Effect.succeed(ephemeralHostId);
            return core.workspace.read({ kind: "thread", thread_id: threadId }).pipe(
              Effect.mapError((cause) =>
                codexRuntimeError({
                  operation: "thread-host.resolve",
                  reason: "host-unavailable",
                  retryable: cause.retryable,
                  cause,
                }),
              ),
              Effect.flatMap((snapshot) =>
                snapshot.value.kind === "thread"
                  ? Effect.succeed(snapshot.value.thread.execution_host_id)
                  : Effect.fail(
                      codexRuntimeError({
                        operation: "thread-host.resolve-variant",
                        reason: "protocol",
                        retryable: false,
                        cause: new Error("Core returned a non-thread Workspace read variant"),
                      }),
                    ),
              ),
            );
          }),
        ),
    });
  }),
);
