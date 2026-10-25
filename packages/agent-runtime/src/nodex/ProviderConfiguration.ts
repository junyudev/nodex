import {
  ProviderInstanceId,
  ServerSettingsError,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import type { ServerSettingsService } from "../serverSettings.ts";
import * as Registry from "../provider/ProviderInstanceRegistryMutator.ts";
import * as Sessions from "../orchestration-v2/ProviderSessionManager.ts";

/** The effective provider policy follows the applied registry, including deferred native instances. */
export class ProviderPolicy extends Context.Service<
  ProviderPolicy,
  {
    readonly current: Effect.Effect<ProviderInstanceConfigMap>;
    readonly snapshot: Effect.Effect<{
      readonly config: ProviderInstanceConfigMap;
      readonly revision: number;
    }>;
    readonly desired: Effect.Effect<ProviderInstanceConfigMap>;
    readonly replace: (config: ProviderInstanceConfigMap) => Effect.Effect<void>;
    readonly admission: Effect.Effect<ProviderInstanceConfigMap>;
    readonly setDesired: (config: ProviderInstanceConfigMap) => Effect.Effect<void>;
  }
>()("nodex/agent-runtime/ProviderPolicy") {}

export const makePolicy = Effect.fn("AgentRuntime.makeProviderPolicy")(function* (
  initial: ProviderInstanceConfigMap,
) {
  const current = yield* Ref.make({ config: initial, revision: 1 });
  const desired = yield* Ref.make(initial);
  return ProviderPolicy.of({
    admission: Effect.all([
      Ref.get(current).pipe(Effect.map(({ config }) => config)),
      Ref.get(desired),
    ]).pipe(
      Effect.map(([applied, wanted]) =>
        Object.fromEntries(
          Object.entries(applied).map(([id, entry]) => [
            id,
            {
              ...entry,
              enabled:
                wanted[id as ProviderInstanceId]?.enabled ??
                (wanted[id as ProviderInstanceId] === undefined ? false : (entry.enabled ?? true)),
            },
          ]),
        ),
      ),
    ),
    setDesired: (config) => Ref.set(desired, config),
    current: Ref.get(current).pipe(Effect.map(({ config }) => config)),
    snapshot: Ref.get(current),
    desired: Ref.get(desired),
    replace: (config) =>
      Ref.update(current, (before) =>
        Equal.equals(before.config, config) ? before : { config, revision: before.revision + 1 },
      ),
  });
});

export const layerPolicy = (initial: ProviderInstanceConfigMap) =>
  Layer.effect(ProviderPolicy, makePolicy(initial));

/** Provider configuration is read from the applied in-memory owner, never copied into settings files. */
export const effectiveSettings = (
  stored: ServerSettingsService["Service"],
  policy: ProviderPolicy["Service"],
): ServerSettingsService["Service"] => {
  const project = (settings: Effect.Success<typeof stored.getSettings>) =>
    policy.admission.pipe(
      Effect.map((providerInstances) => {
        const disabled = Object.fromEntries(
          Object.entries(providerInstances)
            .filter(([, entry]) => entry.enabled === false)
            .map(([id]) => [id, { enabled: false }]),
        );
        const projectSettingsOverrides = Object.fromEntries(
          Object.entries(settings.projectSettingsOverrides).map(([id, overrides]) => [
            id,
            { ...overrides, providerInstances: { ...overrides.providerInstances, ...disabled } },
          ]),
        );
        return { ...settings, providerInstances, projectSettingsOverrides };
      }),
    );
  return {
    ...stored,
    getSettings: stored.getSettings.pipe(Effect.flatMap(project)),
    getAdmittedWorkSettings: Effect.all([stored.getSettings, policy.current]).pipe(
      Effect.map(([settings, providerInstances]) => ({ ...settings, providerInstances })),
    ),
    withSettingsSnapshot: (use) =>
      stored.withSettingsSnapshot((settings) => project(settings).pipe(Effect.flatMap(use))),
    updateSettings: (patch) => {
      if (patch.providerInstances !== undefined)
        return Effect.fail(
          new ServerSettingsError({
            operation: "write-file",
            settingsPath: "host-owned-agent-configuration",
          }),
        );
      return stored.updateSettings(patch).pipe(Effect.flatMap(project));
    },
    updateProviderInstance: () =>
      Effect.fail(
        new ServerSettingsError({
          operation: "write-file",
          settingsPath: "host-owned-agent-configuration",
        }),
      ),
    streamChanges: stored.streamChanges.pipe(Stream.mapEffect(project)),
    subscribeChanges: stored.subscribeChanges.pipe(
      Effect.map((stream) => stream.pipe(Stream.mapEffect(project))),
    ),
  };
};

interface ConfigurationPorts {
  readonly busyInstances: Effect.Effect<ReadonlySet<ProviderInstanceId>, Error>;
  readonly closeIdleInstance: (id: ProviderInstanceId) => Effect.Effect<void, Error>;
  readonly reconcile: (config: ProviderInstanceConfigMap) => Effect.Effect<void>;
  readonly validate?: (
    current: ProviderInstanceConfigMap,
    desired: ProviderInstanceConfigMap,
  ) => Effect.Effect<void, Error>;
  readonly admission?: (config: ProviderInstanceConfigMap) => Effect.Effect<void>;
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
      lane.withPermits(1)(
        Effect.gen(function* () {
          const previous = yield* Ref.get(current);
          if (ports.validate) yield* ports.validate(previous, config);
          yield* Ref.set(desired, config);
          if (ports.admission) yield* ports.admission(config);
          return yield* refresh;
        }),
      ),
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
  | ProviderPolicy
  | Scope.Scope
> {
  const registry = yield* Registry.ProviderInstanceRegistryMutator;
  const sessions = yield* Sessions.ProviderSessionManagerV2;
  const sql = yield* SqlClient.SqlClient;
  const policy = yield* ProviderPolicy;
  return yield* makeWithPorts(initial, {
    busyInstances: Effect.gen(function* () {
      const native = yield* sessions.busyInstances;
      const rows = yield* sql<{ readonly provider_instance_id: string }>`
        SELECT DISTINCT provider_instance_id FROM orchestration_v2_projection_runs
        WHERE status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
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
    reconcile: (config) => registry.reconcile(config).pipe(Effect.andThen(policy.replace(config))),
    validate: Effect.fn("ProviderConfiguration.validateNativeScope")(function* (current, desired) {
      for (const [id, before] of Object.entries(current)) {
        const after = desired[ProviderInstanceId.make(id)];
        if (before.driver !== "acpRegistry" || after === undefined || Equal.equals(before, after))
          continue;
        const previous = yield* Schema.decodeUnknownEffect(AcpRegistrySettings)(before.config).pipe(
          Effect.orDie,
        );
        const next = yield* Schema.decodeUnknownEffect(AcpRegistrySettings)(after.config).pipe(
          Effect.orDie,
        );
        const scope = (settings: AcpRegistrySettings) => [
          settings.agentIdentity ??
            (settings.source === "registry" ? settings.agentId : settings.commandPath),
          settings.nativeStorageScope,
        ];
        if (Equal.equals(scope(previous), scope(next))) continue;
        const mappings =
          yield* sql`SELECT provider_thread_id FROM orchestration_v2_projection_provider_threads WHERE provider_instance_id = ${id} LIMIT 1`.pipe(
            Effect.mapError(
              (cause) =>
                new Error("Could not validate the Agent's native storage identity.", { cause }),
            ),
          );
        if (mappings.length > 0)
          return yield* Effect.fail(
            new Error(
              "This Agent owns native conversation history. Create another instance to use a different Agent or credential home.",
            ),
          );
      }
    }),
    admission: policy.setDesired,
  });
});
