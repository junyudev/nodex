import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { InboxSettings } from "../../shared/inbox";
import {
  inboxSuggestionPolicy,
  type InboxSuggestionPolicy,
} from "../../shared/inbox-suggestion-policy";
import {
  AgentRuntimeApplication,
  agentRuntimeFailureReason,
} from "../../main/agent-runtime/AgentRuntimeApplication";
import { CoordinatorSession } from "../coordinator/CoordinatorSession";
import type { CoreInboxSuggestionRequest } from "../../main/core-client/inbox-adapter";
import { DatabaseNotifierRuntime } from "../../main/host-runtime/DatabaseNotifierRuntime";
import { getLogger } from "../../main/logging/logger";
import { ApplicationSettings } from "../../main/settings/ApplicationSettings";
import { InboxApplication, type InboxApplicationError } from "./InboxApplication";
import {
  INBOX_SUGGESTION_BATCH,
  inboxRoutingIdentity,
  renderInboxRoutingRequest,
  renderInboxRoutingFollowup,
  describeInboxRuntimeFailure,
  loggableInboxRuntimeFailure,
} from "./inbox-suggestions";
import { InboxRuntimeError } from "./InboxRuntimeError";
import { inboxPromptImages, makeInboxImageLoader } from "./inbox-images";
import { make as makeRoutingContext } from "./InboxRoutingContext";

const SETTLE_DELAY_MS = 1_500;
const SAFETY_POLL = "60 seconds";
/** Core retains requests and deadlines; Runtime retains admission, never an in-memory callback waiter. */
export const make = Effect.gen(function* () {
  const inbox = yield* InboxApplication;
  const settings = yield* ApplicationSettings;
  const runtime = yield* AgentRuntimeApplication;
  const coordinator = yield* CoordinatorSession;
  const prepareContext = yield* makeRoutingContext;
  const loadImages = yield* makeInboxImageLoader;
  const logger = getLogger({ component: "inbox-dispatcher" });
  const admission = yield* Semaphore.make(1);
  const fibers = yield* FiberSet.make<void, InboxApplicationError>();
  const inFlight = new Map<string, Fiber.Fiber<void, InboxApplicationError>>();
  const unsettled = new Set<string>();
  let previousPolicy: InboxSuggestionPolicy["kind"] | null = null;

  const fail = Effect.fn("InboxDispatcher.fail")(function* (
    request: CoreInboxSuggestionRequest,
    reason: string,
  ) {
    logger.warn("Inbox suggestion failed", {
      requestId: request.request_id,
      generation: request.generation,
      reason: loggableInboxRuntimeFailure(reason),
    });
    yield* inbox.settleSuggestion({
      request_id: request.request_id,
      generation: request.generation,
      titles: [],
      suggestions: [],
      produced_by: null,
      error: describeInboxRuntimeFailure(reason, "suggestion"),
      automatic_dispatch: false,
    });
  });
  const suggest = Effect.fn("InboxDispatcher.suggest")(function* (
    current: InboxSettings,
    picked: CoreInboxSuggestionRequest,
  ) {
    let request = picked;
    if (yield* inbox.executionHeld({ pageIds: request.context.entries.map((e) => e.page_id) }))
      return;
    if (!request.delivery) {
      const session = yield* coordinator.ensure().pipe(Effect.result);
      if (session._tag === "Failure")
        return yield* fail(request, agentRuntimeFailureReason(session.failure));
      yield* inbox.beginRouting(request, session.success);
      const begun = yield* inbox.suggestionRequest(request.request_id);
      if (!begun || begun.generation !== request.generation) return;
      request = begun;
    }
    const delivery = request.delivery;
    if (!delivery) return;
    const identity = inboxRoutingIdentity(request);
    let accepted = false;
    let followupAccepted = false;
    while (true) {
      const pending = yield* inbox.suggestionRequest(request.request_id);
      if (!pending || pending.generation !== request.generation) return;
      if (yield* inbox.executionHeld({ pageIds: pending.context.entries.map((e) => e.page_id) })) {
        yield* Effect.sleep("1 second");
        continue;
      }
      if (!accepted) {
        const receipt = yield* runtime
          .messageAdmission({
            sessionId: delivery.coordinator_session_id,
            messageId: identity.messageId,
          })
          .pipe(Effect.result);
        if (receipt._tag === "Success" && receipt.success?.status === "rejected")
          return yield* fail(
            request,
            receipt.success.error || "The Coordinator rejected this message",
          );
        accepted = receipt._tag === "Success" && receipt.success?.status === "accepted";
      }
      const routing = yield* inbox.routingStatus(pending);
      if (routing.failureMessage) return yield* fail(request, routing.failureMessage);
      const deadline = routing.deadline;
      const left = deadline - (yield* Clock.currentTimeMillis);
      if (left <= 0) return yield* fail(request, "The suggestion agent timed out");
      const followup = routing.needsFollowup;
      if (followup ? !followupAccepted : !accepted) {
        const messageIdentity = followup ? inboxRoutingIdentity(request, true) : identity;
        const attempt = yield* Effect.gen(function* () {
          const receipt = yield* runtime.messageAdmission({
            sessionId: delivery.coordinator_session_id,
            messageId: messageIdentity.messageId,
          });
          if (receipt?.status === "accepted") return true;
          if (receipt?.status === "rejected") {
            yield* fail(request, receipt.error || "The Coordinator rejected this message");
            return "settled" as const;
          }
          // Reset never redirects uncertain requests to a different Coordinator.
          if (!(yield* coordinator.isCoordinator(delivery.coordinator_session_id))) return false;
          if ((yield* settings.snapshot()).inbox.suggestions === "off") return false;
          const context = yield* prepareContext(current).pipe(
            Effect.tapError((error) => fail(request, agentRuntimeFailureReason(error))),
          );
          if (
            yield* inbox.executionHeld({ pageIds: request.context.entries.map((e) => e.page_id) })
          )
            return false;
          if (followup) {
            const latest = yield* inbox.suggestionRequest(request.request_id);
            if (!latest || latest.generation !== request.generation) return "settled" as const;
            yield* runtime.sendMessage({
              sessionId: delivery.coordinator_session_id,
              origin: "host",
              mode: "queue",
              messageFingerprint: messageIdentity.fingerprint,
              message: {
                messageId: messageIdentity.messageId,
                text: renderInboxRoutingFollowup(latest),
                modelSelection: context.modelSelection,
                images: [],
                agentConfigs: [],
              },
            });
            return true;
          }
          const loaded = yield* loadImages(
            request.context.entries.flatMap((entry) => entry.images),
          );
          const text = yield* Effect.try({
            try: () =>
              renderInboxRoutingRequest({
                context: request.context,
                instructions: current.instructions,
                request: {
                  requestId: request.request_id,
                  generation: request.generation,
                  mode: request.mode,
                  correction: request.correction,
                },
                agents: context.agents,
                attachedImageMarkers: loaded.attachedMarkers,
              }),
            catch: (cause) =>
              new InboxRuntimeError({
                message: cause instanceof Error ? cause.message : "The suggestion input is invalid",
              }),
          }).pipe(Effect.tapError((error) => fail(request, error.message)));
          yield* runtime.sendMessage({
            sessionId: delivery.coordinator_session_id,
            origin: "host",
            mode: "queue",
            messageFingerprint: messageIdentity.fingerprint,
            message: {
              messageId: messageIdentity.messageId,
              text,
              modelSelection: context.modelSelection,
              images: inboxPromptImages(loaded),
              agentConfigs: [],
            },
          });
          return true;
        }).pipe(Effect.timeout(`${Math.min(left, 30_000)} millis`), Effect.result);
        if (attempt._tag === "Success" && attempt.success === "settled") return;
        if (attempt._tag === "Success") {
          if (followup) followupAccepted = attempt.success === true;
          else accepted = attempt.success === true;
        }
        if (attempt._tag === "Failure")
          logger.debug("Inbox routing awaits admission reconciliation", {
            requestId: request.request_id,
            generation: request.generation,
            reason: loggableInboxRuntimeFailure(agentRuntimeFailureReason(attempt.failure)),
          });
        if (attempt._tag === "Success" && attempt.success === true) continue;
      }
      yield* Effect.sleep(
        `${Math.min(1000, Math.max(1, deadline - (yield* Clock.currentTimeMillis)))} millis`,
      );
    }
  });
  const readPolicy = Effect.fn("InboxDispatcher.readPolicy")(function* () {
    const current = (yield* settings.snapshot()).inbox;
    const policy = inboxSuggestionPolicy(
      current,
      yield* runtime.catalog(),
      yield* Clock.currentTimeMillis,
    );
    if (policy.kind === "paused" && previousPolicy !== "paused")
      logger.info("Inbox automatic suggestions paused", { ...policy.pause });
    if (policy.kind === "automatic" && previousPolicy === "paused")
      logger.info("Inbox automatic suggestions resumed");
    previousPolicy = policy.kind;
    return { current, policy };
  });
  // This runs under the admission permit, as do all changes to the request ID sets.
  const nextRequest = Effect.gen(function* () {
    if (yield* inbox.executionHeld()) return;
    const preparation = yield* readPolicy();
    if (preparation.policy.kind === "off")
      yield* inbox.prepareSuggestions(INBOX_SUGGESTION_BATCH, false);
    if (inFlight.size >= preparation.current.suggestionConcurrency) return;
    if (preparation.policy.kind !== "off")
      yield* inbox.prepareSuggestions(
        INBOX_SUGGESTION_BATCH,
        preparation.policy.kind === "automatic",
      );

    // Already admitted requests retain their settlement deadline when suggestions turn off.
    const requests = yield* inbox.suggestionRequests(
      inFlight.size + unsettled.size + (preparation.policy.kind === "off" ? 16 : 1),
    );
    const request = requests.find(
      (item) =>
        !inFlight.has(item.request_id) &&
        !unsettled.has(item.request_id) &&
        (preparation.policy.kind !== "off" ||
          (item.delivery !== undefined && item.delivery !== null)),
    );
    if (!request) return;

    const latest = yield* readPolicy();
    if (latest.policy.kind === "off" && !request.delivery) {
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
    const fiber = yield* FiberSet.run(
      fibers,
      request.context.entries.some(
        (entry) => entry.source.kind === "automation" || entry.source.kind === "nodex",
      )
        ? fail(request, "This message does not receive routing suggestions")
        : suggest(current, request),
      {
        startImmediately: false,
      },
    );
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
      yield* inbox.cancelledRoutingDeliveries([requestId]).pipe(
        Effect.flatMap((deliveries) =>
          Effect.forEach(
            deliveries,
            (delivery) =>
              Effect.forEach(
                [false, true],
                (followup) =>
                  runtime.stopHostInput({
                    sessionId: delivery.coordinator_session_id,
                    messageId: inboxRoutingIdentity(delivery, followup).messageId,
                  }),
                { discard: true },
              ),
            { discard: true },
          ),
        ),
        recoverPass,
      );
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
        yield* inbox.autoConfirm;
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
