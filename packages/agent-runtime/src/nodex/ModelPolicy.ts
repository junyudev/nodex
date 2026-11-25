import { NODEX_MODELS } from "../../../../src/shared/nodex-models.ts";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { antigravityModelPolicyIdentity } from "../provider/antigravityModelSelection.ts";
import type {
  ModelSelection,
  ProviderInstanceConfigMap,
  ServerProvider,
} from "@nodex/runtime-contracts";
import {
  DEFAULT_MODEL_POLICY,
  ModelPolicySchema,
  modelPolicyFailure,
  spendsNodexCredit,
  isProviderOn,
  isModelOn,
  type ModelPolicy as Policy,
  type ModelPolicyOrigin,
  type PolicyProvider,
} from "../../../../src/shared/model-policy.ts";

export class ModelPolicyError extends Schema.TaggedError<ModelPolicyError>()("ModelPolicyError", {
  code: Schema.Literals(["model_off", "credit_requires_person"]),
  message: Schema.String,
  retryable: Schema.Literal(false),
}) {}
interface Snapshot {
  readonly policy: Policy;
  readonly providers: ProviderInstanceConfigMap;
}
/** A closed credit provider never probes. Unavailable declarations still produce diagnostic snapshots. */
export const executionProviders = (
  policy: Policy,
  providers: ProviderInstanceConfigMap,
): ProviderInstanceConfigMap =>
  Object.fromEntries(
    Object.entries(providers).filter(
      ([instanceId, provider]) =>
        provider.unavailable !== undefined ||
        !spendsNodexCredit({ ...provider, instanceId }) ||
        isProviderOn(policy, { ...provider, instanceId }),
    ),
  );
export const providerForPolicy = (
  providers: ProviderInstanceConfigMap,
  instanceId: string,
): PolicyProvider => {
  const declaration = providers[instanceId as ModelSelection["instanceId"]];
  return {
    instanceId,
    driver:
      declaration?.driver ?? (instanceId.startsWith("nodex_claude_") ? "claudeAgent" : "codex"),
    source: declaration?.source,
    displayName: declaration?.displayName,
  };
};
const service = (
  current: Effect.Effect<Snapshot>,
  replace: (value: Snapshot) => Effect.Effect<void>,
  useCatalog = false,
) => {
  let readCatalog = Effect.succeed<ReadonlyArray<ServerProvider>>([]);
  const utilities = new Set<{
    selection: Pick<ModelSelection, "instanceId" | "model">;
    revoked: Deferred.Deferred<never, ModelPolicyError>;
    stopped: Deferred.Deferred<void>;
  }>();
  return {
    current,
    // Read already-observed choices from the registry; admission never starts a probe.
    readModelCatalog: (catalog: Effect.Effect<ReadonlyArray<ServerProvider>>) => {
      if (useCatalog) readCatalog = catalog;
    },
    replace: (next: Snapshot) =>
      Effect.gen(function* () {
        yield* replace(next);
        const retiring = [...utilities].filter(
          ({ selection }) =>
            spendsNodexCredit(providerForPolicy(next.providers, selection.instanceId)) &&
            !isModelOn(
              next.policy,
              providerForPolicy(next.providers, selection.instanceId),
              selection.model,
            ),
        );
        yield* Effect.forEach(retiring, ({ selection, revoked }) =>
          Deferred.fail(
            revoked,
            new ModelPolicyError(
              modelPolicyFailure(
                next.policy,
                providerForPolicy(next.providers, selection.instanceId),
                selection.model,
                "person",
                NODEX_MODELS.find((model) => model.id === selection.model)?.label,
              )!,
            ),
          ),
        );
        yield* Effect.forEach(retiring, ({ stopped }) => Deferred.await(stopped));
      }),
    withUtility: <A, E, R>(
      selection: Pick<ModelSelection, "instanceId" | "model">,
      effect: Effect.Effect<A, E, R>,
    ) =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          const entry = {
            selection,
            revoked: yield* Deferred.make<never, ModelPolicyError>(),
            stopped: yield* Deferred.make<void>(),
          };
          utilities.add(entry);
          return entry;
        }),
        (entry) => Effect.raceFirst(effect, Deferred.await(entry.revoked)),
        (entry) =>
          Effect.sync(() => {
            utilities.delete(entry);
          }).pipe(Effect.andThen(Deferred.succeed(entry.stopped, undefined))),
      ),
    origin: (agent: boolean, callerInstanceId?: string) =>
      current.pipe(
        Effect.map(({ providers }): ModelPolicyOrigin =>
          !agent
            ? "person"
            : callerInstanceId && spendsNodexCredit(providerForPolicy(providers, callerInstanceId))
              ? "nodex-agent"
              : "agent",
        ),
      ),
    assert: (selection: Pick<ModelSelection, "instanceId" | "model">, origin: ModelPolicyOrigin) =>
      current.pipe(
        Effect.flatMap(
          Effect.fnUntraced(function* ({ policy, providers }) {
            const provider = providerForPolicy(providers, selection.instanceId);
            const model =
              provider.driver === "antigravity"
                ? antigravityModelPolicyIdentity(
                    (yield* readCatalog).find((entry) => entry.instanceId === selection.instanceId),
                    selection.model,
                  )
                : selection.model;
            const error = modelPolicyFailure(
              policy,
              provider,
              model,
              origin,
              NODEX_MODELS.find((entry) => entry.id === model)?.label,
            );
            if (error) return yield* new ModelPolicyError(error);
          }),
        ),
      ),
  };
};
/** Private replay authority captured at admission, independent of message authorship. */
export const RetainedModelPolicyOrigin = Context.Reference<ModelPolicyOrigin | undefined>(
  "nodex/RetainedModelPolicyOrigin",
  { defaultValue: () => undefined },
);
/** Live policy never waits for native provider configuration or Project overrides. */
export const RuntimeModelPolicy = Context.Reference<ReturnType<typeof service>>(
  "nodex/RuntimeModelPolicy",
  {
    defaultValue: () =>
      service(Effect.succeed({ policy: DEFAULT_MODEL_POLICY, providers: {} }), () => Effect.void),
  },
);
const withoutCredentials = (providers: ProviderInstanceConfigMap): ProviderInstanceConfigMap =>
  Object.fromEntries(
    Object.entries(providers).map(([id, provider]) => {
      const { environment: _environment, config: _config, ...safe } = provider;
      return [id, { ...safe, config: {} }];
    }),
  );
export const make = Effect.fn("RuntimeModelPolicy.make")(function* (
  policy: Policy,
  providers: ProviderInstanceConfigMap,
) {
  const state = yield* Ref.make({
    policy: ModelPolicySchema.parse(policy),
    providers: withoutCredentials(providers),
  });
  return service(
    Ref.get(state),
    (next) =>
      Ref.set(state, {
        policy: ModelPolicySchema.parse(next.policy),
        providers: withoutCredentials(next.providers),
      }),
    true,
  );
});
