import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { InboxSettings } from "../../shared/inbox";
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
  type CoreInboxDispatchContext,
  type CoreInboxSuggestionRequest,
} from "../core-client/inbox-adapter";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import { getLogger } from "../logging/logger";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import {
  InboxApplication,
  type InboxApplicationError,
  type InboxSuggestionSettlement,
} from "./InboxApplication";
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

/** A durable request fixes membership; Core atomically accepts all titles and decisions. */
export const make = Effect.gen(function* () {
  const inbox = yield* InboxApplication;
  const settings = yield* ApplicationSettings;
  const runtime = yield* AgentRuntimeApplication;
  const config = yield* MainConfig;
  const fs = yield* FileSystem.FileSystem;
  const loadImages = yield* makeInboxImageLoader;
  const logger = getLogger({ component: "inbox-dispatcher" });
  const admission = yield* Semaphore.make(1);
  const fibers = yield* FiberSet.make<void, InboxApplicationError>();
  const inFlight = new Map<string, Fiber.Fiber<void, InboxApplicationError>>();
  const unsettled = new Set<string>();
  let previousPolicy: InboxSuggestionPolicy["kind"] | null = null;

  /** A Project's Inbox looks around from its primary source; anything else from the Profile. */
  const workingDirectory = Effect.fn("InboxDispatcher.workingDirectory")(function* (
    context: CoreInboxDispatchContext,
  ) {
    const { scope } = context;
    const source =
      scope.kind === "project"
        ? context.projects.find((project) => project.project_id === scope.project_id)?.sources[0]
        : undefined;
    if (!source) return config.nodexHome;
    const present = yield* fs.stat(source).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );
    return present ? source : config.nodexHome;
  });

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
        current.suggestionAgent,
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
        cwd: yield* workingDirectory(request.context),
        outputSchema: INBOX_SUGGESTION_OUTPUT_SCHEMA,
        maxOutputBytes: INBOX_SUGGESTION_MAX_OUTPUT_BYTES,
        timeoutMs: INBOX_SUGGESTION_TIMEOUT_MS,
        webSearch: true,
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

  // This runs under the admission permit, as do all changes to the request ID sets.
  const nextRequest = Effect.gen(function* () {
    const preparation = yield* readSuggestionPolicy();
    if (preparation.policy.kind === "off") {
      yield* inbox.prepareSuggestions(INBOX_SUGGESTION_BATCH, false);
      return;
    }
    // Leave messages waiting while full so the next free lane can batch them.
    if (inFlight.size >= preparation.current.suggestionConcurrency) return;
    yield* inbox.prepareSuggestions(
      INBOX_SUGGESTION_BATCH,
      preparation.policy.kind === "automatic",
    );

    // Core returns the oldest pending requests, including ones already generating.
    const requests = yield* inbox.suggestionRequests(inFlight.size + unsettled.size + 1);
    const request = requests.find(
      ({ request_id }) => !inFlight.has(request_id) && !unsettled.has(request_id),
    );
    if (!request) return;

    const latest = yield* readSuggestionPolicy();
    if (latest.policy.kind === "off") {
      yield* inbox.prepareSuggestions(INBOX_SUGGESTION_BATCH, false);
      return;
    }
    return { current: latest.current, request };
  });

  const warnUnsettled = Effect.sync(() => logger.warn("Inbox suggestion pass could not settle"));
  const recoverPass = Effect.catchCause((cause) =>
    Cause.hasInterruptsOnly(cause) ? Effect.interrupt : warnUnsettled,
  );
  type AdmittedRequest = NonNullable<Effect.Success<typeof nextRequest>>;
  const startRequest = Effect.fnUntraced(function* ({ current, request }: AdmittedRequest) {
    const fiber = yield* FiberSet.run(fibers, suggest(current, request), {
      startImmediately: false,
    });
    inFlight.set(request.request_id, fiber);
    return { requestId: request.request_id, fiber };
  }, Effect.uninterruptible);

  // The lane owns refill independently of the cancellable request it is waiting on.
  type RunningRequest = Effect.Success<ReturnType<typeof startRequest>>;
  const runLane = Effect.fnUntraced(function* (first: RunningRequest) {
    let next: RunningRequest | undefined = first;
    while (next) {
      const { requestId, fiber } = next;
      const settled = yield* Fiber.await(fiber);
      next = yield* admission.withPermit(
        Effect.gen(function* () {
          inFlight.delete(requestId);
          if (Exit.isFailure(settled) && !Cause.hasInterrupts(settled.cause)) {
            // Only an ordinary trigger may retry a request whose settlement could not commit.
            unsettled.add(requestId);
            yield* warnUnsettled;
            return;
          }
          const admitted = yield* nextRequest;
          if (admitted) return yield* startRequest(admitted);
        }),
      );
    }
  }, recoverPass);

  const trigger = admission
    .withPermit(
      Effect.gen(function* () {
        unsettled.clear();
        let next = yield* nextRequest;
        while (next) {
          // Start both fibers together so interruption cannot strand the request.
          yield* startRequest(next).pipe(
            Effect.flatMap((running) =>
              FiberSet.run(fibers, runLane(running), { startImmediately: false }),
            ),
            Effect.uninterruptible,
          );
          next = yield* nextRequest;
        }
      }),
    )
    .pipe(recoverPass);

  const reconcile = admission
    .withPermit(
      Effect.gen(function* () {
        if (inFlight.size === 0) return [];
        const pending = new Set(yield* inbox.pendingSuggestionRequestIds([...inFlight.keys()]));
        return [...inFlight].filter(([id]) => !pending.has(id)).map(([, fiber]) => fiber);
      }),
    )
    .pipe(
      // Request cleanup and lane refill can proceed without holding the admission permit.
      Effect.flatMap(Fiber.interruptAll),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.sync(() => logger.warn("Inbox suggestions could not be reconciled")),
      ),
    );

  const drain = trigger.pipe(Effect.andThen(FiberSet.awaitEmpty(fibers)));
  return { trigger, reconcile, drain };
});

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const { trigger, reconcile } = yield* make;
    const notifier = yield* DatabaseNotifierRuntime;
    const settings = yield* ApplicationSettings;
    yield* notifier.inboxInvalidations.pipe(
      Stream.runForEach(() => reconcile),
      Effect.forkScoped,
    );
    const triggers = Stream.mergeAll(
      [
        notifier.inboxInvalidations.pipe(
          Stream.filter((event) => event.reason === "inbox"),
          Stream.map(() => undefined),
        ),
        // A raised limit admits waiting messages without waiting for another message.
        settings.inboxSettingsChanges.pipe(Stream.map(() => undefined)),
        Stream.fromSchedule(Schedule.spaced(SAFETY_POLL)).pipe(
          Stream.tap(() => reconcile),
          Stream.map(() => undefined),
        ),
      ],
      { concurrency: "unbounded" },
    );
    yield* triggers.pipe(
      Stream.debounce(`${SETTLE_DELAY_MS} millis`),
      Stream.runForEach(() => trigger),
      Effect.forkScoped,
    );
    yield* Effect.sleep(`${SETTLE_DELAY_MS} millis`).pipe(
      Effect.andThen(trigger),
      Effect.forkScoped,
    );
  }),
);
