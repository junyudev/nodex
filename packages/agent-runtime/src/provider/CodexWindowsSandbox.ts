import type {
  WindowsSandboxSetupCompletedNotification,
  WindowsSandboxSetupMode,
} from "@nodex/codex-app-server-protocol/v2";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type * as CodexClient from "effect-codex-app-server/client";
import type { AgentWindowsSandboxState } from "../nodex/WindowsSandboxContract.ts";

type Client = CodexClient.CodexAppServerClient["Service"];
type Open = Effect.Effect<Client, unknown, Scope.Scope>;

export const WINDOWS_SANDBOX_NOT_APPLICABLE: AgentWindowsSandboxState = {
  generation: "not-applicable",
  status: "notApplicable",
  mode: null,
  failure: null,
  allowedModes: [],
};

const modes = ["elevated", "unelevated"] as const;

/** A fresh process is required after setup: readiness reads the server's startup config. */
const probe = (open: Open) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* open;
      const readiness = yield* client.request("windowsSandbox/readiness", undefined);
      const { requirements } = yield* client.request("configRequirements/read", undefined);
      const allowed = requirements?.allowedWindowsSandboxImplementations;
      return {
        status: readiness.status,
        allowedModes: modes.filter((mode) => allowed == null || allowed.includes(mode)),
      };
    }),
  ).pipe(Effect.timeout("20 seconds"));

/**
 * The client factory owns these per-instance setup endpoints alongside execution endpoints.
 * Each attempt has its own process Scope, notification listener and bounded completion wait.
 * There is no setup cancellation RPC: cancellation retires that endpoint and its waiter.
 */
export const makeCodexWindowsSandbox = Effect.fn("makeCodexWindowsSandbox")(function* (
  platform: NodeJS.Platform,
) {
  const epoch = yield* Effect.sync(() => globalThis.crypto.randomUUID());
  let nextGeneration = 0;
  const newGeneration = () => `${epoch}:${++nextGeneration}`;
  const endpoints = new Map<
    string,
    {
      readonly retire: Effect.Effect<void>;
      readonly read: (refresh?: boolean) => Effect.Effect<AgentWindowsSandboxState>;
      readonly setup: (mode: WindowsSandboxSetupMode) => Effect.Effect<AgentWindowsSandboxState>;
      readonly cancel: (generation: string) => Effect.Effect<AgentWindowsSandboxState>;
    }
  >();

  const register = Effect.fn("CodexWindowsSandbox.register")(function* (
    instanceId: string,
    open: Open,
  ) {
    if (platform !== "win32") return;
    const ownerScope = yield* Scope.fork(yield* Effect.scope);
    const state = yield* Ref.make<AgentWindowsSandboxState>({
      generation: newGeneration(),
      status: "checking",
      mode: null,
      failure: null,
      allowedModes: [],
    });
    const lock = yield* Semaphore.make(1);
    let active: Fiber.Fiber<void> | undefined;
    const replace = Effect.fnUntraced(function* (
      status: AgentWindowsSandboxState["status"],
      mode: WindowsSandboxSetupMode | null,
    ) {
      if (active) yield* Fiber.interrupt(active);
      const generation = newGeneration();
      yield* Ref.update(state, (current) => ({
        ...current,
        generation,
        status,
        mode,
        failure: null,
      }));
      return generation;
    });
    const publish = (generation: string, patch: Partial<AgentWindowsSandboxState>) =>
      Ref.update(state, (current) =>
        current.generation === generation ? { ...current, ...patch } : current,
      );
    const refresh = Effect.fnUntraced(function* () {
      const generation = yield* replace("checking", null);
      active = yield* probe(open).pipe(
        Effect.flatMap((result) => publish(generation, { ...result, failure: null })),
        Effect.catch(() => publish(generation, { status: "failed", failure: "checkFailed" })),
        Effect.interruptible,
        Effect.forkIn(ownerScope),
      );
      return yield* Ref.get(state);
    });
    const endpoint = {
      retire: Scope.close(ownerScope, Exit.void),
      read: (force = false) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.status === "settingUp" || (current.status !== "checking" && !force))
            return current;
          if (active && !force) return current;
          return yield* refresh();
        }).pipe(Effect.uninterruptible, lock.withPermits(1)),
      setup: (mode: WindowsSandboxSetupMode) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.status === "settingUp") return current;
          if (!current.allowedModes.includes(mode)) return current;
          const generation = yield* replace("settingUp", mode);
          active = yield* Effect.scoped(
            Effect.gen(function* () {
              const client = yield* open;
              const completion = yield* Deferred.make<WindowsSandboxSetupCompletedNotification>();
              // Register before setupStart; completion can precede the request response.
              yield* client.handleServerNotification(
                "windowsSandbox/setupCompleted",
                (notification) =>
                  notification.mode === mode
                    ? Deferred.succeed(completion, {
                        mode: notification.mode,
                        success: notification.success,
                        error: notification.error ?? null,
                      })
                    : Effect.void,
              );
              // Omit cwd: account setup must not grant writes to the application directory.
              const { started } = yield* client.request("windowsSandbox/setupStart", { mode });
              if (!started) return false;
              const result = yield* Effect.raceFirst(
                Deferred.await(completion),
                client.raw.termination ?? Effect.never,
              );
              if (!result.success) {
                // Only classify cancellation; never forward the helper's arbitrary error text.
                const cancelled =
                  result.error?.startsWith("orchestrator_helper_launch_canceled:") === true;
                yield* publish(generation, {
                  status: "failed",
                  failure: cancelled ? "cancelled" : "setupFailed",
                });
                return false;
              }
              return true;
            }),
          ).pipe(
            Effect.timeoutOption("20 minutes"),
            Effect.flatMap((result) =>
              Effect.gen(function* () {
                if (result._tag === "None") {
                  yield* publish(generation, { status: "failed", failure: "timeout" });
                  return;
                }
                if (!result.value) {
                  const latest = yield* Ref.get(state);
                  if (latest.status === "failed") return;
                }
                const checked = yield* probe(open);
                yield* publish(generation, { ...checked, failure: null });
              }),
            ),
            Effect.catch(() => publish(generation, { status: "failed", failure: "setupFailed" })),
            Effect.interruptible,
            Effect.forkIn(ownerScope),
          );
          return yield* Ref.get(state);
        }).pipe(Effect.uninterruptible, lock.withPermits(1)),
      cancel: (generation: string) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.generation !== generation || current.status !== "settingUp") return current;
          yield* replace("failed", current.mode);
          yield* Ref.update(state, (value) => ({ ...value, failure: "cancelled" as const }));
          return yield* Ref.get(state);
        }).pipe(Effect.uninterruptible, lock.withPermits(1)),
    };
    const previous = endpoints.get(instanceId);
    if (previous) yield* previous.retire;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (endpoints.get(instanceId) === endpoint) endpoints.delete(instanceId);
      }),
    );
    endpoints.set(instanceId, endpoint);
  });

  return {
    register,
    read: (instanceId: string, refresh = false) =>
      endpoints.get(instanceId)?.read(refresh) ?? Effect.succeed(WINDOWS_SANDBOX_NOT_APPLICABLE),
    setup: (instanceId: string, mode: WindowsSandboxSetupMode) =>
      endpoints.get(instanceId)?.setup(mode) ?? Effect.succeed(WINDOWS_SANDBOX_NOT_APPLICABLE),
    cancel: (instanceId: string, generation: string) =>
      endpoints.get(instanceId)?.cancel(generation) ??
      Effect.succeed(WINDOWS_SANDBOX_NOT_APPLICABLE),
  };
});

export type CodexWindowsSandbox = Effect.Success<ReturnType<typeof makeCodexWindowsSandbox>>;

/** Check the physical execution endpoint, never a cached setup success from another process. */
export const requireCodexWindowsSandbox = (client: Client) =>
  client.request("windowsSandbox/readiness", undefined).pipe(
    Effect.timeout("20 seconds"),
    Effect.flatMap(({ status }) =>
      status === "ready"
        ? Effect.void
        : Effect.fail(new Error("Codex needs Windows sandbox setup before this turn can start.")),
    ),
    Effect.mapError(
      () => new Error("Codex needs Windows sandbox setup before this turn can start."),
    ),
  );
