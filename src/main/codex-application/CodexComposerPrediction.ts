import { randomUUID } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { runtimeThread } from "./CodexRuntimeNative";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { ServerNotificationParamsByMethod } from "@nodex/effect-codex-app-server/rpc";
import type {
  CodexComposerPredictionAvailability,
  CodexComposerPredictionClearInput,
  CodexComposerPredictionInput,
  CodexComposerPredictionResult,
} from "../../shared/codex-composer-prediction";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexExecutionHostAuthState } from "../codex-runtime/CodexExecutionHostAuthState";
import { CodexGateway, codexGatewayGenerationFence } from "../codex-runtime/CodexGateway";
import type { CodexEndpointEvent } from "../codex-runtime/CodexEventHub";
import { ThreadCreationRuntime } from "./ThreadCreationRuntime";
import { CodexInternalThreadRegistry } from "./CodexInternalThreadRegistry";
import { projectCodexGatewayThreadReadThread } from "../codex-runtime/CodexGatewayProtocolProjection";

export const CodexComposerPredictionHost = Schema.String.check(Schema.isPattern(/\S/));
export const CodexComposerPredictionRequest = Schema.Struct({
  hostId: CodexComposerPredictionHost,
  threadId: CodexComposerPredictionHost,
  latestTurnId: Schema.NullOr(CodexComposerPredictionHost),
  generationTrigger: Schema.Literals(["live", "catch-up"]),
});
export const CodexComposerPredictionClear = Schema.Union([
  Schema.Undefined,
  Schema.Struct({
    hostId: Schema.optionalKey(Schema.Undefined),
    threadId: Schema.optionalKey(Schema.Undefined),
  }),
  Schema.Struct({
    hostId: CodexComposerPredictionHost,
    threadId: Schema.optionalKey(CodexComposerPredictionHost),
  }),
]);
const rate = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
export const CodexComposerPredictionConfiguration = Schema.Struct({
  is_enabled: Schema.Boolean,
  unsupported_models: Schema.optional(Schema.Array(Schema.String)),
  sample_rate: Schema.optional(rate),
  live_sample_rate: Schema.optional(rate),
  catch_up_sample_rate: Schema.optional(rate),
  prompt: Schema.String,
  prompt_version: Schema.String,
  prediction_reasoning_effort: Schema.String,
});
export type CodexComposerPredictionConfiguration = typeof CodexComposerPredictionConfiguration.Type;
export class CodexComposerPredictionError extends Schema.TaggedError<CodexComposerPredictionError>()(
  "CodexComposerPredictionError",
  {
    reason: Schema.Literals(["request-failed", "invalid-result", "turn-failed", "timeout"]),
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {}
export class CodexComposerPrediction extends Context.Service<
  CodexComposerPrediction,
  {
    readonly request: (
      input: CodexComposerPredictionInput,
    ) => Effect.Effect<CodexComposerPredictionResult | null, CodexComposerPredictionError>;
    readonly clear: (input?: CodexComposerPredictionClearInput) => Effect.Effect<void>;
    readonly availability: (hostId: string) => Effect.Effect<CodexComposerPredictionAvailability>;
  }
>()("nodex/main/codex-application/CodexComposerPrediction") {}

export interface CodexComposerPredictionOptions {
  /** null means an unassigned or unavailable configuration, independently of native support. */
  readonly configurationForHost: (
    hostId: string,
  ) => Effect.Effect<CodexComposerPredictionConfiguration | null>;
  readonly configurationSource?: "environment";
  readonly timeoutMs?: number;
}
interface Entry {
  readonly attempt: symbol;
  readonly hostId: string;
  readonly authLease: AbortSignal;
  readonly parentThreadId: string;
  readonly latestTurnId: string | null;
  readonly readCapability: () => CodexAppServerCapabilitySnapshot | null;
  readonly fiber: Fiber.Fiber<CodexComposerPredictionResult | null, CodexComposerPredictionError>;
}
const outputSchema = JSON.stringify({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { suggestion: { anyOf: [{ type: "string" }, { type: "null" }] } },
  required: ["suggestion"],
  additionalProperties: false,
});
const parsedResult = Schema.Struct({ suggestion: Schema.NullOr(Schema.String) });

/** A configuration-gated temporary inference owner with no durable Thread creation fallback. */
export const make = (
  options: CodexComposerPredictionOptions,
): Effect.Effect<
  CodexComposerPrediction["Service"],
  never,
  | CodexGateway
  | CodexExecutionHostAuthState
  | CodexAppServerCapabilities
  | ThreadCreationRuntime
  | CodexInternalThreadRegistry
  | Scope.Scope
> =>
  Effect.gen(function* () {
    const gateway = yield* CodexGateway;
    const authState = yield* CodexExecutionHostAuthState;
    const capabilities = yield* CodexAppServerCapabilities;
    const creations = yield* ThreadCreationRuntime;
    const internalThreads = yield* CodexInternalThreadRegistry;
    const ownerScope = yield* Effect.scope;
    const application = yield* Effect.serviceOption(AgentRuntimeApplication);
    const entries = new Map<string, Entry>();
    const admissions = new Set<{
      readonly key: string;
      readonly hostId: string;
      readonly parentThreadId: string;
      cancelled: Deferred.Deferred<void> | null;
      current: boolean;
    }>();
    const generations = new Map<string, number>();
    const leases = new Map<
      string,
      { readonly signal: AbortSignal; readonly fiber: Fiber.Fiber<void> }
    >();
    const fail = (
      reason: CodexComposerPredictionError["reason"],
      threadId: string,
      cause: unknown,
    ) => new CodexComposerPredictionError({ reason, threadId, cause });
    const clearEntries = Effect.fn("CodexComposerPrediction.clearEntries")(function* (
      input?: CodexComposerPredictionClearInput,
      preservedKey?: string,
      preservedAdmissionKey?: string,
    ) {
      // Clear also retires requests that have not finished their configuration/auth waits.
      for (const admission of admissions) {
        if (
          admission.key !== preservedAdmissionKey &&
          (input?.hostId === undefined || admission.hostId === input.hostId) &&
          (input?.threadId === undefined || admission.parentThreadId === input.threadId)
        ) {
          admission.current = false;
          if (admission.cancelled) yield* Deferred.succeed(admission.cancelled, undefined);
        }
      }
      const removed = [...entries].filter(
        ([key, entry]) =>
          key !== preservedKey &&
          (input?.hostId === undefined || entry.hostId === input.hostId) &&
          (input?.threadId === undefined || entry.parentThreadId === input.threadId),
      );
      for (const [key] of removed) entries.delete(key);
      yield* Effect.forEach(removed, ([, entry]) => Fiber.interrupt(entry.fiber), {
        discard: true,
      });
    });
    const clear = Effect.fn("CodexComposerPrediction.clear")(
      (input?: CodexComposerPredictionClearInput) => clearEntries(input),
    );
    yield* Effect.addFinalizer(() => clearEntries());
    const watchAuthLease = Effect.fn("CodexComposerPrediction.watchAuthLease")(function* (
      hostId: string,
      signal: AbortSignal,
    ) {
      const previous = leases.get(hostId);
      if (previous?.signal === signal) return;
      if (previous) yield* Fiber.interrupt(previous.fiber);
      const fiber = yield* Effect.callback<void>((resume) => {
        const abort = () => resume(Effect.void);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        return Effect.sync(() => signal.removeEventListener("abort", abort));
      }).pipe(
        Effect.andThen(hostId === gateway.localHostId ? clearEntries() : clear({ hostId })),
        Effect.forkIn(ownerScope),
      );
      leases.set(hostId, { signal, fiber });
    });
    yield* authState.changes.pipe(
      Stream.runForEach((required) =>
        Effect.forEach(
          [...required],
          (hostId) => (hostId === gateway.localHostId ? clearEntries() : clear({ hostId })),
          { discard: true },
        ),
      ),
      Effect.forkScoped,
    );
    yield* gateway.events.pipe(
      Stream.runForEach((event) => {
        if (event.kind === "connection") {
          const connection = event.value;
          const previous = generations.get(connection.hostId);
          if (connection.kind === "ready") {
            generations.set(connection.hostId, connection.generation);
            if (previous === undefined || connection.generation === previous) return Effect.void;
          } else generations.delete(connection.hostId);
          return clear({ hostId: connection.hostId });
        }
        if (
          event.value.method === "account/updated" &&
          (event.value.params as ServerNotificationParamsByMethod["account/updated"]).authMode ===
            null
        )
          return event.hostId === gateway.localHostId
            ? clearEntries()
            : clear({ hostId: event.hostId });
        if (event.value.method !== "turn/started") return Effect.void;
        const params = event.value.params as ServerNotificationParamsByMethod["turn/started"];
        return clear({ hostId: event.hostId, threadId: params.threadId });
      }),
      Effect.forkScoped,
    );

    const assertCurrent = Effect.fn("CodexComposerPrediction.assertCurrent")(function* (
      input: CodexComposerPredictionInput,
      capability: CodexAppServerCapabilitySnapshot,
    ) {
      const current = yield* capabilities
        .isCurrent(capability)
        .pipe(Effect.mapError((cause) => fail("request-failed", input.threadId, cause)));
      if (capability.hostId !== input.hostId || !current)
        return yield* fail(
          "request-failed",
          input.threadId,
          new Error("Prediction source retired"),
        );
    });
    const run = Effect.fn("CodexComposerPrediction.run")(function* (
      input: CodexComposerPredictionInput,
      configuration: CodexComposerPredictionConfiguration,
      captureCapability: (capability: CodexAppServerCapabilitySnapshot) => void,
    ) {
      const startedAt = yield* Clock.currentTimeMillis;
      const capability = yield* capabilities
        .forHost(input.hostId)
        .pipe(Effect.mapError((cause) => fail("request-failed", input.threadId, cause)));
      captureCapability(capability);
      yield* assertCurrent(input, capability);
      generations.set(input.hostId, capability.generation);
      const fence = codexGatewayGenerationFence(capability);
      const parent = yield* gateway
        .requestOnHost(
          input.hostId,
          "thread/resume",
          { threadId: input.threadId, excludeTurns: true },
          { ...fence, source: "composer_predictions" },
        )
        .pipe(Effect.mapError((cause) => fail("request-failed", input.threadId, cause)));
      yield* assertCurrent(input, capability);
      if (
        parent.collaborationMode?.mode === "plan" ||
        parent.modelProvider !== "openai" ||
        configuration.unsupported_models?.includes(parent.model) ||
        !capability.flags.experimentalPredictionForkMode
      )
        return null;
      // Acquisition and release registration are atomic even if cancellation wins the fork ACK.
      const temporary = yield* Effect.acquireRelease(
        creations.materialize(
          input.hostId,
          capability.generation,
          gateway
            .requestOnHost(
              input.hostId,
              "thread/fork",
              {
                threadId: input.threadId,
                experimentalPredictionMode: true,
                ephemeral: true,
                excludeTurns: true,
                threadSource: "composer_predictions",
              },
              { ...fence, source: "composer_predictions" },
            )
            .pipe(
              Effect.map((response) => {
                internalThreads.observeStarted(
                  projectCodexGatewayThreadReadThread(response.thread),
                );
                return response;
              }),
              Effect.mapError((cause) => fail("request-failed", input.threadId, cause)),
            ),
          (response) => response.thread.id,
        ),
        (response) =>
          gateway
            .requestOnHost(
              input.hostId,
              "thread/unsubscribe",
              { threadId: response.thread.id },
              { ...fence, source: "composer_predictions" },
            )
            .pipe(
              Effect.ignore,
              Effect.ensuring(Effect.sync(() => internalThreads.clear(response.thread.id))),
            ),
      );
      yield* assertCurrent(input, capability);
      const temporaryId = temporary.thread.id;
      let turnId: string | null = null;
      let completed = false;
      let cancelled = false;
      let interrupted = false;
      let text = "";
      let lastTokens:
        | ServerNotificationParamsByMethod["thread/tokenUsage/updated"]["tokenUsage"]["last"]
        | null = null;
      let observedError: unknown;
      const result = yield* Deferred.make<
        CodexComposerPredictionResult,
        CodexComposerPredictionError
      >();
      const interruptKnownTurn = Effect.fn("CodexComposerPrediction.interruptKnownTurn")(
        function* () {
          if (completed || interrupted || turnId === null) return;
          interrupted = true;
          yield* gateway
            .requestOnHost(
              input.hostId,
              "turn/interrupt",
              { threadId: temporaryId, turnId },
              { ...fence, source: "composer_predictions" },
            )
            .pipe(Effect.ignore);
        },
      );
      yield* Effect.addFinalizer(() => {
        if (completed) return Effect.void;
        cancelled = true;
        return interruptKnownTurn();
      });
      const observe = Effect.fn("CodexComposerPrediction.observe")(function* (
        event: CodexEndpointEvent,
      ) {
        if (
          event.kind !== "notification" ||
          event.hostId !== input.hostId ||
          event.generation !== capability.generation
        )
          return;
        const notification = event.value;
        const params = notification.params as {
          readonly threadId?: string;
          readonly turnId?: string | null;
        };
        if (
          params.threadId !== temporaryId ||
          (params.turnId != null && turnId !== null && params.turnId !== turnId)
        )
          return;
        if (notification.method === "turn/started") {
          turnId = (notification.params as ServerNotificationParamsByMethod["turn/started"]).turn
            .id;
          return;
        }
        if (notification.method === "item/agentMessage/delta") {
          if (params.turnId == null && turnId !== null) return;
          text += (
            notification.params as ServerNotificationParamsByMethod["item/agentMessage/delta"]
          ).delta;
          return;
        }
        if (notification.method === "item/completed") {
          if (params.turnId == null && turnId !== null) return;
          const item = (notification.params as ServerNotificationParamsByMethod["item/completed"])
            .item;
          if (item.type === "agentMessage") text = item.text;
          return;
        }
        if (notification.method === "thread/tokenUsage/updated") {
          lastTokens = (
            notification.params as ServerNotificationParamsByMethod["thread/tokenUsage/updated"]
          ).tokenUsage.last;
          return;
        }
        if (notification.method === "error") {
          turnId ??= params.turnId ?? null;
          observedError = (notification.params as ServerNotificationParamsByMethod["error"]).error;
          return;
        }
        if (notification.method !== "turn/completed") return;
        const turn = (notification.params as ServerNotificationParamsByMethod["turn/completed"])
          .turn;
        if (turnId !== null && turn.id !== turnId) return;
        turnId = turn.id;
        completed = true;
        if (turn.status !== "completed") {
          yield* Deferred.fail(
            result,
            fail("turn-failed", input.threadId, turn.error ?? observedError),
          );
          return;
        }
        const parsed = yield* Effect.try({
          try: () => JSON.parse(text.trim()) as unknown,
          catch: (cause) => fail("invalid-result", input.threadId, cause),
        }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(parsedResult)),
          Effect.mapError((cause) => fail("invalid-result", input.threadId, cause)),
          Effect.result,
        );
        if (parsed._tag === "Failure") {
          yield* Deferred.fail(result, parsed.failure);
          return;
        }
        const current = yield* assertCurrent(input, capability).pipe(Effect.result);
        if (current._tag === "Failure") {
          yield* Deferred.fail(result, current.failure);
          return;
        }
        const finishedAt = yield* Clock.currentTimeMillis;
        const configuredEffort = configuration.prediction_reasoning_effort || null;
        const value: CodexComposerPredictionResult = {
          requestedAt: new Date(startedAt).toISOString(),
          text: parsed.success.suggestion?.trim() || null,
          predictionThreadId: temporaryId,
          predictionTurnId: turn.id,
          sourceTurnId: input.latestTurnId,
          generationTrigger: input.generationTrigger,
          model: parent.model,
          reasoningEffort: configuredEffort ?? parent.reasoningEffort ?? null,
          serviceTier: parent.serviceTier ?? null,
          parentReasoningEffort: parent.reasoningEffort ?? null,
          configuredReasoningEffort: configuredEffort,
          promptVersion: configuration.prompt_version,
          totalDurationMs: Math.round(finishedAt - startedAt),
          inputTokens: lastTokens?.inputTokens ?? null,
          cachedInputTokens: lastTokens?.cachedInputTokens ?? null,
        };
        yield* Deferred.succeed(result, value);
      });
      yield* gateway.events.pipe(Stream.runForEach(observe), Effect.forkScoped);
      yield* Effect.yieldNow;
      // A logical cancellation cannot retract a dispatched Turn. Its late ACK still owns cleanup.
      const acknowledgement = yield* gateway
        .requestOnHost(
          input.hostId,
          "turn/start",
          {
            threadId: temporaryId,
            clientUserMessageId: randomUUID(),
            input: [
              {
                type: "text",
                text: `${configuration.prompt}\n\nReturn only JSON matching this schema: ${outputSchema}.`,
                text_elements: [],
              },
            ],
            turnTrigger: "composer_predictions",
            effort: configuration.prediction_reasoning_effort || null,
            outputSchema: null,
          },
          { ...fence, source: "composer_predictions" },
        )
        .pipe(
          Effect.tap((response) =>
            Effect.sync(() => {
              turnId = response.turn.id;
            }).pipe(
              Effect.andThen(() =>
                cancelled ? interruptKnownTurn() : assertCurrent(input, capability),
              ),
            ),
          ),
          Effect.mapError((cause) => fail("request-failed", input.threadId, cause)),
          Effect.result,
          Effect.forkIn(ownerScope, { startImmediately: true }),
        );
      const start = Fiber.join(acknowledgement).pipe(
        Effect.flatMap((acknowledged) =>
          acknowledged._tag === "Failure"
            ? Effect.fail(acknowledged.failure)
            : Deferred.await(result),
        ),
      );
      return yield* Effect.raceFirst(
        Effect.raceFirst(start, Deferred.await(result)),
        Effect.sleep(options.timeoutMs ?? 30_000).pipe(
          Effect.andThen(
            Effect.fail(fail("timeout", input.threadId, new Error("Prediction timed out"))),
          ),
        ),
      );
    }, Effect.scoped);

    const reusableEntry = Effect.fn("CodexComposerPrediction.reusableEntry")(function* (
      key: string,
      authLease: AbortSignal,
      threadId: string,
    ): Effect.fn.Return<Entry | null, CodexComposerPredictionError> {
      const entry = entries.get(key);
      if (!entry || entry.authLease !== authLease || authLease.aborted) return null;
      const capability = entry.readCapability();
      if (capability === null) return entry;
      const current = yield* capabilities
        .isCurrent(capability)
        .pipe(Effect.mapError((cause) => fail("request-failed", threadId, cause)));
      if (entries.get(key) !== entry) return yield* reusableEntry(key, authLease, threadId);
      return current ? entry : null;
    });

    const request = Effect.fn("CodexComposerPrediction.request")(function* (
      input: CodexComposerPredictionInput,
    ) {
      if (input.hostId === gateway.localHostId) {
        const found = yield* runtimeThread(input.threadId, application).pipe(
          Effect.mapError((cause) => fail("request-failed", input.threadId, cause)),
        );
        if (found) {
          const configuration = yield* options.configurationForHost(input.hostId);
          if (
            !configuration?.is_enabled ||
            !configuration.prompt.trim() ||
            input.latestTurnId === null
          )
            return null;
          return yield* found.connection
            .request("native.prediction.request", {
              threadId: input.threadId,
              latestRunId: input.latestTurnId,
              generationTrigger: input.generationTrigger,
              configuration,
            })
            .pipe(
              Effect.map((result) => result as CodexComposerPredictionResult | null),
              Effect.mapError((cause) => fail("request-failed", input.threadId, cause)),
            );
        }
      }

      const key = JSON.stringify([input.hostId, input.threadId, input.latestTurnId]);
      const admission = {
        key,
        hostId: input.hostId,
        parentThreadId: input.threadId,
        cancelled: null as Deferred.Deferred<void> | null,
        current: true,
      };
      admissions.add(admission);
      const admitted = Effect.gen(function* () {
        const capturedLease = yield* authState.captureBackendLease(input.hostId);
        if (!admission.current || capturedLease.aborted) return yield* Effect.interrupt;
        yield* watchAuthLease(input.hostId, capturedLease);
        if (!admission.current || capturedLease.aborted) return yield* Effect.interrupt;
        const configuration = yield* options.configurationForHost(input.hostId);
        if (!admission.current || capturedLease.aborted) return yield* Effect.interrupt;
        if (!configuration?.is_enabled || !configuration.prompt.trim()) return null;
        const authLease = yield* authState.backendLease(input.hostId);
        if (!admission.current || capturedLease !== authLease || authLease.aborted)
          return yield* Effect.interrupt;
        const existing = entries.get(key);
        const reusable = yield* reusableEntry(key, authLease, input.threadId);
        if (!admission.current || authLease.aborted) return yield* Effect.interrupt;
        if (reusable) {
          admissions.delete(admission);
          return yield* Fiber.join(reusable.fiber);
        }
        yield* clearEntries(
          { hostId: input.hostId, threadId: input.threadId },
          existing ? undefined : key,
          key,
        );
        if (!admission.current || authLease.aborted) return yield* Effect.interrupt;
        const admitted = yield* reusableEntry(key, authLease, input.threadId);
        if (!admission.current || authLease.aborted) return yield* Effect.interrupt;
        if (admitted) {
          admissions.delete(admission);
          return yield* Fiber.join(admitted.fiber);
        }
        const sampleRate =
          (input.generationTrigger === "live"
            ? configuration.live_sample_rate
            : configuration.catch_up_sample_rate) ??
          configuration.sample_rate ??
          1;
        let capability: CodexAppServerCapabilitySnapshot | null = null;
        const infer = run(input, configuration, (captured) => {
          capability = captured;
        });
        const operation =
          sampleRate < 1
            ? Random.next.pipe(
                Effect.flatMap((value) => (value >= sampleRate ? Effect.succeed(null) : infer)),
              )
            : infer;
        const attempt = Symbol();
        const fiber = yield* operation.pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              // Failed work has no cached data; a later explicit request may try again.
              if (Exit.isFailure(exit) && entries.get(key)?.attempt === attempt)
                entries.delete(key);
            }),
          ),
          Effect.forkIn(ownerScope, { startImmediately: false }),
        );
        if (!admission.current || authLease.aborted) {
          yield* Fiber.interrupt(fiber);
          return yield* Effect.interrupt;
        }
        entries.set(key, {
          attempt,
          hostId: input.hostId,
          authLease,
          parentThreadId: input.threadId,
          latestTurnId: input.latestTurnId,
          readCapability: () => capability,
          fiber,
        });
        // The owned inference now carries cancellation and must finish native cleanup before join settles.
        admissions.delete(admission);
        if (authLease.aborted) yield* clear({ hostId: input.hostId, threadId: input.threadId });
        return yield* Fiber.join(fiber);
      });
      return yield* Deferred.make<void>().pipe(
        Effect.flatMap((cancelled) => {
          admission.cancelled = cancelled;
          if (!admission.current) return Effect.interrupt;
          return Effect.raceFirst(
            admitted,
            Deferred.await(cancelled).pipe(Effect.andThen(Effect.interrupt)),
          );
        }),
        Effect.ensuring(Effect.sync(() => admissions.delete(admission))),
      );
    });
    const availability = Effect.fn("CodexComposerPrediction.availability")(function* (
      hostId: string,
    ) {
      const configuration = yield* options.configurationForHost(hostId);
      return {
        enabled: configuration?.is_enabled === true && configuration.prompt.trim().length > 0,
        source: configuration ? (options.configurationSource ?? null) : null,
        scope: hostId,
      };
    });
    return CodexComposerPrediction.of({
      request,
      clear: (input) =>
        clear(input).pipe(
          Effect.andThen(
            Option.isSome(application) && (!input || input.hostId === gateway.localHostId)
              ? application.value.clearPredictions(input?.threadId).pipe(Effect.ignore)
              : Effect.void,
          ),
        ),
      availability,
    });
  });

export const NODEX_COMPOSER_PREDICTION_CONFIG_ENV = "NODEX_COMPOSER_PREDICTION_CONFIG";
const hostConfiguration = Schema.Struct({
  hosts: Schema.Record(CodexComposerPredictionHost, CodexComposerPredictionConfiguration),
});
/** MainConfig captures these host-scoped assignments once; absent assignments remain unknown/off. */
export const readCodexComposerPredictionEnvironment = Effect.fn(
  "readCodexComposerPredictionEnvironment",
)(function* (environment: Readonly<Record<string, string>>) {
  const raw = environment[NODEX_COMPOSER_PREDICTION_CONFIG_ENV]?.trim();
  if (!raw) return {} as Readonly<Record<string, CodexComposerPredictionConfiguration>>;
  const parsed = yield* Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) =>
      new CodexComposerPredictionError({ reason: "request-failed", threadId: "", cause }),
  });
  const decoded = yield* Schema.decodeUnknownEffect(hostConfiguration)(parsed).pipe(
    Effect.mapError(
      (cause) =>
        new CodexComposerPredictionError({ reason: "request-failed", threadId: "", cause }),
    ),
  );
  return decoded.hosts;
});
