import { hostCapabilities } from "../../shared/host-capabilities";
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
import {
  readWindowsComputerUseEnabled,
  writeWindowsComputerUseEnabled,
  writeComputerUseRuntimeConfig,
  type ComputerUseRuntimeConfigInput,
} from "../codex/computer-use-runtime-config";
import {
  canonicalComputerUseExecutablePath,
  ComputerUseHostPlatformError,
  makeComputerUseHostPlatform,
  type ComputerUseHostPlatform,
  type MacComputerUseHostPlatform,
  type ComputerUseServiceAddon,
} from "../platform/electron/ComputerUseHostPlatform";
import {
  makeWindowsComputerUseHostPlatform,
  resolveWindowsComputerUse,
  windowsComputerUseTurnKey,
  type WindowsComputerUseHost,
  type WindowsComputerUseTurn,
} from "../platform/electron/WindowsComputerUseHostPlatform";
import type { WindowsDesktopToolsService } from "../platform/node/WindowsDesktopTools";
import { isMacOSVersionAtLeast } from "../sky-native";

export type ComputerUseRuntimeUnavailableReason =
  | "architecture-unsupported"
  | "disabled"
  | "windows-version-unsupported"
  | "helper-invalid"
  | "helper-materialization-failed"
  | "host-services-failed"
  | "macos-version-unsupported"
  | "native-addon-unavailable"
  | "platform-unsupported"
  | "runtime-unavailable";

export type ComputerUseRuntimeResult =
  | {
      readonly platform?: "darwin";
      readonly appPath: string;
      readonly hostServicesPipePath: string;
      readonly serviceExecutablePath: string;
      readonly status: "available";
    }
  | {
      readonly platform: "win32";
      readonly nativePipePath: string;
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
    readonly windows?: {
      readonly enabled: () => boolean;
      readonly setEnabled: (enabled: boolean) => Effect.Effect<void, ComputerUseRuntimeError>;
      readonly observeTurn: (turn: WindowsComputerUseTurn) => Effect.Effect<void>;
      readonly releaseSession: (sessionId: string) => Effect.Effect<void>;
    };
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
  readonly windows?: {
    readonly tools: WindowsDesktopToolsService;
    readonly environment: Readonly<Record<string, string>>;
    readonly ready: Effect.Effect<void>;
  };
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
  readonly host: MacComputerUseHostPlatform;
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

const makeMac = (options: ComputerUseRuntimeLayerOptions) =>
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

    // Once native launch starts, retain the gate until its PID is adopted or
    // terminated. The platform launch and process validation are both bounded.
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
    }, Effect.uninterruptible);

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
      if (
        options.host.platform !== "darwin" ||
        !hostCapabilities(options.host.platform).computerControl
      ) {
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
      if (runtime.bundle.manifest.targetPlatform !== "darwin") {
        return {
          addon: null,
          result: unavailable(
            "platform-unsupported",
            "Computer Use requires its Windows host adapter",
          ),
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
      const { computerUseSigningTeamId } = runtime.bundle.manifest.trust;
      const { computerUseApp, peerAuthorization } = runtime.bundle.paths;
      if (!computerUseApp || !peerAuthorization || !computerUseSigningTeamId) {
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
          signingTeamId: computerUseSigningTeamId,
          sourceAppPath: computerUseApp,
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
            peerAuthorization,
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

const makeWindows = (options: ComputerUseRuntimeOptions, host: WindowsComputerUseHost) =>
  Effect.gen(function* () {
    const gate = yield* Semaphore.make(1);
    const activeTurns = new Map<string, Extract<WindowsComputerUseTurn, { phase: "started" }>>();
    let startup: ReturnType<typeof resolveWindowsComputerUse> | undefined;
    const disabled = unavailable("disabled", "Computer Use is turned off.");
    const preferences = (enabled: boolean) =>
      Effect.tryPromise({
        try: () => writeWindowsComputerUseEnabled(options.runtimeStateHome, enabled),
        catch: (cause) => runtimeError("windows-preference.write", cause),
      });
    let enabled = yield* Effect.tryPromise({
      try: () => readWindowsComputerUseEnabled(options.runtimeStateHome),
      catch: (cause) => runtimeError("windows-preference.read", cause),
    }).pipe(Effect.orElseSucceed(() => false));
    let closed = false;
    let result: ComputerUseRuntimeResult | null = null;
    let listener: {
      readonly scope: Scope.Closeable;
      readonly isListening: () => boolean;
      readonly endTurn: (turn: WindowsComputerUseTurn) => Effect.Effect<void>;
    } | null = null;

    const stop = Effect.suspend(() => {
      const previous = listener;
      listener = null;
      result = null;
      return previous ? Scope.close(previous.scope, Exit.void) : Effect.void;
    });
    yield* Effect.addFinalizer(() =>
      gate.withPermits(1)(
        Effect.sync(() => {
          closed = true;
          activeTurns.clear();
        }).pipe(Effect.andThen(stop)),
      ),
    );

    const start = gate.withPermits(1)(
      Effect.gen(function* () {
        if (closed)
          return yield* runtimeError(
            "ensure-ready.closed",
            new Error("Computer Use runtime is closed"),
          );
        if (!enabled) return disabled;
        if (result?.status === "available" && listener?.isListening()) return result;
        yield* stop;
        startup = resolveWindowsComputerUse(options.browserRuntime, host);
        if (startup.status === "unavailable") return startup;
        yield* Effect.tryPromise({
          try: () =>
            writeComputerUseRuntimeConfig({
              ...options.runtimeConfig?.(),
              runtimeStateHome: options.runtimeStateHome,
            }),
          catch: (cause) => runtimeError("windows-overlay-config.write", cause),
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not write Computer Use runtime config").pipe(
              Effect.annotateLogs({ error: boundedMessage(error) }),
            ),
          ),
        );
        const scope = yield* Scope.make();
        const started = yield* host
          .start(startup.serviceExecutablePath, startup.nodeRepl, activeTurns)
          .pipe(
            Scope.provide(scope),
            Effect.onExit((exit) =>
              Exit.isFailure(exit) ? Scope.close(scope, Exit.void) : Effect.void,
            ),
            Effect.result,
          );
        if (started._tag === "Failure") {
          return unavailable(
            "host-services-failed",
            `Computer Use could not start: ${boundedMessage(started.failure)}`,
          );
        }
        listener = {
          scope,
          isListening: started.success.isListening,
          endTurn: started.success.endTurn,
        };
        result = {
          platform: "win32",
          nativePipePath: started.success.pipePath,
          serviceExecutablePath: startup.serviceExecutablePath,
          status: "available",
        };
        return result;
      }).pipe(Effect.uninterruptible),
    );

    const ensureReady = Effect.suspend(() =>
      !closed && enabled && options.windows?.ready
        ? options.windows.ready.pipe(Effect.andThen(start))
        : start,
    );

    const endTurn = (turn: WindowsComputerUseTurn) =>
      Effect.suspend(() => {
        activeTurns.delete(windowsComputerUseTurnKey(turn));
        return listener?.endTurn(turn) ?? Effect.void;
      });

    // The managed macOS process projection feeds native PiP only.
    const managed = { status: "closed", generation: 0 } as const;
    return ComputerUseRuntime.of({
      current: () =>
        closed
          ? null
          : !enabled
            ? disabled
            : listener?.isListening()
              ? result
              : startup?.status === "unavailable"
                ? startup
                : null,
      ensureReady,
      managedServiceChanges: Stream.succeed(managed),
      managedServiceSnapshot: () => managed,
      reconcileManagedService: () => Effect.succeed(managed),
      windows: {
        enabled: () => enabled,
        setEnabled: (next) =>
          gate.withPermits(1)(
            Effect.gen(function* () {
              if (closed)
                return yield* runtimeError(
                  "set-enabled.closed",
                  new Error("Computer Use runtime is closed"),
                );
              if (next === enabled) return;
              yield* preferences(next);
              enabled = next;
              if (!next) yield* stop;
            }).pipe(Effect.uninterruptible),
          ),
        observeTurn: (turn) =>
          Effect.gen(function* () {
            if (closed) return;
            if (turn.phase === "ended") return yield* endTurn(turn);
            const key = windowsComputerUseTurnKey(turn);
            if (activeTurns.has(key)) return;
            for (const active of activeTurns.values()) {
              if (active.nativeThreadId === turn.nativeThreadId) yield* endTurn(active);
            }
            activeTurns.set(key, turn);
          }),
        releaseSession: (sessionId) =>
          Effect.gen(function* () {
            for (const turn of activeTurns.values()) {
              if (turn.sessionId === sessionId) yield* endTurn(turn);
            }
          }),
      },
    });
  });

export const live = (
  options: ComputerUseRuntimeOptions,
): Layer.Layer<ComputerUseRuntime, never, ScopedCallbackRuntime> =>
  Layer.effect(
    ComputerUseRuntime,
    Effect.gen(function* () {
      if (options.platform === "win32" && options.windows) {
        return yield* makeWindows(
          options,
          makeWindowsComputerUseHostPlatform({
            ...options.windows,
            parentPid: process.pid,
            runtimeStateHome: options.runtimeStateHome,
            get codexCliPath() {
              const runtime = options.browserRuntime;
              return runtime.status === "available" ? runtime.bundle.paths.codexCli : null;
            },
          }),
        );
      }
      const callbacks = yield* ScopedCallbackRuntime;
      return yield* makeMac({
        ...options,
        host: makeComputerUseHostPlatform(
          {
            macOSRelease: options.macOSRelease,
            platform: options.platform,
            serviceLaunchContext:
              options.browserRuntime.status === "available"
                ? {
                    nodePath: options.browserRuntime.bundle.paths.node,
                    codexCliPath: options.browserRuntime.bundle.paths.codexCli,
                    runtimeStateHome: options.runtimeStateHome,
                  }
                : undefined,
            verifiedSkyNativeAddonPath:
              options.browserRuntime.status === "available"
                ? options.browserRuntime.bundle.paths.skyNativeAddon
                : null,
            verifiedSkyNativeExports:
              options.browserRuntime.status === "available"
                ? (options.browserRuntime.bundle.manifest.capabilities.nativePip?.exports
                    .expectedExports ?? null)
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
): Layer.Layer<ComputerUseRuntime> =>
  Layer.effect(
    ComputerUseRuntime,
    "start" in host ? makeWindows(options, host) : makeMac({ ...options, host }),
  );
