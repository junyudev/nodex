import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { AgentRuntimeApplication } from "../../main/agent-runtime/AgentRuntimeApplication";
import { DatabaseNotifierRuntime } from "../../main/host-runtime/DatabaseNotifierRuntime";
import { ApplicationSettings } from "../../main/settings/ApplicationSettings";
import { resolveInboxModel } from "../inbox-application/InboxRuntimeSelection";
import { spaceHeld } from "../work-application/execution-holds";
import { CoreModules } from "../../main/core-runtime/CoreModules";
import { getLogger } from "../../main/logging/logger";
import { ASSESSMENT_CAPACITY, DecisionRuns } from "./DecisionRuns";
import {
  assessmentIdentity,
  makeAssessmentDelivery,
  renderAssessmentRequest,
} from "./automation-assessment-delivery";

const assessmentSubject = Effect.fnUntraced(function* (
  core: CoreModules["Service"],
  threadId: string,
) {
  const match = /^github:([^:]+):([^:]+):(\d+)$/u.exec(threadId);
  if (!match) return "an event";
  const [, host, repositoryId, number] = match;
  const lowerBound =
    threadId.slice(0, -1) + String.fromCharCode(threadId.charCodeAt(threadId.length - 1) - 1) + ":";
  // A bounded Source window can select this thread by its immediately preceding numeric range.
  const snapshot = yield* core.workspace.read({
    kind: "sources",
    read: {
      kind: "threads",
      host: host!,
      repository_id: repositoryId!,
      after_id: lowerBound,
      limit: 1,
    },
  });
  if (snapshot.value.kind === "sources" && snapshot.value.value.kind === "threads") {
    const thread = snapshot.value.value.threads[0];
    if (thread?.id === threadId) return `${thread.repository} #${thread.number}`;
  }
  return `GitHub #${number}`;
});

export const make = Effect.gen(function* () {
  const delivery = yield* makeAssessmentDelivery;
  const runtime = yield* AgentRuntimeApplication;
  const decisions = yield* DecisionRuns;
  const settings = yield* ApplicationSettings;
  const core = yield* CoreModules;
  const lane = yield* Semaphore.make(1);
  const logger = getLogger({ component: "automation-assessments" });
  const tick = lane.withPermits(1)(
    Effect.gen(function* () {
      if (yield* spaceHeld(core)) return;
      const pending = yield* delivery.read({ kind: "pending", limit: ASSESSMENT_CAPACITY });
      if (pending.kind !== "pending") return;
      for (const picked of pending.requests) {
        yield* Effect.gen(function* () {
          let r = picked;
          if (!r.decision_session_id) {
            const decision = {
              kind: "assessment" as const,
              request_id: r.request_id,
              generation: r.generation,
            };
            const begun = yield* decisions.begin(
              decision,
              `Nodex · Assessing ${yield* assessmentSubject(core, r.thread_id)}`,
              (decision_session_id) =>
                delivery
                  .apply({ ...decision, kind: "begin", decision_session_id })
                  .pipe(Effect.asVoid),
            );
            if (!begun) return;
            const current = yield* delivery.request(r.request_id);
            if (!current || current.generation !== r.generation || !current.decision_session_id)
              return;
            r = current;
          }
          const sessionId = r.decision_session_id!;
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
              reason: receipt.error ?? "Nodex rejected this assessment",
            });
            return;
          }
          const current = (yield* settings.snapshot()).inbox;
          const modelSelection = yield* resolveInboxModel(
            runtime,
            current.suggestionAgent,
            "suggestion",
          );
          if (yield* spaceHeld(core)) return;
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
