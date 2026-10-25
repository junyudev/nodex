import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const unchecked: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: false,
  version: null,
  status: "warning",
  auth: { status: "unknown" },
  checkedAt: "2026-10-16T00:00:00.000Z",
  message: "Codex provider status has not been checked in this session yet.",
  models: [],
  slashCommands: [],
  skills: [],
};
const checked: ServerProvider = {
  ...unchecked,
  installed: true,
  version: "0.145.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-16T00:00:01.000Z",
  message: undefined,
  models: [{ slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null }],
};

const instanceOf = (
  provider: ServerProvider,
  current: Ref.Ref<ServerProvider>,
  initialCheck: Effect.Effect<void>,
) =>
  ({
    instanceId: provider.instanceId,
    driverKind: provider.driver,
    continuationIdentity: {
      driverKind: provider.driver,
      continuationKey: `${provider.instanceId}:test`,
    },
    displayName: undefined,
    enabled: true,
    snapshot: {
      resolveMaintenance: () =>
        Effect.succeed(
          makeManualOnlyProviderMaintenanceCapabilities({
            provider: provider.driver,
            packageName: null,
          }),
        ),
      getSnapshot: Ref.get(current),
      initialCheck,
      refresh: Ref.get(current),
      // The result must be read even when no change notification arrives.
      streamChanges: Stream.empty,
      applyUsageLimits: () => Effect.void,
    },
    orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
  }) satisfies ProviderInstance;

const registryOf = (instances: ReadonlyArray<ProviderInstance>) =>
  ProviderRegistry.layer.pipe(
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (id) =>
          Effect.succeed(instances.find((instance) => instance.instanceId === id)),
        listInstances: Effect.succeed(instances),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
      }),
    ),
  );

const environment = Layer.mergeAll(
  ModelManifest.layerTest,
  ServerConfig.layerTest(process.cwd(), { prefix: "nodex-provider-checked-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

it.effect("a checked read waits for the first status check instead of a placeholder", () =>
  Effect.gen(function* () {
    const current = yield* Ref.make(unchecked);
    const firstCheck = yield* Deferred.make<void>();
    const instance = instanceOf(unchecked, current, Deferred.await(firstCheck));
    yield* Effect.gen(function* () {
      const registry = yield* ProviderRegistry.ProviderRegistry;
      assert.strictEqual((yield* registry.getProviders)[0]?.installed, false);
      const reader = yield* registry.getCheckedProviders.pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.isUndefined(reader.pollUnsafe());
      yield* Ref.set(current, checked);
      yield* Deferred.succeed(firstCheck, undefined);
      const providers = yield* Fiber.join(reader);
      assert.strictEqual(providers[0]?.status, "ready");
      assert.deepStrictEqual(
        providers[0]?.models.map(({ slug }) => slug),
        ["gpt-5.5"],
      );
    }).pipe(Effect.provide(registryOf([instance])), Effect.scoped);
  }).pipe(Effect.provide(environment)),
);

it.effect("a read of named Agents does not wait for another Agent's check", () =>
  Effect.gen(function* () {
    const slow: ServerProvider = {
      ...unchecked,
      instanceId: ProviderInstanceId.make("claude-default"),
      driver: ProviderDriverKind.make("claudeAgent"),
    };
    const codex = instanceOf(checked, yield* Ref.make(checked), Effect.void);
    const claude = instanceOf(slow, yield* Ref.make(slow), Effect.never);
    yield* Effect.gen(function* () {
      const registry = yield* ProviderRegistry.ProviderRegistry;
      const providers = yield* registry.getCheckedProvidersFor(["codex"]);
      assert.deepStrictEqual(
        providers.map(({ instanceId, status }) => [instanceId, status]),
        [["codex", "ready"]],
      );
    }).pipe(Effect.provide(registryOf([codex, claude])), Effect.scoped);
  }).pipe(Effect.provide(environment)),
);

it.effect("a fresh refresh of one Agent checks it again from scratch and leaves the others", () =>
  Effect.gen(function* () {
    const claudeChecked: ServerProvider = {
      ...checked,
      instanceId: ProviderInstanceId.make("claude-default"),
      driver: ProviderDriverKind.make("claudeAgent"),
    };
    const steps = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (step: string) => Ref.update(steps, (all) => [...all, step]);
    const instrumented = (provider: ServerProvider) => {
      const base = instanceOf(provider, undefined as never, Effect.void);
      return {
        ...base,
        snapshot: {
          ...base.snapshot,
          getSnapshot: Effect.succeed(provider),
          refresh: record(`${provider.instanceId}:check`).pipe(Effect.as(provider)),
        },
        invalidateCaches: record(`${provider.instanceId}:invalidate`),
      } satisfies ProviderInstance;
    };
    yield* Effect.gen(function* () {
      const registry = yield* ProviderRegistry.ProviderRegistry;
      yield* registry.getCheckedProviders;
      yield* registry.refreshInstance(claudeChecked.instanceId, { fresh: true });
      assert.deepStrictEqual(yield* Ref.get(steps), [
        "claude-default:invalidate",
        "claude-default:check",
      ]);
    }).pipe(
      Effect.provide(registryOf([instrumented(checked), instrumented(claudeChecked)])),
      Effect.scoped,
    );
  }).pipe(Effect.provide(environment)),
);
