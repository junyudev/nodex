import { readModelPolicyFailure } from "../../shared/model-policy";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { sessionDispatchFingerprint } from "./session-dispatch-identity";
import { readUserQuestion } from "@nodex/agent-runtime/pending-user-questions";
import {
  agentRuntimeFailureReason,
  AgentRuntimeApplication,
  AgentRuntimeApplicationError,
} from "../agent-runtime/AgentRuntimeApplication";
import { runtimeSessionTarget } from "../../shared/nodex-app-tools/session-execution-target";
import {
  questionResponderIdentity,
  SessionQuestionError,
  type SessionQuestionBackend,
} from "./SessionQuestions";

const unavailable = (cause: unknown) =>
  new SessionQuestionError({
    code: "unavailable",
    message: cause instanceof Error ? cause.message : "Session questions are unavailable",
  });

export const make = Effect.gen(function* () {
  const application = yield* AgentRuntimeApplication;
  return (
    modeLimit: import("@nodex/agent-runtime/contracts").AgentDispatchModeLimit,
  ): SessionQuestionBackend => ({
    list: (target) =>
      application.listQuestionIds(runtimeSessionTarget(target)).pipe(Effect.mapError(unavailable)),
    read: Effect.fn("RuntimeSessionQuestions.read")(function* (target, requestId) {
      const { snapshot } = yield* application
        .control({ ...runtimeSessionTarget(target), requestId, requireActive: true })
        .pipe(Effect.mapError(unavailable));
      const selected = readUserQuestion(snapshot.projection, requestId);
      if ("error" in selected)
        return yield* new SessionQuestionError({ code: selected.error, message: selected.message });
      return { requestId, questions: selected.item.questions };
    }),
    respond: Effect.fn("RuntimeSessionQuestions.respond")(
      function* (target, requestId, answers, responder, operationId) {
        const source = runtimeSessionTarget(target);
        const { snapshot } = yield* application
          .control({ ...source, requestId, requireActive: true })
          .pipe(Effect.mapError(unavailable));
        // The canonical command checks pending state after replaying an exact accepted retry.
        const selected = readUserQuestion(snapshot.projection, requestId, false);
        if ("error" in selected)
          return yield* new SessionQuestionError({
            code: selected.error,
            message: selected.message,
          });
        const respondedBy = responder;
        const responseFingerprint = sessionDispatchFingerprint({
          target: source,
          requestId,
          answers,
          responder: questionResponderIdentity(responder),
        });
        const node = snapshot.projection.nodes.find((node) => node.id === selected.request.nodeId);
        if (!node)
          return yield* new SessionQuestionError({
            code: "unavailable",
            message: "The question execution source is unavailable",
          });
        yield* application
          .respond({
            ...source,
            requestId,
            runId: node.runId,
            answers,
            respondedBy,
            submissionId: operationId,
            requirePending: true,
            responseFingerprint,
            modeLimit,
          })
          .pipe(
            Effect.mapError((cause) => {
              const policy = readModelPolicyFailure(cause);
              if (policy) return new SessionQuestionError(policy);
              const message = agentRuntimeFailureReason(cause);
              if (Schema.is(AgentRuntimeApplicationError)(cause) && cause.questionReason)
                return new SessionQuestionError({
                  code:
                    cause.questionReason === "operation_conflict"
                      ? "unavailable"
                      : cause.questionReason,
                  message,
                });
              if (
                message === "runtime_mode_escalation_denied" ||
                message === "interaction_mode_escalation_denied"
              )
                return new SessionQuestionError({ code: "forbidden", message });
              if (selected.request.status !== "pending")
                return new SessionQuestionError({ code: "not_pending", message });
              if (selected.request.responseCapability.type === "not_resumable")
                return new SessionQuestionError({ code: "unsupported", message });
              return new SessionQuestionError({ code: "unavailable", message });
            }),
          );
        return { requestId, status: "answered" as const };
      },
    ),
  });
});
