import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import type {
  AgentExecutionProfile,
  AgentProviderCatalog,
  AgentProviderCredentialDeleteInput,
  AgentProviderCredentialMutationInput,
  AgentProviderCredentialMutationResult,
  AgentProviderOption,
} from "../../shared/agent-runtime";
import { cappedApproximateValueBytes } from "../../shared/codex-bounded-value-size";
import {
  parseHarnessResponse,
  parseModelResponse,
  parseProviderResponse,
  parseWireApi,
  recommendedHarnessId,
  SUPPORTED_PROVIDER_IDS,
  toModelOption,
  type InterpreterProvider,
} from "../codex/agent-provider-catalog";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import type { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import {
  ProviderCredentials,
  type ProviderCredentialsError,
} from "../platform/electron/ProviderCredentials";

export class AgentProviderRuntimeError extends Schema.TaggedError<AgentProviderRuntimeError>()(
  "AgentProviderRuntimeError",
  { operation: Schema.String, message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

export type AgentProviderError =
  | AgentProviderRuntimeError
  | CodexRuntimeError
  | ProviderCredentialsError;

export class AgentProviderRuntime extends Context.Service<
  AgentProviderRuntime,
  {
    readonly list: (options?: {
      readonly refresh?: boolean;
    }) => Effect.Effect<AgentProviderCatalog, AgentProviderError>;
    readonly resolveExecutionProfile: (
      requested: AgentExecutionProfile,
    ) => Effect.Effect<AgentExecutionProfile, AgentProviderError>;
    readonly setCredential: (
      input: AgentProviderCredentialMutationInput,
    ) => Effect.Effect<AgentProviderCredentialMutationResult, AgentProviderError>;
    readonly deleteCredential: (
      input: AgentProviderCredentialDeleteInput,
    ) => Effect.Effect<AgentProviderCredentialMutationResult, AgentProviderError>;
    readonly ensureRuntimeReady: Effect.Effect<void, AgentProviderError>;
  }
>()("nodex/main/codex-application/AgentProviderRuntime") {}

const supportedProviderIds = new Set<string>(SUPPORTED_PROVIDER_IDS);

/** A credential mutation must not scan an unbounded Thread catalog before restarting the runtime. */
export const CODEX_IDLE_CHECK_THREAD_PAGE_SIZE = 100;
export const CODEX_IDLE_CHECK_MAX_THREAD_PAGES = 20;
export const CODEX_IDLE_CHECK_MAX_PAGE_BYTES = 8 * 1024 * 1024;
export const CODEX_IDLE_CHECK_PAGE_TIMEOUT_MS = 10_000;

const projectionError = (operation: string, cause: unknown) =>
  new AgentProviderRuntimeError({
    operation,
    message: cause instanceof Error ? cause.message : `Agent provider ${operation} failed`,
    cause,
  });

const projectProvider = (input: {
  readonly provider: InterpreterProvider;
  readonly rawModels: unknown;
  readonly rawHarnesses: unknown;
  readonly credentialStatus: AgentProviderOption["credentialStatus"];
}): AgentProviderOption => {
  const models = parseModelResponse(input.rawModels, input.provider.id);
  const harnesses = parseHarnessResponse(input.rawHarnesses, input.provider.id);
  const harnessId = recommendedHarnessId(harnesses);
  return {
    id: input.provider.id,
    displayName: input.provider.name,
    description: input.provider.description || null,
    wireApi: parseWireApi(input.provider.wireApi),
    credentialStatus: input.credentialStatus,
    supportedByNodex: true,
    isDefault: input.provider.isDefault,
    credentialEnvKey: input.provider.envKey ?? null,
    recommendedHarnessId: harnessId,
    models: models.map((model) => toModelOption(input.provider.id, model, harnessId)),
  };
};

export const live: Layer.Layer<AgentProviderRuntime, never, CodexGateway | ProviderCredentials> =
  Layer.effect(
    AgentProviderRuntime,
    Effect.gen(function* () {
      const gateway = yield* CodexGateway;
      const credentials = yield* ProviderCredentials;
      const cache = yield* Ref.make<AgentProviderCatalog | null>(null);
      const restartPending = yield* Ref.make(false);
      const catalogLock = yield* Semaphore.make(1);
      const credentialMutationLock = yield* Semaphore.make(1);
      const restartLock = yield* Semaphore.make(1);
      const requestInterpreter = (method: string, params: unknown) =>
        gateway.requestRawOnHost(gateway.localHostId, method, params);

      const discover = Effect.fn("AgentProviderRuntime.discover")(function* () {
        const raw = yield* requestInterpreter("interpreter/provider/list", {
          includeUnconfigured: true,
        });
        const providers = yield* Effect.try({
          try: () => parseProviderResponse(raw).filter((item) => supportedProviderIds.has(item.id)),
          catch: (cause) => projectionError("parse-providers", cause),
        });
        const byId = new Map(providers.map((provider) => [provider.id, provider]));
        const ordered = SUPPORTED_PROVIDER_IDS.flatMap((id) => {
          const provider = byId.get(id);
          return provider === undefined ? [] : [provider];
        });
        const projected = yield* Effect.forEach(
          ordered,
          (provider) =>
            Effect.all([
              requestInterpreter("interpreter/model/list", {
                modelProvider: provider.id,
                includeHidden: false,
              }),
              requestInterpreter("interpreter/harness/list", {
                providerId: provider.id,
                model: null,
              }),
              credentials.status(provider.id),
            ]).pipe(
              Effect.flatMap(([rawModels, rawHarnesses, credentialStatus]) =>
                Effect.try({
                  try: () =>
                    projectProvider({ provider, rawModels, rawHarnesses, credentialStatus }),
                  catch: (cause) => projectionError("project-provider", cause),
                }),
              ),
            ),
          { concurrency: "unbounded" },
        );
        const catalog = { providers: projected } satisfies AgentProviderCatalog;
        yield* Ref.set(cache, catalog);
        return catalog;
      });

      const list: AgentProviderRuntime["Service"]["list"] = (options) =>
        catalogLock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(cache);
            if (current !== null && options?.refresh !== true) return current;
            return yield* discover();
          }),
        );

      const hasActiveWork = Effect.fn("AgentProviderRuntime.hasActiveWork")(function* () {
        let cursor: string | null = null;
        const seenCursors = new Set<string | null>();
        for (let pageNumber = 0; pageNumber < CODEX_IDLE_CHECK_MAX_THREAD_PAGES; pageNumber += 1) {
          // Unknown catalog state is deliberately treated as active: credential changes must not
          // interrupt a potentially running Thread just because a bounded idle scan ran out.
          if (seenCursors.has(cursor)) return true;
          seenCursors.add(cursor);
          const response: ClientRequestResponsesByMethod["thread/list"] =
            yield* gateway.requestLocal(
              "thread/list",
              {
                archived: false,
                cursor,
                limit: CODEX_IDLE_CHECK_THREAD_PAGE_SIZE,
                useStateDbOnly: true,
              },
              {
                priority: "background",
                source: "thread_list",
                timeoutMs: CODEX_IDLE_CHECK_PAGE_TIMEOUT_MS,
              },
            );
          if (
            response.data.length > CODEX_IDLE_CHECK_THREAD_PAGE_SIZE ||
            cappedApproximateValueBytes(response.data, CODEX_IDLE_CHECK_MAX_PAGE_BYTES) >
              CODEX_IDLE_CHECK_MAX_PAGE_BYTES
          ) {
            return true;
          }
          if (response.data.some((thread) => thread.status.type === "active")) return true;
          const nextCursor = response.nextCursor ?? null;
          if (nextCursor === null) return false;
          if (seenCursors.has(nextCursor)) return true;
          cursor = nextCursor;
        }
        return true;
      });

      const restartIfIdle = Effect.fn("AgentProviderRuntime.restartIfIdle")(function* () {
        return yield* restartLock.withPermits(1)(
          Effect.gen(function* () {
            if (!(yield* Ref.get(restartPending))) return false;
            if (yield* hasActiveWork()) return true;
            yield* gateway.restartHost(gateway.localHostId);
            yield* Ref.set(restartPending, false);
            return false;
          }),
        );
      });

      const mutateCredential = Effect.fn("AgentProviderRuntime.mutateCredential")(function* (
        providerId: string,
        mutation: Effect.Effect<void, ProviderCredentialsError>,
      ) {
        return yield* credentialMutationLock.withPermits(1)(
          Effect.gen(function* () {
            yield* mutation;
            yield* Ref.set(cache, null);
            yield* Ref.set(restartPending, true);
            const runtimeRestartPending = yield* restartIfIdle();
            return {
              providerId,
              status: yield* credentials.status(providerId),
              runtimeRestartPending,
            } satisfies AgentProviderCredentialMutationResult;
          }),
        );
      });

      yield* gateway.events.pipe(
        Stream.filter(
          (event) =>
            event.kind === "notification" &&
            (event.value.method === "turn/completed" ||
              event.value.method === "thread/status/changed"),
        ),
        Stream.runForEach(() =>
          restartIfIdle().pipe(
            Effect.catch((error) =>
              Effect.logError("Could not restart agent runtime after credential change").pipe(
                Effect.annotateLogs({ error: String(error) }),
              ),
            ),
          ),
        ),
        Effect.forkScoped,
      );

      return AgentProviderRuntime.of({
        list,
        resolveExecutionProfile: (requested) =>
          Effect.gen(function* () {
            const catalog = yield* list();
            const provider = catalog.providers.find((item) => item.id === requested.providerId);
            if (!provider?.supportedByNodex) {
              return yield* projectionError(
                "resolve-profile",
                new Error(`Unsupported agent provider: ${requested.providerId}`),
              );
            }
            const model = provider.models.find((item) => item.modelId === requested.modelId);
            if (model === undefined) {
              return yield* projectionError(
                "resolve-profile",
                new Error(`Agent model '${requested.modelId}' is unavailable`),
              );
            }
            if (!["ready", "inherited", "runtimeManaged"].includes(provider.credentialStatus)) {
              return yield* projectionError(
                "resolve-profile",
                new Error(`Agent provider '${requested.providerId}' needs an API key`),
              );
            }
            const reasoning = model.supportedReasoningEfforts.map((item) => item.value);
            const reasoningEffort =
              requested.reasoningEffort ??
              (model.defaultReasoningEffort && reasoning.includes(model.defaultReasoningEffort)
                ? model.defaultReasoningEffort
                : (reasoning[0] ?? null));
            if (reasoningEffort !== null && !reasoning.includes(reasoningEffort)) {
              return yield* projectionError(
                "resolve-profile",
                new Error(`Reasoning effort '${reasoningEffort}' is unavailable`),
              );
            }
            const tiers = model.supportedServiceTiers.map((item) => item.value);
            if (requested.serviceTier !== null && !tiers.includes(requested.serviceTier)) {
              return yield* projectionError(
                "resolve-profile",
                new Error(`Service tier '${requested.serviceTier}' is unavailable`),
              );
            }
            const rawHarnesses = yield* requestInterpreter("interpreter/harness/list", {
              providerId: provider.id,
              model: model.modelId,
            });
            const harnesses = yield* Effect.try({
              try: () => parseHarnessResponse(rawHarnesses, provider.id),
              catch: (cause) => projectionError("parse-harnesses", cause),
            });
            const requestedHarness =
              requested.harnessId === provider.recommendedHarnessId ? null : requested.harnessId;
            if (
              requestedHarness !== null &&
              !harnesses.some((harness) => harness.id === requestedHarness)
            ) {
              return yield* projectionError(
                "resolve-profile",
                new Error(`Agent harness '${requestedHarness}' is unavailable`),
              );
            }
            const recommended = harnesses.find((harness) => harness.isRecommended);
            return {
              providerId: requested.providerId,
              modelId: requested.modelId,
              harnessId:
                requestedHarness ??
                (recommended ? (recommended.id ?? null) : provider.recommendedHarnessId),
              reasoningEffort,
              serviceTier: requested.serviceTier,
            };
          }),
        setCredential: (input) =>
          mutateCredential(input.providerId, credentials.set(input.providerId, input.apiKey)),
        deleteCredential: (input) =>
          mutateCredential(input.providerId, credentials.remove(input.providerId)),
        ensureRuntimeReady: Effect.gen(function* () {
          if (!(yield* Ref.get(restartPending))) return;
          if (yield* restartIfIdle()) {
            return yield* projectionError(
              "ensure-runtime-ready",
              new Error("Agent credentials will be reloaded after the active turn finishes"),
            );
          }
        }),
      });
    }),
  );
