import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { inboxSuggestionChoice, type InboxSettings } from "../../shared/inbox";
import {
  inboxSuggestionPolicy,
  type InboxSuggestionPolicy,
} from "../../shared/inbox-suggestion-policy";
import { createUuidV7 } from "../../shared/uuid-v7";
import {
  AgentRuntimeApplication,
  agentRuntimeFailureReason,
} from "../agent-runtime/AgentRuntimeApplication";
import { MainConfig } from "../app/MainConfig";
import {
  inboxDispatchActionToCore,
  type CoreInboxSuggestionRequest,
} from "../core-client/inbox-adapter";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import { getLogger } from "../logging/logger";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { InboxApplication, type InboxSuggestionSettlement } from "./InboxApplication";
import {
  INBOX_SUGGESTION_BATCH,
  INBOX_SUGGESTION_MAX_OUTPUT_BYTES,
  INBOX_SUGGESTION_OUTPUT_SCHEMA,
  INBOX_SUGGESTION_TIMEOUT_MS,
  INBOX_PROMPT_VERSION,
  INBOX_SCHEMA_VERSION,
  buildInboxSuggestionPrompt,
  describeInboxRuntimeFailure,
  loggableInboxRuntimeFailure,
  validateInboxSuggestions,
} from "./inbox-suggestions";
import { resolveInboxModel } from "./InboxRuntimeSelection";
import { inboxAgentCandidates, inboxDefaultChatCandidate } from "./inbox-agent-candidates";
import { InboxRuntimeError } from "./InboxRuntimeError";
import { makeInboxImageLoader } from "./inbox-images";

const SETTLE_DELAY_MS = 1_500;
const SAFETY_POLL = "60 seconds";
const MAX_BATCHES_PER_DRAIN = 8;

/** A durable request fixes membership; Core atomically accepts all titles and decisions. */
export const make = Effect.gen(function* () {
  const inbox = yield* InboxApplication;
  const settings = yield* ApplicationSettings;
  const runtime = yield* AgentRuntimeApplication;
  const config = yield* MainConfig;
  const loadImages = yield* makeInboxImageLoader;
  const logger = getLogger({ component: "inbox-dispatcher" });
  const lane = yield* Semaphore.make(1);
  let previousPolicy: InboxSuggestionPolicy["kind"] | null = null;

  const suggest = Effect.fn("InboxDispatcher.suggest")(function* (
    current: InboxSettings,
    request: CoreInboxSuggestionRequest,
  ) {
    if (request.context.entries.some((entry) => entry.source.kind === "scheduled_task")) {
      yield* inbox.settleSuggestion({
        request_id: request.request_id,
        generation: request.generation,
        titles: [],
        suggestions: [],
        produced_by: null,
        error: "A scheduled run takes its decision from its task.",
      });
      return;
    }
    const identity = {
      requestId: request.request_id,
      generation: request.generation,
      mode: request.mode,
      correction: request.correction,
    };
    const startedAt = yield* Clock.currentTimeMillis;
    const outcome = yield* Effect.gen(function* () {
      const modelSelection = yield* resolveInboxModel(
        runtime,
        inboxSuggestionChoice(current),
        "suggestion",
      );
      const providers = yield* runtime.catalog();
      // The suggestion chooses each new chat's models only while the user lets it.
      const agents = current.suggestionsChooseModels
        ? {
            candidates: inboxAgentCandidates(providers, {
              now: yield* Clock.currentTimeMillis,
              useModelGuide: current.useModelGuide,
            }),
            defaultChat: inboxDefaultChatCandidate(providers, current.chatAgent),
          }
        : null;
      const references = request.context.entries.flatMap((entry) => entry.images);
      const loaded = yield* loadImages(references);
      const prompt = yield* Effect.try({
        try: () =>
          buildInboxSuggestionPrompt({
            context: request.context,
            instructions: current.instructions,
            request: identity,
            agents,
            attachedImageMarkers: loaded.attachedMarkers,
          }),
        catch: (cause) =>
          new InboxRuntimeError({
            message: cause instanceof Error ? cause.message : "The suggestion input is invalid",
          }),
      });
      const provider = providers.find(
        (candidate) => candidate.instanceId === modelSelection.instanceId,
      );
      // Provenance records the actual selection. Captured bodies and correction text never enter logs.
      logger.info("Inbox suggestion requested", {
        requestId: request.request_id,
        generation: request.generation,
        instanceId: modelSelection.instanceId,
        model: modelSelection.model,
        options: modelSelection.options,
        providerVersion: provider?.version,
        promptVersion: INBOX_PROMPT_VERSION,
        schemaVersion: INBOX_SCHEMA_VERSION,
        inputBytes: Buffer.byteLength(prompt),
        memberCount: request.page_ids.length,
        imageCount: references.length,
        attachedImageCount: loaded.images.length,
        unavailableImageCount: references.length - loaded.images.length,
      });
      const output = yield* runtime.generateStructured({
        modelSelection,
        prompt,
        images: loaded.images,
        cwd: config.nodexHome,
        outputSchema: INBOX_SUGGESTION_OUTPUT_SCHEMA,
        maxOutputBytes: INBOX_SUGGESTION_MAX_OUTPUT_BYTES,
        timeoutMs: INBOX_SUGGESTION_TIMEOUT_MS,
      });
      const validated = yield* Effect.try({
        try: () =>
          validateInboxSuggestions(
            output,
            request.context,
            request.context.entries,
            identity,
            agents?.candidates ?? [],
          ),
        catch: () => new InboxRuntimeError({ message: "The Agent returned an invalid suggestion" }),
      });
      return {
        validated,
        // Read beside the suggestion, so it names the Agent and model as the user knows them.
        producedBy: [
          provider?.displayName ?? modelSelection.instanceId,
          provider?.models.find((model) => model.slug === modelSelection.model)?.name ??
            modelSelection.model,
        ]
          .join(" · ")
          .slice(0, 256),
      };
    }).pipe(Effect.result);
    const base = { request_id: request.request_id, generation: request.generation };
    if (outcome._tag === "Failure") {
      const reason = agentRuntimeFailureReason(outcome.failure);
      // A warning, so a development run prints it beside the app. The matching "requested" line
      // names the model and input size; captured text never enters the log.
      logger.warn("Inbox suggestion failed", {
        requestId: request.request_id,
        generation: request.generation,
        elapsedMs: (yield* Clock.currentTimeMillis) - startedAt,
        reason: loggableInboxRuntimeFailure(reason),
      });
      yield* inbox.settleSuggestion({
        ...base,
        titles: [],
        suggestions: [],
        produced_by: null,
        error: describeInboxRuntimeFailure(reason, "suggestion"),
      });
      return;
    }
    const { validated, producedBy } = outcome.success;
    const suggestions: InboxSuggestionSettlement["suggestions"] = validated.suggestions.map(
      (suggestion) => ({
        proposal_id: createUuidV7(),
        page_ids: [...suggestion.pageIds],
        action: inboxDispatchActionToCore(suggestion.action),
        entry_kind: suggestion.kind,
        summary: suggestion.summary,
        rationale: suggestion.rationale,
      }),
    );
    yield* inbox.settleSuggestion({
      ...base,
      titles: [...validated.titles].map(([page_id, title]) => ({ page_id, title })),
      suggestions,
      produced_by: producedBy,
      error: null,
    });
  });

  // Generation and Core requests yield: spending decisions cannot be cached across a drain.
  const readSuggestionPolicy = Effect.fn("InboxDispatcher.readSuggestionPolicy")(function* () {
    const snapshot = yield* settings.snapshot();
    const providers = yield* runtime.catalog();
    const policy = inboxSuggestionPolicy(snapshot.inbox, providers, yield* Clock.currentTimeMillis);
    if (policy.kind === "paused" && previousPolicy !== "paused")
      logger.info("Inbox automatic suggestions paused", { ...policy.pause });
    if (policy.kind === "automatic" && previousPolicy === "paused")
      logger.info("Inbox automatic suggestions resumed");
    previousPolicy = policy.kind;
    return { current: snapshot.inbox, policy };
  });

  const drain = lane.withPermits(1)(
    Effect.gen(function* () {
      for (let batch = 0; batch < MAX_BATCHES_PER_DRAIN; batch += 1) {
        const preparation = yield* readSuggestionPolicy();
        // Each send is considered once. Core releases waiting messages when automatic advice yields.
        yield* inbox.prepareSuggestions(
          INBOX_SUGGESTION_BATCH,
          preparation.policy.kind === "automatic",
        );
        if (preparation.policy.kind === "off") return;
        const [request] = yield* inbox.suggestionRequests(1);
        if (!request) return;
        const admission = yield* readSuggestionPolicy();
        if (admission.policy.kind === "off") {
          yield* inbox.prepareSuggestions(INBOX_SUGGESTION_BATCH, false);
          return;
        }
        yield* suggest(admission.current, request);
      }
    }).pipe(
      Effect.catchCause(() =>
        Effect.sync(() => logger.warn("Inbox suggestion pass could not settle")),
      ),
    ),
  );
  return { drain };
});

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const { drain } = yield* make;
    const notifier = yield* DatabaseNotifierRuntime;
    const triggers = Stream.merge(
      notifier.inboxInvalidations.pipe(
        Stream.filter((event) => event.reason === "inbox"),
        Stream.map(() => undefined),
      ),
      Stream.fromSchedule(Schedule.spaced(SAFETY_POLL)).pipe(Stream.map(() => undefined)),
    );
    yield* triggers.pipe(
      Stream.debounce(`${SETTLE_DELAY_MS} millis`),
      Stream.runForEach(() => drain),
      Effect.forkScoped,
    );
    yield* Effect.sleep(`${SETTLE_DELAY_MS} millis`).pipe(Effect.andThen(drain), Effect.forkScoped);
  }),
);
