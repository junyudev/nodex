import { ProviderInstanceId, type ProviderInstanceConfigMap } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Registry from "../provider/ProviderInstanceRegistryMutator.ts";
import * as Sessions from "../orchestration-v2/ProviderSessionManager.ts";

interface ConfigurationPorts {
  readonly busyInstances: Effect.Effect<ReadonlySet<ProviderInstanceId>, Error>;
  readonly closeIdleInstance: (id: ProviderInstanceId) => Effect.Effect<void, Error>;
  readonly reconcile: (config: ProviderInstanceConfigMap) => Effect.Effect<void>;
}

/** Keeps configuration closure-owned and retains an active native instance until its work ends. */
export const makeWithPorts = Effect.fn("AgentRuntime.ProviderConfiguration")(function* (
  initial: ProviderInstanceConfigMap,
  ports: ConfigurationPorts,
) {
  const desired = yield* Ref.make(initial);
  const current = yield* Ref.make(initial);
  const lane = yield* Semaphore.make(1);
  const processScope = yield* Effect.scope;
  const refresh = Effect.gen(function* () {
    const before = yield* Ref.get(current);
    const wanted = yield* Ref.get(desired);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(wanted)])]
      .filter(
        (id) => !Equal.equals(before[id as ProviderInstanceId], wanted[id as ProviderInstanceId]),
      )
      .map((id) => ProviderInstanceId.make(id));
    if (changed.length === 0) return { applied: true, deferredInstanceIds: [] as string[] };
    const busy = yield* ports.busyInstances;
    const next = { ...wanted };
    const deferredInstanceIds: string[] = [];
    for (const id of changed) {
      const old = before[id];
      if (old !== undefined && busy.has(id)) {
        next[id] = old;
        deferredInstanceIds.push(id);
        continue;
      }
      if (old !== undefined) yield* ports.closeIdleInstance(id);
    }
    yield* ports.reconcile(next);
    yield* Ref.set(current, next);
    return { applied: deferredInstanceIds.length === 0, deferredInstanceIds };
  });
  yield* lane
    .withPermits(1)(refresh)
    .pipe(
      Effect.catch(() =>
        Effect.logWarning("Deferred provider configuration could not be applied."),
      ),
      Effect.repeat(Schedule.spaced("1 second")),
      Effect.forkScoped,
    );
  return {
    withSuspended: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      lane.withPermits(1)(
        Effect.acquireUseRelease(
          Ref.get(current).pipe(Effect.tap(() => ports.reconcile({}))),
          () => effect,
          (saved) => (processScope.state._tag === "Closed" ? Effect.void : ports.reconcile(saved)),
        ),
      ),
    configure: (config: ProviderInstanceConfigMap) =>
      lane.withPermits(1)(Ref.set(desired, config).pipe(Effect.andThen(refresh))),
  };
});

export const make = Effect.fn("AgentRuntime.makeProviderConfiguration")(function* (
  initial: ProviderInstanceConfigMap,
): Effect.fn.Return<
  Effect.Success<ReturnType<typeof makeWithPorts>>,
  never,
  | Registry.ProviderInstanceRegistryMutator
  | Sessions.ProviderSessionManagerV2
  | SqlClient.SqlClient
  | Scope.Scope
> {
  const registry = yield* Registry.ProviderInstanceRegistryMutator;
  const sessions = yield* Sessions.ProviderSessionManagerV2;
  const sql = yield* SqlClient.SqlClient;
  return yield* makeWithPorts(initial, {
    busyInstances: Effect.gen(function* () {
      const native = yield* sessions.busyInstances;
      const rows = yield* sql<{ readonly provider_instance_id: string }>`
        SELECT DISTINCT provider_instance_id FROM orchestration_v2_projection_runs
        WHERE status IN ('preparing', 'starting', 'running', 'waiting')
      `;
      return new Set([
        ...native,
        ...rows.map((row) => ProviderInstanceId.make(row.provider_instance_id)),
      ]);
    }).pipe(
      Effect.mapError(
        (cause) => new Error("Could not read active provider configuration ownership.", { cause }),
      ),
    ),
    closeIdleInstance: (id) =>
      sessions
        .closeInstance(id)
        .pipe(
          Effect.mapError(
            (cause) => new Error("Could not retire an idle provider instance.", { cause }),
          ),
        ),
    reconcile: registry.reconcile,
  });
});
