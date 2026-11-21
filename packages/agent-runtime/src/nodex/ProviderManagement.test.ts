import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Deferred from "effect/Deferred";
import { makeAntigravityAuth, type AntigravityAuthRuntime } from "../provider/AntigravityAuth.ts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { ProviderDriverKind, ProviderInstanceId } from "@nodex/runtime-contracts";
import type { ProviderInstance } from "@nodex/provider-core/server/driver";
import * as Authentication from "./ProviderAuthentication.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { AntigravityUsage } from "../provider/Drivers/AntigravityUsage.ts";
import { makePolicy, ProviderPolicy } from "./ProviderConfiguration.ts";
import * as Management from "./ProviderManagement.ts";

it.effect("refuses lifecycle changes while configuration is deferred", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("antigravity");
    const entry = { driver: ProviderDriverKind.make("antigravity"), enabled: true, config: {} };
    const policy = yield* makePolicy({ [instanceId]: entry });
    yield* policy.setDesired({ [instanceId]: { ...entry, enabled: false } });
    const management = yield* Management.make().pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ProviderPolicy, policy),
          Layer.succeed(ProviderInstanceRegistry, {} as ProviderInstanceRegistry["Service"]),
          Layer.succeed(ProviderRegistry, {} as ProviderRegistry["Service"]),
          Layer.succeed(AntigravityUsage, {} as AntigravityUsage["Service"]),
        ),
      ),
    );
    const result = yield* management
      .execute({
        id: "sign-in",
        method: "providers.models.refresh",
        input: { instanceId },
      })
      .pipe(Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result))
      expect(String(result.cause)).toContain("Wait for the provider configuration to apply");
  }),
);

it.effect("keeps accepted sign-in private and cancellable while configuration is deferred", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("antigravity");
    const entry = { driver: ProviderDriverKind.make("antigravity"), enabled: true, config: {} };
    const policy = yield* makePolicy({ [instanceId]: entry });
    const linkReady = yield* Deferred.make<void>();
    const processClosed = yield* Deferred.make<void>();
    const authorizationUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F&state=setup-test";
    const nativeAuth = yield* makeAntigravityAuth<AntigravityAuthRuntime>({
      instanceId,
      makeRuntime: (input) =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Deferred.succeed(processClosed, undefined));
          return {
            initialize: () => Effect.succeed({ protocolVersion: 1 }),
            start: () =>
              Effect.gen(function* () {
                yield* input.onAuthorizationUrl?.(authorizationUrl) ?? Effect.void;
                yield* Deferred.succeed(linkReady, undefined);
                return yield* Effect.never;
              }),
            logout: Effect.succeed({}),
          } satisfies AntigravityAuthRuntime;
        }),
      onAuthenticated: () => Effect.void,
      onSignedOut: Effect.void,
    });
    const selected = { instanceId, auth: nativeAuth.controller } as ProviderInstance;
    const management = Authentication.make("runtime-one", {
      target: () => Effect.succeed(selected),
      revision: policy.snapshot.pipe(Effect.map((value) => value.revision)),
      withCurrent: (_selected, task) => task,
      withIdle: (_id, use) => use(selected),
      withLogout: (_id, use) => use(selected, Effect.void),
      beforeMutation: () => Effect.void,
    });
    const started = yield* management
      .execute({
        id: "begin",
        method: "providers.auth.start",
        input: { instanceId, ownerId: "settings" },
      })
      .pipe(Effect.scoped);
    expect(started).toMatchObject({ phase: "starting", authorizationUrl: null });
    yield* Deferred.await(linkReady);
    yield* policy.setDesired({ [instanceId]: { ...entry, enabled: false } });
    const visible = yield* management.execute({
      id: "read",
      method: "providers.auth.read",
      input: { instanceId, ownerId: "settings" },
    });
    expect(visible).toMatchObject({
      phase: "waiting",
      authorizationUrl,
      runtimeGeneration: "runtime-one",
      configurationRevision: 1,
      cancellable: true,
    });
    expect(visible.revision).toBeGreaterThan(started.revision);
    const otherOwner = yield* management.execute({
      id: "other-read",
      method: "providers.auth.read",
      input: { instanceId, ownerId: "other-settings" },
    });
    expect(otherOwner).toMatchObject({
      phase: "waiting",
      authorizationUrl: null,
      flowId: null,
      interaction: null,
    });
    const flowId =
      visible !== null && "flowId" in visible && typeof visible.flowId === "string"
        ? visible.flowId
        : "missing";
    const cancelled = yield* management.execute({
      id: "cancel",
      method: "providers.auth.cancel",
      input: { instanceId, ownerId: "settings", flowId },
    });
    expect(cancelled).toMatchObject({ phase: "cancelled", authorizationUrl: null });
    yield* Deferred.await(processClosed);
    expect(yield* nativeAuth.controller.isChangingCredentials!).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
);
