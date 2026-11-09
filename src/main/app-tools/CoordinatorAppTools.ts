import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { countWords } from "../../shared/word-count";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import {
  InboxSuggestionOutput,
  replyToOriginSchema,
  writeTurnNoteSchema,
  answerInboxQuestionSchema,
} from "../../shared/nodex-app-tools/coordinator-schema";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { toCoreAgentTurnProvenance } from "../core-client/core-agent-execution-authorization";
import { CoreModuleResponseError } from "../core-client/core-client";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
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
    : (cause.message ?? "The Coordinator operation could not be completed");
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
    const coordinator = yield* CoordinatorSession;
    const inbox = yield* InboxApplication;
    const settings = yield* ApplicationSettings;
    const core = yield* CoreModules;
    const identity = yield* CoreAuthority;
    const prepare = yield* makeRoutingContext;
    const admit = yield* makeAppToolOperation;
    const rememberArgumentRefusal = Effect.fn("CoordinatorAppTools.rememberArgumentRefusal")(
      function* (sessionId: string, args: unknown, reason: string) {
        const identity = suggestionIdentity.safeParse(args);
        if (!identity.success) return;
        const pending = yield* inbox.suggestionRequest(identity.data.request_id);
        if (
          !pending ||
          pending.generation !== identity.data.generation ||
          pending.delivery?.coordinator_session_id !== sessionId
        )
          return;
        yield* inbox.recordRoutingRefusal(pending, reason);
      },
    );
    return Effect.fn("CoordinatorAppTools.execute")(
      function* (input: AppToolInvocation) {
        if (!input.caller.isActive()) return toolFailure("call_withdrawn");
        const authority = yield* capture(input.caller);
        if (!input.caller.isActive()) return toolFailure("call_withdrawn");
        if (!authority) return toolFailure("authority_unavailable");
        const sessionId = authority.runtime?.sessionId;
        if (!sessionId || !(yield* coordinator.isCoordinator(sessionId)))
          return toolFailure(
            "coordinator_only",
            "Only Nodex's Coordinator Session can use this tool.",
          );
        if (input.name === "reply_to_origin") {
          const parsed = parseAppToolArguments(replyToOriginSchema, input.arguments);
          if (!parsed.success) return parsed.result;
          const words = countWords(parsed.data.body);
          if (words === 0 || words > 100)
            return toolFailure("body_too_long", `Reply has ${words} words; use 1 to 100.`);
          if (parsed.data.body.includes("<!-- nodex:")) return toolFailure("reserved_marker");
          const operation = yield* admit(
            input,
            authority,
            identity.identity.profileId,
            parsed.data,
          );
          if (!operation.success) return operation.result;
          const sent = yield* core.workspace
            .apply(
              {
                operationId: operation.operationId,
                intent: {
                  kind: "agent_command",
                  provenance: toCoreAgentTurnProvenance(identity.identity.profileId, authority),
                  intent: {
                    kind: "source",
                    command: {
                      kind: "reply_to_origin",
                      page_id: parsed.data.pageId,
                      body: parsed.data.body,
                    },
                  },
                },
              },
              undefined,
              null,
            )
            .pipe(Effect.result);
          if (sent._tag === "Failure")
            return toolFailure("origin_reply_unavailable", failureMessage(sent.failure));
          return toolSuccess({ pageId: parsed.data.pageId, queued: true });
        }
        if (input.name === "write_turn_note" || input.name === "answer_inbox_question") {
          const parsed =
            input.name === "write_turn_note"
              ? parseAppToolArguments(writeTurnNoteSchema, input.arguments)
              : parseAppToolArguments(answerInboxQuestionSchema, input.arguments);
          if (!parsed.success) return parsed.result;
          const args = parsed.data;
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
                  intent:
                    "pageId" in args
                      ? {
                          kind: "write_turn_note",
                          page_id: args.pageId,
                          note_id: deriveSessionDispatchIdentity(
                            operation.operationId,
                            "turn-note",
                            operation.acceptedAtMs,
                          ),
                          body: args.body,
                          event_ids: args.eventIds,
                          notify: args.notify,
                        }
                      : {
                          kind: "answer_inbox_question",
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
        const request = yield* inbox.suggestionRequest(args.request_id);
        if (!request || request.generation !== args.generation) return noLongerPending();
        if (!request.delivery || request.delivery.coordinator_session_id !== sessionId)
          return toolFailure(
            "request_unavailable",
            "This routing request was not delivered to this Coordinator.",
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
        Effect.succeed(toolFailure("coordinator_unavailable", failureMessage(cause))),
      ),
    );
  });
export const make = Effect.gen(function* () {
  const turns = yield* CodexTurnAuthority;
  return yield* makeWithCapture((caller) => captureAppToolAuthority(caller, turns));
});
