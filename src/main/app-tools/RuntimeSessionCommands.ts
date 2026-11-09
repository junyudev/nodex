import { readModelPolicyFailure } from "../../shared/model-policy";
import { RUNTIME_MODE_RANK } from "@nodex/agent-runtime/contracts";
import { sessionQuestionSchema } from "../../shared/nodex-app-tools/session-question-schema";
import type { SessionQuestionIntake } from "./SessionQuestionIntake";
import { SessionQuestionError } from "./SessionQuestions";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  AgentRuntimeApplication,
  AgentRuntimeApplicationError,
} from "../agent-runtime/AgentRuntimeApplication";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CoreModules } from "../core-runtime/CoreModules";
import { readCodexLinkedRootSession } from "../codex-application/CodexLinkedRootSession";
import { make as makeAppToolOperation } from "./AppToolOperation";
import { toCoreAgentTurnProvenance } from "../core-client/core-agent-execution-authorization";
import { createSessionSchema } from "../../shared/nodex-app-tools/session-launch-schema";
import { sessionForkSchema } from "../../shared/nodex-app-tools/session-fork-schema";
import { sessionMergeSchema } from "../../shared/nodex-app-tools/session-merge-schema";
import { sessionMessageSchema } from "../../shared/nodex-app-tools/session-message-schema";
import { readHostedAppToolSessionContext, type AppToolAuthorityCapture } from "./AppToolCaller";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { deriveSessionDispatchIdentity } from "./session-dispatch-identity";
import type { SessionMessageIntake } from "./SessionMessageIntake";
import { parseAppToolArguments, toolFailure, toolSuccess } from "./app-tool-result";

/** Product Session commands use the canonical execution writer and stable command identities. */
export const makeWithCapture = (
  capture: AppToolAuthorityCapture,
  intake: SessionMessageIntake,
  questions: SessionQuestionIntake,
) =>
  Effect.gen(function* () {
    const admitOperation = yield* makeAppToolOperation;
    const application = yield* AgentRuntimeApplication;
    const core = yield* CoreAuthority;
    const modules = yield* CoreModules;
    return Effect.fn("RuntimeSessionCommands.execute")(function* (input: AppToolInvocation) {
      if (!input.caller.isActive()) return toolFailure("call_withdrawn");
      const authority = yield* capture(input.caller);
      if (!authority || !input.caller.isActive()) return toolFailure("authority_unavailable");
      const hosted = readHostedAppToolSessionContext(input.caller);
      const native = hosted
        ? null
        : yield* readCodexLinkedRootSession(modules, {
            hostId: input.caller.hostId,
            threadId: input.caller.threadId,
          }).pipe(Effect.catch(() => Effect.succeed(null)));
      if (!hosted && (!native || native.archived)) return toolFailure("session_unavailable");
      if (!input.caller.isActive()) return toolFailure("call_withdrawn");
      const sessionId = hosted?.sessionId ?? native?.id;
      if (!sessionId) return toolFailure("session_unavailable");
      const callerTarget = {
        sessionId,
        ...(hosted ? { execution: { threadId: hosted.threadId } } : {}),
      };

      const provenance = toCoreAgentTurnProvenance(core.identity.profileId, authority);
      const execute = Effect.gen(function* () {
        if (input.name === "session_question") {
          const parsed = parseAppToolArguments(sessionQuestionSchema, input.arguments);
          if (!parsed.success) return parsed.result;
          const request = parsed.data;
          const backend = yield* questions(callerTarget, request);
          if (!input.caller.isActive()) return toolFailure("call_withdrawn");
          if (request.action === "list") return toolSuccess(yield* backend.list(request));
          if (!request.requestId) return toolFailure("invalid_arguments");
          if (request.action === "read")
            return toolSuccess(yield* backend.read(request, request.requestId));
          if (request.answers === undefined) return toolFailure("invalid_arguments");
          const operation = yield* admitOperation(
            input,
            authority,
            core.identity.profileId,
            request,
          );
          if (!operation.success) return operation.result;
          const { operationId } = operation;
          const result = yield* backend.respond(
            request,
            request.requestId,
            request.answers,
            {
              kind: "agent",
              senderThreadId: hosted?.threadId ?? input.caller.threadId,
              senderSessionId: sessionId,
              senderRunId: hosted?.runId ?? input.caller.turnId,
            },
            operationId,
          );
          return toolSuccess({ ...result, operationId });
        }
        if (input.name === "send_message_to_session") {
          const parsed = parseAppToolArguments(sessionMessageSchema, input.arguments);
          if (!parsed.success) return parsed.result;
          const request = parsed.data;
          const operation = yield* admitOperation(
            input,
            authority,
            core.identity.profileId,
            request,
          );
          if (!operation.success) return operation.result;
          const { operationId, acceptedAtMs } = operation;
          const outcome = yield* intake.send({
            request,
            acceptedAtMs,
            expiresAtMs: operation.expiresAtMs,
            caller: callerTarget,
            operationId,
            sourceThreadId: hosted?.threadId ?? input.caller.threadId,
            sourceRunId: hosted?.runId ?? input.caller.turnId,
          });
          if (!input.caller.isActive()) return toolFailure("call_withdrawn");
          return toolSuccess({
            ...outcome,
            operationId,
            resolvedRunId: outcome.runId,
            deliveryState: outcome.delivery,
          });
        }
        if (input.name === "fork_session") {
          const parsed = parseAppToolArguments(sessionForkSchema, input.arguments);
          if (!parsed.success) return parsed.result;
          const request = parsed.data;
          const operation = yield* admitOperation(
            input,
            authority,
            core.identity.profileId,
            request,
          );
          if (!operation.success) return operation.result;
          const { operationId, acceptedAtMs } = operation;
          const sourceSessionId = request.sessionId ?? sessionId;
          const callerFacts = yield* intake.inspect(callerTarget);
          const result = yield* application.fork({
            modeLimit: {
              runtimeMode: callerFacts.runtimeMode,
              interactionMode: callerFacts.interactionMode,
            },
            source: {
              sessionId: sourceSessionId,
              ...(hosted && sourceSessionId === sessionId ? { threadId: hosted.threadId } : {}),
            },
            sessionId: deriveSessionDispatchIdentity(operationId, "session", acceptedAtMs),
            requestId: operationId,
            acceptedAt: acceptedAtMs,
            environment: request.environment.type,
          });
          return toolSuccess({ ...result, operationId, forkState: "attached" });
        }
        if (input.name === "merge_session_back") {
          const parsed = parseAppToolArguments(sessionMergeSchema, input.arguments);
          if (!parsed.success) return parsed.result;
          const request = parsed.data;
          // A fork's own running reply cannot be merged; its finished work is merged from elsewhere.
          if (request.sessionId === sessionId) return toolFailure("cannot_merge_calling_session");
          const operation = yield* admitOperation(
            input,
            authority,
            core.identity.profileId,
            request,
          );
          if (!operation.success) return operation.result;
          const { operationId } = operation;
          const merged = yield* application.mergeBack({
            sessionId: request.sessionId,
            requestId: operationId,
          });
          return toolSuccess({ ...merged, operationId, mergeState: "pending_next_message" });
        }
        if (input.name !== "create_session") return toolFailure("unknown_tool");
        const parsed = parseAppToolArguments(createSessionSchema, input.arguments);
        if (!parsed.success) return parsed.result;
        const request = parsed.data;
        const projectId = request.target.type === "project" ? request.target.projectId : null;
        const callerFacts = yield* intake.inspect(callerTarget);
        if (
          request.runtimeMode &&
          RUNTIME_MODE_RANK[request.runtimeMode] > RUNTIME_MODE_RANK[callerFacts.runtimeMode]
        )
          return toolFailure("runtime_mode_escalation_denied");
        const selection = callerFacts.modelSelection;
        const operation = yield* admitOperation(input, authority, core.identity.profileId, request);
        if (!operation.success) return operation.result;
        const { operationId, acceptedAtMs } = operation;
        const environment = request.target.type === "project" ? request.target.environment : null;
        const result = yield* application.launch({
          launchId: operationId,
          acceptedAt: acceptedAtMs,
          sessionId: deriveSessionDispatchIdentity(operationId, "session", acceptedAtMs),
          projectId,
          title: request.title ?? "New chat",
          sender: {
            threadId: hosted?.threadId ?? input.caller.threadId,
            runId: null,
          },
          modelSelection: {
            ...selection,
            ...(request.model ? { model: request.model } : {}),
            ...(request.reasoningEffort
              ? {
                  options: [
                    ...(selection.options ?? []).filter(
                      (option) => option.id !== "reasoningEffort",
                    ),
                    { id: "reasoningEffort", value: request.reasoningEffort },
                  ],
                }
              : {}),
          },
          runtimeMode: request.runtimeMode ?? callerFacts.runtimeMode,
          interactionMode: callerFacts.interactionMode,
          modeLimit: {
            runtimeMode: callerFacts.runtimeMode,
            interactionMode: callerFacts.interactionMode,
          },
          runInTarget: environment?.type === "worktree" ? "newWorktree" : "localProject",
          ...(environment?.type === "worktree" && environment.startingState
            ? { worktreeStartingState: environment.startingState }
            : {}),
          message: {
            messageId: deriveSessionDispatchIdentity(operationId, "message", acceptedAtMs),
            text: request.prompt,
          },
        });
        const messageId = deriveSessionDispatchIdentity(operationId, "message", acceptedAtMs);
        const outcome = yield* application.execution({ sessionId: result.sessionId, messageId });
        return toolSuccess({
          ...result,
          operationId,
          messageId,
          runId: outcome.selectedRunId,
          launchState: "attached",
        });
      });
      return yield* execute.pipe(
        Effect.provideService(CoreApplicationAgent, provenance),
        Effect.catch((error) => {
          const policy = readModelPolicyFailure(error);
          if (policy) return Effect.succeed(toolFailure(policy.code, policy.message));
          return Effect.succeed(
            toolFailure(
              Schema.is(SessionQuestionError)(error)
                ? error.code
                : Schema.is(AgentRuntimeApplicationError)(error) && error.adoptionReason
                  ? error.adoptionReason
                  : error instanceof Error &&
                      (error.message === "runtime_mode_escalation_denied" ||
                        error.message === "interaction_mode_escalation_denied")
                    ? error.message
                    : "session_command_failed",
              error instanceof Error ? error.message : "Session command is unavailable",
            ),
          );
        }),
      );
    });
  });
