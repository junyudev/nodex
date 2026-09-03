import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { BrowserUsePeerAuthorizationMode } from "../../shared/browser-use-host-capability";
import { ScopedCallbackRuntime } from "../app/ScopedCallbackRuntime";
import type { BrowserRuntimeAvailability } from "../codex/browser-runtime-bundle";
import type { ComputerUseRuntimeConfigInput } from "../codex/computer-use-runtime-config";
import {
  canonicalComputerUseExecutablePath,
  ComputerUseHostPlatformError,
  makeComputerUseHostPlatform,
  type ComputerUseHostPlatform,
  type ComputerUseServiceAddon,
} from "../platform/electron/ComputerUseHostPlatform";
import { isMacOSVersionAtLeast } from "../sky-native";

export type ComputerUseRuntimeUnavailableReason =
  | "architecture-unsupported"
  | "helper-invalid"
  | "helper-materialization-failed"
  | "host-services-failed"
  | "macos-version-unsupported"
  | "native-addon-unavailable"
  | "platform-unsupported"
  | "runtime-unavailable";

export type ComputerUseRuntimeResult =
  | {
      readonly appPath: string;
      readonly hostServicesPipePath: string;
      readonly serviceExecutablePath: string;
      readonly status: "available";
    }
  | {
      readonly message: string;
      readonly reason: ComputerUseRuntimeUnavailableReason;
      readonly status: "unavailable";
    };

export type ComputerUseManagedServiceSnapshot =
  | { readonly generation: number; readonly status: "pending" }
  | {
      readonly generation: number;
      readonly message: string;
      readonly reason: ComputerUseRuntimeUnavailableReason;
      readonly status: "unavailable";
    }
  | {
      readonly executablePath: string;
      readonly generation: number;
      readonly status: "ready";
    }
  | {
      readonly executablePath: string;
      readonly generation: number;
      readonly pid: number;
      readonly status: "running";
    }
  | { readonly generation: number; readonly status: "closed" };

export interface ComputerUseManagedServiceIdentity {
  readonly generation: number;
  readonly pid: number;
}

export class ComputerUseRuntimeError extends Schema.TaggedError<ComputerUseRuntimeError>()(
  "ComputerUseRuntimeError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export class ComputerUseRuntime extends Context.Service<
  ComputerUseRuntime,
  {
    readonly current: () => ComputerUseRuntimeResult | null;
    readonly ensureReady: Effect.Effect<ComputerUseRuntimeResult, ComputerUseRuntimeError>;
    readonly managedServiceChanges: Stream.Stream<ComputerUseManagedServiceSnapshot>;
    readonly managedServiceSnapshot: () => ComputerUseManagedServiceSnapshot;
    readonly reconcileManagedService: (
      expected: ComputerUseManagedServiceIdentity,
    ) => Effect.Effect<ComputerUseManagedServiceSnapshot, ComputerUseRuntimeError>;
  }
>()("nodex/main/host-runtime/ComputerUseRuntime") {}

export interface ComputerUseRuntimeOptions {
  readonly browserRuntime: BrowserRuntimeAvailability;
  readonly macOSRelease?: string;
  readonly peerAuthorizationMode: BrowserUsePeerAuthorizationMode;
  readonly platform: NodeJS.Platform;
  readonly runtimeConfig?: () => ComputerUseRuntimeConfigInput;
  readonly runtimeStateHome: string;
  readonly terminateManagedServiceOnDispose?: boolean;
}

interface ComputerUseRuntimeState {
  readonly addon: ComputerUseServiceAddon | null;
  readonly closed: boolean;
  readonly generation: number;
  readonly managedPid: number | null;
  readonly result: ComputerUseRuntimeResult | null;
  readonly serviceExecutablePath: string | null;
}

interface ComputerUseRuntimeLayerOptions extends ComputerUseRuntimeOptions {
  readonly host: ComputerUseHostPlatform;
}

interface ComputerUseRuntimeStart {
  readonly addon: ComputerUseServiceAddon | null;
  readonly result: ComputerUseRuntimeResult;
  readonly serviceExecutablePath: string | null;
}

const initialState: ComputerUseRuntimeState = {
  addon: null,
  closed: false,
  generation: 0,
  managedPid: null,
  result: null,
  serviceExecutablePath: null,
};

const runtimeError = (operation: string, cause: unknown): ComputerUseRuntimeError =>
  new ComputerUseRuntimeError({ operation, cause });

function boundedMessage(error: unknown): string {
  const cause =
    typeof error === "object" && error !== null && "cause" in error
      ? Reflect.get(error, "cause")
      : error;
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, 2_048);
}

const unavailable = (
  reason: ComputerUseRuntimeUnavailableReason,
  message: string,
): ComputerUseRuntimeResult => ({ message, reason, status: "unavailable" });

function projectManagedService(state: ComputerUseRuntimeState): ComputerUseManagedServiceSnapshot {
  if (state.closed) return { generation: state.generation, status: "closed" };
  if (state.managedPid !== null && state.serviceExecutablePath) {
    return {
      executablePath: state.serviceExecutablePath,
      generation: state.generation,
      pid: state.managedPid,
      status: "running",
    };
  }
  if (state.result?.status === "unavailable") {
    return {
      generation: state.generation,
      message: state.result.message,
      reason: state.result.reason,
      status: "unavailable",
    };
  }
  if (state.result?.status === "available" && state.serviceExecutablePath) {
    return {
      executablePath: state.serviceExecutablePath,
      generation: state.generation,
      status: "ready",
    };
  }
  return { generation: state.generation, status: "pending" };
}

const make = (options: ComputerUseRuntimeLayerOptions) =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.Scope;
    const state = yield* SubscriptionRef.make(initialState);
    const readinessGate = yield* Semaphore.make(1);
    const serviceGate = yield* Semaphore.make(1);

    const validateManagedProcess = (
      addon: ComputerUseServiceAddon,
      pid: number,
      executablePath: string,
    ): boolean =>
      options.host.isProcessAlive(pid) &&
      options.host.processMatchesExecutable(addon, pid, executablePath);

    const terminateIfOwned = (
      addon: ComputerUseServiceAddon,
      pid: number,
      executablePath: string,
    ): Effect.Effect<void> => {
      if (!options.terminateManagedServiceOnDispose) return Effect.void;
      if (!validateManagedProcess(addon, pid, executablePath)) return Effect.void;
      return options.host
        .terminateProcess(pid)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not terminate Computer Use service").pipe(
              Effect.annotateLogs({ error: boundedMessage(error) }),
            ),
          ),
        );
    };

    const clearManagedService = serviceGate.withPermits(1)(
      SubscriptionRef.modify(
        state,
        (current) =>
          [
            {
              addon: current.addon,
              executablePath: current.serviceExecutablePath,
              pid: current.managedPid,
            },
            { ...current, managedPid: null },
          ] as const,
      ).pipe(
        Effect.flatMap(({ addon, executablePath, pid }) => {
          if (!addon || !executablePath || pid === null) return Effect.void;
          return terminateIfOwned(addon, pid, executablePath);
        }),
      ),
    );

    const ensureServiceUnlocked = Effect.fn("ComputerUseRuntime.ensureServiceUnlocked")(function* (
      addon: ComputerUseServiceAddon,
      executablePath: string,
    ): Effect.fn.Return<{ readonly pid: number }, ComputerUseRuntimeError> {
      const current = yield* SubscriptionRef.get(state);
      if (current.closed) {
        return yield* runtimeError("service.closed", new Error("Computer Use runtime is closed"));
      }
      if (
        current.managedPid !== null &&
        validateManagedProcess(addon, current.managedPid, executablePath)
      ) {
        return { pid: current.managedPid };
      }

      yield* SubscriptionRef.update(state, (latest) => ({ ...latest, managedPid: null }));
      const pid = yield* options.host
        .spawnService(addon, executablePath)
        .pipe(Effect.mapError((error) => runtimeError("service.spawn", error)));
      if (pid === null || !Number.isSafeInteger(pid) || pid <= 0) {
        return yield* runtimeError(
          "service.spawn",
          new Error("Computer Use native host did not return a valid process ID"),
        );
      }

      const startedAt = yield* Clock.currentTimeMillis;
      const deadline = startedAt + 2_000;
      let now = startedAt;
      while (now < deadline) {
        if (validateManagedProcess(addon, pid, executablePath)) {
          const committed = yield* SubscriptionRef.modify(state, (latest) => {
            if (latest.closed) return [false, latest] as const;
            return [
              true,
              {
                ...latest,
                addon,
                generation: latest.generation + 1,
                managedPid: pid,
                serviceExecutablePath: executablePath,
              },
            ] as const;
          });
          if (committed) return { pid };
          yield* terminateIfOwned(addon, pid, executablePath);
          return yield* runtimeError("service.closed", new Error("Computer Use runtime is closed"));
        }
        yield* Effect.sleep("50 millis");
        now = yield* Clock.currentTimeMillis;
      }

      return yield* runtimeError(
        "service.validate",
        new Error("Computer Use service did not become a valid managed process"),
      );
    });

    const ensureService = (
      addon: ComputerUseServiceAddon,
      executablePath: string,
    ): Effect.Effect<{ readonly pid: number }, ComputerUseRuntimeError> =>
      serviceGate.withPermits(1)(ensureServiceUnlocked(addon, executablePath));

    const reconcileManagedService = Effect.fn("ComputerUseRuntime.reconcileManagedService")(
      function* (
        expected: ComputerUseManagedServiceIdentity,
      ): Effect.fn.Return<ComputerUseManagedServiceSnapshot, ComputerUseRuntimeError> {
        return yield* serviceGate.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* SubscriptionRef.get(state);
            if (current.closed) {
              return yield* runtimeError(
                "service.reconcile.closed",
                new Error("Computer Use runtime is closed"),
              );
            }
            if (current.generation !== expected.generation) {
              return projectManagedService(current);
            }
            if (current.managedPid !== null && current.managedPid !== expected.pid) {
              return projectManagedService(current);
            }
            if (
              current.result?.status !== "available" ||
              !current.addon ||
              !current.serviceExecutablePath
            ) {
              return projectManagedService(current);
            }

            yield* ensureServiceUnlocked(current.addon, current.serviceExecutablePath);
            return projectManagedService(SubscriptionRef.getUnsafe(state));
          }),
        );
      },
    );

    const start: Effect.Effect<ComputerUseRuntimeStart> = Effect.gen(function* () {
      if (options.host.platform !== "darwin") {
        return {
          addon: null,
          result: unavailable(
            "platform-unsupported",
            `Computer Use is unavailable on ${options.host.platform}`,
          ),
          serviceExecutablePath: null,
        };
      }
      const runtime = options.browserRuntime;
      if (runtime.status === "unavailable") {
        return {
          addon: null,
          result: unavailable("runtime-unavailable", runtime.message),
          serviceExecutablePath: null,
        };
      }
      const capability = runtime.bundle.manifest.capabilities.computerUse;
      if (capability.status === "unavailable") {
        return {
          addon: null,
          result: unavailable(
            "architecture-unsupported",
            "Computer Use is unavailable for this architecture",
          ),
          serviceExecutablePath: null,
        };
      }
      if (
        !isMacOSVersionAtLeast(capability.productMinimumMacOSVersion, options.host.macOSRelease)
      ) {
        return {
          addon: null,
          result: unavailable(
            "macos-version-unsupported",
            `Computer Use requires macOS ${capability.productMinimumMacOSVersion} or later`,
          ),
          serviceExecutablePath: null,
        };
      }

      yield* options.host
        .writeRuntimeConfig({
          ...options.runtimeConfig?.(),
          runtimeStateHome: options.runtimeStateHome,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not write Computer Use runtime config").pipe(
              Effect.annotateLogs({ error: boundedMessage(error) }),
            ),
          ),
        );

      const addon = yield* options.host.loadAddon;
      if (!addon) {
        return {
          addon: null,
          result: unavailable(
            "native-addon-unavailable",
            "Computer Use native host is unavailable",
          ),
          serviceExecutablePath: null,
        };
      }
      if (!runtime.bundle.paths.computerUseApp) {
        return {
          addon: null,
          result: unavailable("helper-invalid", "Computer Use helper bundle is missing"),
          serviceExecutablePath: null,
        };
      }

      const helperExit = yield* Effect.exit(
        options.host.materializeApp({
          bundleIdentifier: capability.appBundleIdentifier,
          desktopBuild: runtime.bundle.manifest.desktopBuild,
          runtimeStateHome: options.runtimeStateHome,
          signingTeamId: capability.signingTeamId,
          sourceAppPath: runtime.bundle.paths.computerUseApp,
        }),
      );
      if (Exit.isFailure(helperExit)) {
        return {
          addon: null,
          result: unavailable(
            "helper-materialization-failed",
            `Computer Use helper materialization failed: ${boundedMessage(helperExit.cause)}`,
          ),
          serviceExecutablePath: null,
        };
      }

      const helper = helperExit.value;
      const serviceExecutablePath = canonicalComputerUseExecutablePath(
        helper.serviceExecutablePath,
      );
      const handler = (
        method: string,
        params: unknown,
      ): Effect.Effect<unknown, ComputerUseRuntimeError> => {
        if (method !== "ensureService") {
          return Effect.fail(
            runtimeError(
              "host-services.request",
              new Error(`Unsupported host-services method: ${method}`),
            ),
          );
        }
        const service =
          params && typeof params === "object" ? Reflect.get(params, "service") : null;
        if (service !== "computer-use") {
          return Effect.fail(
            runtimeError("host-services.request", new Error("Unsupported host service")),
          );
        }
        return ensureService(addon, serviceExecutablePath).pipe(Effect.as({}));
      };
      const serverExit = yield* Effect.exit(
        options.host
          .createNativePipeServer(
            (method, params) =>
              handler(method, params).pipe(
                Effect.mapError(
                  (error) =>
                    new ComputerUseHostPlatformError({
                      operation: "native-pipe.request",
                      cause: error,
                    }),
                ),
              ),
            options.peerAuthorizationMode,
            runtime.bundle.paths.peerAuthorization,
          )
          .pipe(Scope.provide(ownerScope)),
      );
      if (Exit.isFailure(serverExit)) {
        return {
          addon: null,
          result: unavailable(
            "host-services-failed",
            `Computer Use host-services pipe failed: ${boundedMessage(serverExit.cause)}`,
          ),
          serviceExecutablePath: null,
        };
      }

      const server = serverExit.value;
      return {
        result: {
          appPath: helper.appPath,
          hostServicesPipePath: server.pipePath,
          serviceExecutablePath,
          status: "available",
        } satisfies ComputerUseRuntimeResult,
        addon,
        serviceExecutablePath,
      };
    });

    const ensureReady = readinessGate.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        if (current.closed) {
          return yield* runtimeError(
            "ensure-ready.closed",
            new Error("Computer Use runtime is closed"),
          );
        }
        if (current.result?.status === "available") return current.result;

        const started = yield* start;
        const committed = yield* SubscriptionRef.modify(state, (latest) => {
          if (latest.closed) return [false, latest] as const;
          return [
            true,
            {
              ...latest,
              addon: started.addon,
              result: started.result,
              serviceExecutablePath: started.serviceExecutablePath,
            },
          ] as const;
        });
        if (committed) return started.result;

        yield* clearManagedService;
        return yield* runtimeError(
          "ensure-ready.closed",
          new Error("Computer Use runtime is closed"),
        );
      }),
    );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* SubscriptionRef.update(state, (current) => ({ ...current, closed: true }));
        const resources = yield* readinessGate.withPermits(1)(
          serviceGate.withPermits(1)(
            SubscriptionRef.modify(
              state,
              (current) =>
                [
                  {
                    addon: current.addon,
                    executablePath: current.serviceExecutablePath,
                    pid: current.managedPid,
                  },
                  {
                    ...current,
                    addon: null,
                    managedPid: null,
                    result: null,
                    serviceExecutablePath: null,
                  },
                ] as const,
            ),
          ),
        );
        const releases: Array<Effect.Effect<void, ComputerUseHostPlatformError>> = [];
        if (
          options.terminateManagedServiceOnDispose &&
          resources.addon &&
          resources.executablePath &&
          resources.pid !== null &&
          validateManagedProcess(resources.addon, resources.pid, resources.executablePath)
        ) {
          releases.push(options.host.terminateProcess(resources.pid));
        }
        const exits = yield* Effect.forEach(releases, Effect.exit, { concurrency: "unbounded" });
        for (const exit of exits) {
          if (Exit.isSuccess(exit)) continue;
          yield* Effect.logWarning("Computer Use runtime cleanup failed").pipe(
            Effect.annotateLogs({ error: boundedMessage(exit.cause) }),
          );
        }
      }),
    );

    return ComputerUseRuntime.of({
      current: () => SubscriptionRef.getUnsafe(state).result,
      ensureReady,
      managedServiceChanges: SubscriptionRef.changes(state).pipe(
        Stream.map(projectManagedService),
        Stream.changes,
      ),
      managedServiceSnapshot: () => projectManagedService(SubscriptionRef.getUnsafe(state)),
      reconcileManagedService,
    });
  });

export const live = (
  options: ComputerUseRuntimeOptions,
): Layer.Layer<ComputerUseRuntime, never, ScopedCallbackRuntime> =>
  Layer.effect(
    ComputerUseRuntime,
    Effect.gen(function* () {
      const callbacks = yield* ScopedCallbackRuntime;
      return yield* make({
        ...options,
        host: makeComputerUseHostPlatform(
          {
            macOSRelease: options.macOSRelease,
            platform: options.platform,
            verifiedSkyNativeAddonPath:
              options.browserRuntime.status === "available"
                ? options.browserRuntime.bundle.paths.skyNativeAddon
                : null,
            verifiedSkyNativeExports:
              options.browserRuntime.status === "available"
                ? options.browserRuntime.bundle.manifest.capabilities.nativePip.exports
                    .expectedExports
                : null,
          },
          callbacks,
        ),
      });
    }),
  );

export const testLayer = (
  options: ComputerUseRuntimeOptions,
  host: ComputerUseHostPlatform,
): Layer.Layer<ComputerUseRuntime> => Layer.effect(ComputerUseRuntime, make({ ...options, host }));
