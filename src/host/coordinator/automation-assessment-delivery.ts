import { createHash } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { components } from "@nodex/core-protocol";

type Request = components["schemas"]["AutomationAssessmentRequest"];
type Read = components["schemas"]["AutomationAssessmentRead"];
type Command = components["schemas"]["AutomationAssessmentCommand"];
export const assessmentIdentity = (
  request: Pick<Request, "request_id" | "generation">,
  followup = false,
) => {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        "automation-assessment-v1",
        request.request_id,
        request.generation,
        followup,
      ]),
    )
    .digest("hex");
  return { messageId: `automation-assessment:${fingerprint}`, fingerprint };
};
export const renderAssessmentRequest = (request: Request, followup = false) =>
  [
    followup
      ? "Automation assessment follow-up: your turn ended without a submission. Submit this request now."
      : "Automation assessment request. Assess evidence only; do not execute work or send messages.",
    JSON.stringify({
      request_id: request.request_id,
      generation: request.generation,
      policy_hash: request.policy_hash,
      thread_id: request.thread_id,
    }),
    "Use automation_assessment_read for triggers, thread, automations, pages, follows, and decisions. Follow returned cursors for all automations. Submit exactly one factual judgement per applicable automation, including negative judgements, with automation_assessment_submit. Use the exact Project and execution_target returned by automations. Core supplies authority and mode.",
  ].join("\n\n");

/** Routing and tools observe the same carrying Run; queue time never consumes judgement time. */
export const makeAssessmentDelivery = Effect.gen(function* () {
  const core = yield* CoreModules;
  const runtime = yield* AgentRuntimeApplication;
  const read = (read: Read) =>
    core.workspace.read({ kind: "automation_assessments", read }, undefined, null).pipe(
      Effect.map((s) => {
        if (s.value.kind !== "automation_assessments") throw new Error("Invalid assessment read");
        return s.value.value;
      }),
    );
  const apply = (command: Command) =>
    core.workspace.apply(
      {
        operationId: createOperationId("automation.assessment"),
        intent: { kind: "automation_assessment", command },
      },
      undefined,
      null,
    );
  const request = (request_id: string) =>
    read({ kind: "request", request_id }).pipe(
      Effect.map((v) => (v.kind === "request" ? v.request : null)),
    );
  const status = Effect.fn("AutomationAssessmentDelivery.status")(function* (r: Request) {
    const sessionId = r.coordinator_session_id;
    if (!sessionId) return { deadline: Infinity, followup: false, failure: null as string | null };
    const run = yield* runtime.runOutcome({
      sessionId,
      messageId: assessmentIdentity(r).messageId,
      carryingRun: true,
    });
    let started = r.run_started_at_ms;
    if (started == null && run?.startedAt) {
      const at = Date.parse(run.startedAt);
      if (Number.isFinite(at)) {
        yield* apply({
          kind: "start_run",
          request_id: r.request_id,
          generation: r.generation,
          coordinator_session_id: sessionId,
          started_at_ms: at,
        });
        started = (yield* request(r.request_id))?.run_started_at_ms ?? at;
      }
    }
    const deadline = started == null ? Infinity : started + 120_000;
    if ((yield* Clock.currentTimeMillis) >= deadline)
      return { deadline, followup: false, failure: "The automation assessment timed out" };
    if (run?.status === "failed" || run?.status === "cancelled")
      return {
        deadline,
        followup: false,
        failure: run.failureMessage ?? "Nodex stopped before assessing this request",
      };
    if (run?.status !== "completed") return { deadline, followup: false, failure: null };
    const next = yield* runtime.runOutcome({
      sessionId,
      messageId: assessmentIdentity(r, true).messageId,
      carryingRun: true,
    });
    if (next && ["completed", "failed", "cancelled"].includes(next.status))
      return {
        deadline,
        followup: false,
        failure: "Nodex ended its follow-up without submitting this automation assessment",
      };
    return { deadline, followup: true, failure: null };
  });
  return { read, apply, request, status };
});
