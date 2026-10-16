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

it.effect("a checked read waits for the first status check instead of a placeholder", () =>
  Effect.gen(function* () {
    const current = yield* Ref.make(unchecked);
    const firstCheck = yield* Deferred.make<void>();
    const instance = {
      instanceId: unchecked.instanceId,
      driverKind: unchecked.driver,
      continuationIdentity: { driverKind: unchecked.driver, continuationKey: "codex:test" },
      displayName: undefined,
      enabled: true,
      snapshot: {
        resolveMaintenance: () =>
          Effect.succeed(
            makeManualOnlyProviderMaintenanceCapabilities({
              provider: unchecked.driver,
              packageName: null,
            }),
          ),
        getSnapshot: Ref.get(current),
        initialCheck: Deferred.await(firstCheck),
        refresh: Ref.get(current),
        // The result must be read even when no change notification arrives.
        streamChanges: Stream.empty,
        applyUsageLimits: () => Effect.void,
      },
      orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
      textGeneration: {} as ProviderInstance["textGeneration"],
    } satisfies ProviderInstance;
    const instances = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (id) => Effect.succeed(id === instance.instanceId ? instance : undefined),
      listInstances: Effect.succeed([instance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
    });
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
    }).pipe(Effect.provide(ProviderRegistry.layer.pipe(Layer.provide(instances))), Effect.scoped);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ModelManifest.layerTest,
        ServerConfig.layerTest(process.cwd(), { prefix: "nodex-provider-checked-" }),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);
