import { makeInboxSkills } from "./inbox-skills";
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
import { DecisionRuns } from "../nodex-decisions/DecisionRuns";
import type { CoreInboxSuggestionRequest } from "../../main/core-client/inbox-adapter";
import { DatabaseNotifierRuntime } from "../../main/host-runtime/DatabaseNotifierRuntime";
import { getLogger } from "../../main/logging/logger";
import { ApplicationSettings } from "../../main/settings/ApplicationSettings";
import { InboxApplication } from "./InboxApplication";
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
  const decisions = yield* DecisionRuns;
  const skillInventory = yield* makeInboxSkills;
  const prepareContext = yield* makeRoutingContext;
  const loadImages = yield* makeInboxImageLoader;
  const logger = getLogger({ component: "inbox-dispatcher" });
  const admission = yield* Semaphore.make(1);
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
      return "deferred" as const;
    if (!request.delivery) {
      const prepared = yield* prepareContext(current).pipe(Effect.result);
      if (prepared._tag === "Failure")
        return yield* fail(request, agentRuntimeFailureReason(prepared.failure));
      const context = prepared.success;
      // Leave room for the optional inventory before freezing what Nodex can validate.
      const inputBudget = Buffer.byteLength(
        JSON.stringify([request.context, current.instructions, context.agents, request.correction]),
      );
      const offers =
        inputBudget < 180 * 1024
          ? yield* skillInventory.offers(
              request.context,
              context.defaultChat?.instance_id,
              context.agents?.candidates.map((candidate) => candidate.instance_id) ?? [],
            )
          : [];
      const title = yield* decisions.routingTitle(request.page_ids);
      const decision = {
        kind: "routing" as const,
        request_id: request.request_id,
        generation: request.generation,
      };
      const reservation = yield* decisions
        .begin(decision, title, (sessionId) => inbox.beginRouting(request, sessionId, offers))
        .pipe(Effect.result);
      const begun = yield* inbox.suggestionRequest(request.request_id);
      if (!begun || begun.generation !== request.generation) return;
      if (!begun.delivery && (yield* settings.snapshot()).inbox.suggestions === "off") return;
      if (!begun.delivery && reservation._tag === "Failure") {
        if (reservation.failure instanceof InboxRuntimeError)
          return yield* fail(request, reservation.failure.message);
        if (!(yield* inbox.executionHeld({ pageIds: request.page_ids })))
          return yield* Effect.fail(reservation.failure);
      }
      // An unreserved request must release its worker so existing reservations can resume.
      if (!begun.delivery) return "deferred" as const;
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
            sessionId: delivery.decision_session_id,
            messageId: identity.messageId,
          })
          .pipe(Effect.timeout("5 seconds"), Effect.result);
        if (receipt._tag === "Success" && receipt.success?.status === "rejected")
          return yield* fail(
            request,
            receipt.success.error || "Nodex rejected this routing message",
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
            sessionId: delivery.decision_session_id,
            messageId: messageIdentity.messageId,
          });
          if (receipt?.status === "accepted") return true;
          if (receipt?.status === "rejected") {
            yield* fail(request, receipt.error || "Nodex rejected this routing message");
            return "settled" as const;
          }
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
              sessionId: delivery.decision_session_id,
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
                skillOffers: delivery.skill_offers ?? [],
                attachedImageMarkers: loaded.attachedMarkers,
              }),
            catch: (cause) =>
              new InboxRuntimeError({
                message: cause instanceof Error ? cause.message : "The suggestion input is invalid",
              }),
          }).pipe(Effect.tapError((error) => fail(request, error.message)));
          yield* runtime.sendMessage({
            sessionId: delivery.decision_session_id,
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
  type RoutingError = Effect.Error<ReturnType<typeof suggest>>;
  type RoutingResult = Effect.Success<ReturnType<typeof suggest>>;
  const fibers = yield* FiberSet.make<RoutingResult, RoutingError>();
  const inFlight = new Map<string, Fiber.Fiber<RoutingResult, RoutingError>>();
  const readPolicy = Effect.fn("InboxDispatcher.readPolicy")(function* () {
    const current = (yield* settings.snapshot()).inbox;
    const catalog =
      current.suggestions === "automatic"
        ? yield* runtime.catalog().pipe(Effect.timeout("5 seconds"), Effect.result)
        : null;
    // Durable deliveries still need settlement when their execution owner is unavailable.
    const policy =
      catalog?._tag === "Failure"
        ? { kind: "on_request" as const }
        : inboxSuggestionPolicy(current, catalog?.success ?? [], yield* Clock.currentTimeMillis);
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
    if (!request || (!request.delivery && !(yield* decisions.hasCapacity("routing")))) return;

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
      next = yield* admission.withPermit(
        Effect.gen(function* () {
          inFlight.delete(requestId);
          if (Exit.isFailure(settled) && !Cause.hasInterrupts(settled.cause)) {
            // Only an ordinary trigger may retry a request whose settlement could not commit.
            unsettled.add(requestId);
            yield* warnUnsettled;
            return;
          }
          if (Exit.isSuccess(settled) && settled.value === "deferred") unsettled.add(requestId);
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
