import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  AgentRuntimeApplication,
  AgentRuntimeApplicationError,
} from "../agent-runtime/AgentRuntimeApplication";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CoreModules } from "../core-runtime/CoreModules";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { readCodexLinkedRootSession } from "../codex-application/CodexLinkedRootSession";
import { createStableOperationId } from "../core-runtime/operation-identity";
import { toCoreAgentTurnProvenance } from "../core-client/core-agent-execution-authorization";
import { createSessionSchema } from "../../shared/nodex-app-tools/session-launch-schema";
import { sessionForkSchema } from "../../shared/nodex-app-tools/session-fork-schema";
import { sessionMergeSchema } from "../../shared/nodex-app-tools/session-merge-schema";
import { sessionMessageSchema } from "../../shared/nodex-app-tools/session-message-schema";
import { captureAppToolAuthority, readHostedAppToolSessionContext } from "./AppToolCaller";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { deriveSessionDispatchIdentity } from "./session-dispatch-identity";
import { make as makeSessionMessageIntake } from "./SessionMessageIntake";
import { toolFailure, toolSuccess } from "./app-tool-result";

/** Product Session commands use the canonical execution writer and stable command identities. */
export const make = Effect.gen(function* () {
  const application = yield* AgentRuntimeApplication;
  const core = yield* CoreAuthority;
  const modules = yield* CoreModules;
  const turns = yield* CodexTurnAuthority;
  const intake = yield* makeSessionMessageIntake;
  return Effect.fn("RuntimeSessionCommands.execute")(function* (input: AppToolInvocation) {
    if (!input.caller.isActive()) return toolFailure("call_withdrawn");
    const authority = yield* captureAppToolAuthority(input.caller, turns);
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
    const stableOperation = (supplied: string | undefined) =>
      supplied ??
      createStableOperationId(`app.${input.name}`, authority.admittedAtMs, [
        core.identity.profileId,
        input.caller.threadId,
        input.caller.turnId,
        input.caller.callId,
      ]);
    const execute = Effect.gen(function* () {
      if (input.name === "send_message_to_session") {
        const parsed = sessionMessageSchema.safeParse(input.arguments);
        if (!parsed.success) return toolFailure("invalid_arguments");
        const request = parsed.data;
        const operationId = stableOperation(request.operationId);
        const outcome = yield* intake.send({
          request,
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
        const parsed = sessionForkSchema.safeParse(input.arguments);
        if (!parsed.success) return toolFailure("invalid_arguments");
        const request = parsed.data;
        const operationId = stableOperation(request.operationId);
        const sourceSessionId = request.sessionId ?? sessionId;
        const result = yield* application.fork({
          source: {
            sessionId: sourceSessionId,
            ...(hosted && sourceSessionId === sessionId ? { threadId: hosted.threadId } : {}),
          },
          sessionId: deriveSessionDispatchIdentity(operationId, "session"),
          requestId: operationId,
          acceptedAt: Number(operationId.split(":")[2]),
          environment: request.environment.type,
        });
        return toolSuccess({ ...result, operationId, forkState: "attached" });
      }
      if (input.name === "merge_session_back") {
        const parsed = sessionMergeSchema.safeParse(input.arguments);
        if (!parsed.success) return toolFailure("invalid_arguments");
        const request = parsed.data;
        // A fork's own running reply cannot be merged; its finished work is merged from elsewhere.
        if (request.sessionId === sessionId) return toolFailure("cannot_merge_calling_session");
        const operationId = stableOperation(request.operationId);
        const merged = yield* application.mergeBack({
          sessionId: request.sessionId,
          requestId: operationId,
        });
        return toolSuccess({ ...merged, operationId, mergeState: "pending_next_message" });
      }
      if (input.name !== "create_session") return toolFailure("unknown_tool");
      const parsed = createSessionSchema.safeParse(input.arguments);
      if (!parsed.success) return toolFailure("invalid_arguments");
      const request = parsed.data;
      const projectId = request.target.type === "project" ? request.target.projectId : null;
      const callerFacts = yield* intake.inspect(callerTarget);
      if (callerFacts.runtimeMode !== "full-access")
        return toolFailure("runtime_mode_escalation_denied");
      const selection = callerFacts.modelSelection;
      const operationId = stableOperation(request.operationId);
      const environment = request.target.type === "project" ? request.target.environment : null;
      const result = yield* application.launch({
        launchId: operationId,
        acceptedAt: Number(operationId.split(":")[2]),
        sessionId: deriveSessionDispatchIdentity(operationId, "session"),
        projectId,
        title: request.title ?? "New chat",
        modelSelection: {
          ...selection,
          ...(request.model ? { model: request.model } : {}),
          ...(request.reasoningEffort
            ? {
                options: [
                  ...(selection.options ?? []).filter((option) => option.id !== "reasoningEffort"),
                  { id: "reasoningEffort", value: request.reasoningEffort },
                ],
              }
            : {}),
        },
        interactionMode: callerFacts.interactionMode,
        ...(callerFacts.interactionMode === "plan" ? { interactionModeCeiling: "plan" } : {}),
        runInTarget: environment?.type === "worktree" ? "newWorktree" : "localProject",
        ...(environment?.type === "worktree" && environment.startingState
          ? { worktreeStartingState: environment.startingState }
          : {}),
        message: {
          messageId: deriveSessionDispatchIdentity(operationId, "message"),
          text: request.prompt,
        },
      });
      const messageId = deriveSessionDispatchIdentity(operationId, "message");
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
      Effect.catch((error) =>
        Effect.succeed(
          toolFailure(
            Schema.is(AgentRuntimeApplicationError)(error) && error.adoptionReason
              ? error.adoptionReason
              : error instanceof Error &&
                  (error.message === "runtime_mode_escalation_denied" ||
                    error.message === "interaction_mode_escalation_denied")
                ? error.message
                : "session_command_failed",
            error instanceof Error ? error.message : "Session command is unavailable",
          ),
        ),
      ),
    );
  });
});
