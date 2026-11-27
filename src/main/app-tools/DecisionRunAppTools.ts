import { makeAssessmentDelivery } from "../../host/nodex-decisions/automation-assessment-delivery";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { countWords } from "../../shared/word-count";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import {
  automationAssessmentReadSchema,
  automationAssessmentSubmitSchema,
  InboxSuggestionOutput,
  answerInboxQuestionSchema,
} from "../../shared/nodex-app-tools/decision-run-schemas";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { toCoreAgentTurnProvenance } from "../core-client/core-agent-execution-authorization";
import { CoreModuleResponseError } from "../core-client/core-client";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { readDecisionRun } from "../../host/nodex-decisions/decision-run-role";
import { InboxApplication } from "../../host/inbox-application/InboxApplication";
import {
  make as makeRoutingContext,
  makeOriginChats,
} from "../../host/inbox-application/InboxRoutingContext";
import { validateInboxSuggestions } from "../../host/inbox-application/inbox-suggestions";
import { inboxDispatchActionToCore } from "../core-client/inbox-adapter";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { make as makeAppToolOperation } from "./AppToolOperation";
import { captureAppToolAuthority, type AppToolCaller } from "./AppToolCaller";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { parseAppToolArguments, toolFailure, toolSuccess } from "./app-tool-result";
import { deriveSessionDispatchIdentity } from "./session-dispatch-identity";

const failureMessage = (cause: { readonly message?: string; readonly cause?: unknown }) =>
  cause.cause instanceof CoreModuleResponseError
    ? cause.cause.coreError.message
    : (cause.message ?? "The decision run operation could not be completed");
const suggestionIdentity = InboxSuggestionOutput.pick({
  request_id: true,
  generation: true,
}).strip();
const noLongerPending = () =>
  toolSuccess({
    recorded: false,
    message: "This request is no longer pending; nothing was recorded.",
  });

/** Caller identity comes from captured execution authority, never from tool arguments. */
export const makeWithCapture = (
  capture: (caller: AppToolCaller) => Effect.Effect<NodexAgentTurnContext | null>,
) =>
  Effect.gen(function* () {
    const inbox = yield* InboxApplication;
    const settings = yield* ApplicationSettings;
    const core = yield* CoreModules;
    const identity = yield* CoreAuthority;
    const prepare = yield* makeRoutingContext;
    const originChats = yield* makeOriginChats;
    const admit = yield* makeAppToolOperation;
    const assessment = yield* makeAssessmentDelivery;
    const rememberArgumentRefusal = Effect.fn("DecisionRunAppTools.rememberArgumentRefusal")(
      function* (sessionId: string, args: unknown, reason: string) {
        const identity = suggestionIdentity.safeParse(args);
        if (!identity.success) return;
        const pending = yield* inbox.suggestionRequest(identity.data.request_id);
        if (
          !pending ||
          pending.generation !== identity.data.generation ||
          pending.delivery?.decision_session_id !== sessionId
        )
          return;
        yield* inbox.recordRoutingRefusal(pending, reason);
      },
    );
    return Effect.fn("DecisionRunAppTools.execute")(
      function* (input: AppToolInvocation) {
        if (!input.caller.isActive()) return toolFailure("call_withdrawn");
        const authority = yield* capture(input.caller);
        if (!input.caller.isActive()) return toolFailure("call_withdrawn");
        if (!authority || authority.threadId !== authority.rootThreadId)
          return toolFailure("authority_unavailable");
        const sessionId = authority.runtime?.sessionId;
        const decision = sessionId ? yield* readDecisionRun(core, sessionId) : null;
        const assessmentTool =
          input.name === "automation_assessment_read" ||
          input.name === "automation_assessment_submit";
        if (!sessionId || decision?.kind !== (assessmentTool ? "assessment" : "routing"))
          return toolFailure(
            "decision_run_required",
            "Use this tool from its matching decision run.",
          );
        if (input.name === "automation_assessment_read") {
          const parsed = parseAppToolArguments(automationAssessmentReadSchema, input.arguments);
          if (!parsed.success) return parsed.result;
          const result = yield* assessment
            .read({
              kind: "resource",
              ...parsed.data,
              cursor: parsed.data.cursor ?? null,
              provenance: toCoreAgentTurnProvenance(identity.identity.profileId, authority),
            })
            .pipe(Effect.result);
          return result._tag === "Failure"
            ? toolFailure("assessment_unavailable", failureMessage(result.failure))
            : toolSuccess(result.success);
        }
        if (input.name === "automation_assessment_submit") {
          const parsed = parseAppToolArguments(automationAssessmentSubmitSchema, input.arguments);
          if (!parsed.success) return parsed.result;
          const r = yield* assessment.request(parsed.data.request_id);
          if (!r || r.generation !== parsed.data.generation) return noLongerPending();
          if (r.decision_session_id !== sessionId)
            return toolFailure("assessment_recipient_changed");
          const status = yield* assessment.status(r);
          if (status.failure) return toolFailure("assessment_unavailable", status.failure);
          const operation = yield* admit(
            input,
            authority,
            identity.identity.profileId,
            parsed.data,
          );
          if (!operation.success) return operation.result;
          const result = yield* core.workspace
            .apply(
              {
                operationId: operation.operationId,
                intent: {
                  kind: "agent_command",
                  provenance: toCoreAgentTurnProvenance(identity.identity.profileId, authority),
                  intent: {
                    kind: "automation_assessment",
                    command: { kind: "submit", ...parsed.data },
                  },
                },
              },
              undefined,
              null,
            )
            .pipe(Effect.result);
          if (result._tag === "Failure")
            return toolFailure("assessment_refused", failureMessage(result.failure));
          const current = yield* assessment.request(r.request_id);
          return toolSuccess({
            recorded: !current,
            requeued: current !== null,
            generation: current?.generation ?? r.generation,
          });
        }
        if (input.name === "answer_inbox_question") {
          const parsed = parseAppToolArguments(answerInboxQuestionSchema, input.arguments);
          if (!parsed.success) return parsed.result;
          const args = parsed.data;
          const request = yield* inbox.suggestionRequest(decision.request_id);
          if (request) {
            if (
              request.generation !== decision.generation ||
              request.delivery?.decision_session_id !== sessionId
            )
              return toolFailure("request_unavailable");
            const status = yield* inbox.routingStatus(request);
            if (status.failureMessage || (yield* Clock.currentTimeMillis) >= status.deadline)
              return noLongerPending();
          }
          const words = countWords(args.body);
          if (words > 100)
            return toolFailure(
              "body_too_long",
              `Body has ${words} words; shorten it to at most 100.`,
            );
          const operation = yield* admit(input, authority, identity.identity.profileId, args);
          if (!operation.success) return operation.result;
          const provenance = toCoreAgentTurnProvenance(identity.identity.profileId, authority);
          const sent = yield* core.workspace
            .apply(
              {
                operationId: operation.operationId,
                intent: {
                  kind: "agent_command",
                  provenance,
                  intent: {
                    kind: "answer_inbox_question",
                    request_id: decision.request_id,
                    generation: decision.generation,
                    question_page_id: args.questionPageId,
                    page_id: deriveSessionDispatchIdentity(
                      operation.operationId,
                      "inbox-answer",
                      operation.acceptedAtMs,
                    ),
                    document_id: deriveSessionDispatchIdentity(
                      operation.operationId,
                      "inbox-answer-document",
                      operation.acceptedAtMs,
                    ),
                    body: args.body,
                  },
                },
              },
              undefined,
              provenance.authority.actor_project_id,
            )
            .pipe(Effect.result);
          if (sent._tag === "Failure")
            return toolFailure("inbox_write_unavailable", failureMessage(sent.failure));
          const written = sent.success.outcome.inbox_write;
          if (!written)
            return toolFailure(
              "inbox_write_unavailable",
              "The result is missing; retry this call.",
            );
          return toolSuccess({
            pageId: written.page_id,
            recorded: true,
            ...(written.replay || sent.success.receipt.duplicate ? { replay: true } : {}),
          });
        }
        const parsed = parseAppToolArguments(InboxSuggestionOutput, input.arguments);
        if (!parsed.success) {
          const reason = parsed.result.content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n");
          yield* rememberArgumentRefusal(sessionId, input.arguments, reason);
          return parsed.result;
        }
        const args = parsed.data;
        if (args.request_id !== decision.request_id || args.generation !== decision.generation)
          return toolFailure("request_unavailable");
        const request = yield* inbox.suggestionRequest(args.request_id);
        if (!request || request.generation !== args.generation) return noLongerPending();
        if (!request.delivery || request.delivery.decision_session_id !== sessionId)
          return toolFailure(
            "request_unavailable",
            "This routing request belongs to a different decision run.",
          );
        const routing = yield* inbox.routingStatus(request);
        if (routing.failureMessage || (yield* Clock.currentTimeMillis) >= routing.deadline) {
          yield* inbox.settleSuggestion({
            request_id: request.request_id,
            generation: request.generation,
            titles: [],
            suggestions: [],
            produced_by: null,
            error: routing.failureMessage ?? "The suggestion agent timed out",
            automatic_dispatch: false,
          });
          return noLongerPending();
        }
        const current = (yield* settings.snapshot()).inbox;
        const context = yield* prepare(current);
        const origins = yield* originChats(request.context);
        const validated = yield* Effect.try({
          try: () =>
            validateInboxSuggestions(
              args,
              request.context,
              request.context.entries,
              {
                requestId: request.request_id,
                generation: request.generation,
                mode: request.mode,
                correction: request.correction,
              },
              context.agents?.candidates ?? [],
              request.delivery?.skill_offers ?? [],
              origins,
            ),
          catch: (cause) =>
            cause instanceof Error ? cause : new Error("Invalid Inbox suggestion"),
        }).pipe(Effect.result);
        if (validated._tag === "Failure") {
          yield* inbox.recordRoutingRefusal(request, validated.failure.message);
          return toolFailure("invalid_suggestion", validated.failure.message);
        }
        if (!input.caller.isActive()) return toolFailure("call_withdrawn");
        const operation = yield* admit(input, authority, identity.identity.profileId, args);
        if (!operation.success) return operation.result;
        const settlement = yield* inbox
          .settleSuggestion(
            {
              request_id: request.request_id,
              generation: request.generation,
              decision_session_id: sessionId,
              titles: [...validated.success.titles].map(([page_id, title]) => ({ page_id, title })),
              suggestions: validated.success.suggestions.map((suggestion, index) => ({
                proposal_id: deriveSessionDispatchIdentity(
                  operation.operationId,
                  `inbox-suggestion-${index}`,
                  operation.acceptedAtMs,
                ),
                page_ids: [...suggestion.pageIds],
                action: inboxDispatchActionToCore(suggestion.action),
                entry_kind: suggestion.kind,
                summary: suggestion.summary,
                rationale: suggestion.rationale,
                explicit_request: suggestion.explicitRequest,
              })),
              produced_by: context.producedBy,
              error: null,
              automatic_dispatch: true,
            },
            operation.operationId,
          )
          .pipe(Effect.result);
        if (settlement._tag === "Failure") {
          const pending = yield* inbox.suggestionRequest(args.request_id);
          if (!pending || pending.generation !== args.generation) return noLongerPending();
          yield* inbox.recordRoutingRefusal(pending, failureMessage(settlement.failure));
          return toolFailure("suggestion_not_recorded", settlement.failure.message);
        }
        yield* inbox.autoConfirm;
        return toolSuccess({ recorded: true });
      },
      Effect.catch((cause) =>
        Effect.succeed(toolFailure("decision_run_unavailable", failureMessage(cause))),
      ),
    );
  });
export const make = Effect.gen(function* () {
  const turns = yield* CodexTurnAuthority;
  return yield* makeWithCapture((caller) => captureAppToolAuthority(caller, turns));
});
