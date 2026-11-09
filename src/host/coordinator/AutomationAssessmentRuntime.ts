import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { resolveInboxModel } from "../inbox-application/InboxRuntimeSelection";
import { spaceHeld } from "../work-application/execution-holds";
import { CoordinatorSession } from "./CoordinatorSession";
import {
  assessmentIdentity,
  makeAssessmentDelivery,
  renderAssessmentRequest,
} from "./automation-assessment-delivery";

export const make = Effect.gen(function* () {
  const delivery = yield* makeAssessmentDelivery;
  const runtime = yield* AgentRuntimeApplication;
  const coordinator = yield* CoordinatorSession;
  const settings = yield* ApplicationSettings;
  const core = yield* CoreModules;
  const lane = yield* Semaphore.make(1);
  const logger = getLogger({ component: "automation-assessments" });
  const tick = lane.withPermits(1)(
    Effect.gen(function* () {
      if (yield* spaceHeld(core)) return;
      const pending = yield* delivery.read({ kind: "pending", limit: 8 });
      if (pending.kind !== "pending") return;
      for (const picked of pending.requests) {
        yield* Effect.gen(function* () {
          let r = picked;
          if (!r.coordinator_session_id) {
            const session = yield* coordinator.ensure();
            yield* delivery.apply({
              kind: "begin",
              request_id: r.request_id,
              generation: r.generation,
              coordinator_session_id: session,
            });
            const current = yield* delivery.request(r.request_id);
            if (!current || current.generation !== r.generation || !current.coordinator_session_id)
              return;
            r = current;
          }
          const sessionId = r.coordinator_session_id!;
          if (!(yield* coordinator.isCoordinator(sessionId))) {
            yield* delivery.apply({
              kind: "fail",
              request_id: r.request_id,
              generation: r.generation,
              reason: "The Coordinator changed before completing this assessment",
            });
            return;
          }
          const status = yield* delivery.status(r);
          if (status.failure) {
            yield* delivery.apply({
              kind: "fail",
              request_id: r.request_id,
              generation: r.generation,
              reason: status.failure,
            });
            return;
          }
          const identity = assessmentIdentity(r, status.followup);
          const receipt = yield* runtime.messageAdmission({
            sessionId,
            messageId: identity.messageId,
          });
          if (receipt?.status === "accepted") return;
          if (receipt?.status === "rejected") {
            yield* delivery.apply({
              kind: "fail",
              request_id: r.request_id,
              generation: r.generation,
              reason: receipt.error ?? "The Coordinator rejected this assessment",
            });
            return;
          }
          const current = (yield* settings.snapshot()).inbox;
          const modelSelection = yield* resolveInboxModel(
            runtime,
            current.suggestionAgent,
            "suggestion",
          );
          yield* runtime.sendMessage({
            sessionId,
            origin: "host",
            mode: "queue",
            messageFingerprint: identity.fingerprint,
            message: {
              messageId: identity.messageId,
              text: renderAssessmentRequest(r, status.followup),
              modelSelection,
              images: [],
              agentConfigs: [],
            },
          });
        }).pipe(
          Effect.timeout("30 seconds"),
          Effect.catchCause(() =>
            Effect.sync(() =>
              logger.debug("Automation assessment awaits admission reconciliation", {
                requestId: picked.request_id,
              }),
            ),
          ),
        );
      }
    }),
  );
  return { tick };
});
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const { tick } = yield* make;
    const notifier = yield* DatabaseNotifierRuntime;
    yield* Stream.mergeAll(
      [
        notifier.inboxInvalidations.pipe(Stream.map(() => undefined)),
        Stream.fromSchedule(Schedule.spaced("1 second")).pipe(Stream.map(() => undefined)),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Stream.runForEach(() => tick),
      Effect.forkScoped,
    );
    yield* tick.pipe(Effect.forkScoped);
  }),
);
