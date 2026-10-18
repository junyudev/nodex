import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { InboxSettings } from "../../shared/inbox";
import { createUuidV7 } from "../../shared/uuid-v7";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
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
  validateInboxSuggestions,
} from "./inbox-suggestions";
import { resolveInboxModel } from "./InboxRuntimeSelection";
import { InboxRuntimeError } from "./InboxRuntimeError";

const SETTLE_DELAY_MS = 1_500;
const SAFETY_POLL = "60 seconds";
const MAX_BATCHES_PER_DRAIN = 8;

/** A durable request fixes membership; Core atomically accepts all titles and decisions. */
export const make = Effect.gen(function* () {
  const inbox = yield* InboxApplication;
  const settings = yield* ApplicationSettings;
  const runtime = yield* AgentRuntimeApplication;
  const config = yield* MainConfig;
  const logger = getLogger({ component: "inbox-dispatcher" });
  const lane = yield* Semaphore.make(1);

  const suggest = Effect.fn("InboxDispatcher.suggest")(function* (
    current: InboxSettings,
    request: CoreInboxSuggestionRequest,
  ) {
    const identity = {
      requestId: request.request_id,
      generation: request.generation,
      mode: request.mode,
      correction: request.correction,
    };
    const outcome = yield* Effect.gen(function* () {
      const modelSelection = yield* resolveInboxModel(
        runtime,
        current.suggestionAgent,
        current.suggestionModel,
        undefined,
        "suggestion",
      );
      const prompt = yield* Effect.try({
        try: () =>
          buildInboxSuggestionPrompt({
            context: request.context,
            instructions: current.instructions,
            request: identity,
          }),
        catch: (cause) =>
          new InboxRuntimeError({
            message: cause instanceof Error ? cause.message : "The suggestion input is invalid",
          }),
      });
      const provider = (yield* runtime.catalog()).find(
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
      });
      const output = yield* runtime.generateStructured({
        modelSelection,
        prompt,
        cwd: config.nodexHome,
        outputSchema: INBOX_SUGGESTION_OUTPUT_SCHEMA,
        maxOutputBytes: INBOX_SUGGESTION_MAX_OUTPUT_BYTES,
        timeoutMs: INBOX_SUGGESTION_TIMEOUT_MS,
      });
      const validated = yield* Effect.try({
        try: () =>
          validateInboxSuggestions(output, request.context, request.context.entries, identity),
        catch: () => new InboxRuntimeError({ message: "The Agent returned an invalid suggestion" }),
      });
      return {
        validated,
        producedBy: `${modelSelection.instanceId} · ${modelSelection.model}`.slice(0, 256),
      };
    }).pipe(Effect.result);
    const base = { request_id: request.request_id, generation: request.generation };
    if (outcome._tag === "Failure") {
      logger.info("Inbox suggestion failed", {
        requestId: request.request_id,
        generation: request.generation,
      });
      yield* inbox.settleSuggestion({
        ...base,
        titles: [],
        suggestions: [],
        produced_by: null,
        error: describeInboxRuntimeFailure(outcome.failure.message, "suggestion"),
      });
      return;
    }
    const { validated, producedBy } = outcome.success;
    const suggestions: InboxSuggestionSettlement["suggestions"] = [
      ...validated.suggestions.map((suggestion) => ({
        proposal_id: createUuidV7(),
        page_ids: [...suggestion.pageIds],
        action: inboxDispatchActionToCore(suggestion.action),
        entry_kind: suggestion.kind,
        summary: suggestion.summary,
        rationale: suggestion.rationale,
      })),
      ...validated.none.map((suggestion) => ({
        proposal_id: createUuidV7(),
        page_ids: [...suggestion.pageIds],
        action: { type: "none" as const, reason: suggestion.reason },
        entry_kind: null,
        summary: suggestion.reason,
        rationale: null,
      })),
    ];
    yield* inbox.settleSuggestion({
      ...base,
      titles: [...validated.titles].map(([page_id, title]) => ({ page_id, title })),
      suggestions,
      produced_by: producedBy,
      error: null,
    });
  });

  const drain = lane.withPermits(1)(
    Effect.gen(function* () {
      const snapshot = yield* settings.snapshot();
      if (!snapshot.inbox.suggestionsEnabled) return;
      for (let batch = 0; batch < MAX_BATCHES_PER_DRAIN; batch += 1) {
        yield* inbox.prepareSuggestions(INBOX_SUGGESTION_BATCH);
        const [request] = yield* inbox.suggestionRequests(1);
        if (!request) return;
        yield* suggest(snapshot.inbox, request);
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
