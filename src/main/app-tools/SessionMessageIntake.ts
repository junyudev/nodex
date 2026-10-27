import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { createHash } from "node:crypto";
import { stableStringifyBlockPropertyJson } from "../../shared/block-property-mutations";
import { SessionMessageIntakeError } from "./SessionMessageIntakeError";
import type { z } from "zod";
import { sessionMessageSchema } from "../../shared/nodex-app-tools/session-message-schema";
import type { SessionExecutionTarget } from "../../shared/nodex-app-tools/session-execution-target";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import {
  AgentRuntimeApplication,
  AgentRuntimeApplicationError,
} from "../agent-runtime/AgentRuntimeApplication";
import { make as makeRuntime } from "./RuntimeSessionMessageIntake";
import { make as makeNative } from "./NativeSessionMessageIntake";
import { make as makeAttachmentResolver } from "./SessionMessageAttachments";
import { sessionMessageCeilingError, type SessionMessageFacts } from "./session-message-policy";
import { deriveSessionDispatchIdentity } from "./session-dispatch-identity";

export interface SessionMessageIntakeInput {
  readonly request: z.infer<typeof sessionMessageSchema>;
  readonly caller: SessionExecutionTarget;
  readonly operationId: string;
  readonly sourceThreadId: string;
  readonly sourceRunId?: string | null;
}

/** One admission path resolves resource owners and compares concrete execution settings. */
export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const application = yield* AgentRuntimeApplication;
  const runtime = yield* makeRuntime;
  const native = yield* makeNative;
  const resolveAttachments = yield* makeAttachmentResolver;
  const authorize = Effect.fn("SessionMessageIntake.authorize")(function* (sessionId: string) {
    const provenance = yield* CoreApplicationAgent;
    if (!provenance)
      return yield* Effect.fail(
        new SessionMessageIntakeError({ message: "Message execution authority is unavailable" }),
      );
    const response = yield* core.workspace.read(
      { kind: "agent_session", session_id: sessionId, provenance },
      { deadlineMs: 10_000 },
      provenance.authority.actor_project_id,
    );
    if (response.value.kind !== "agent_session" || response.value.session.archived)
      return yield* Effect.fail(
        new SessionMessageIntakeError({ message: "Message Session is unavailable" }),
      );
    return response.value;
  });
  type AuthorizedSession = Effect.Success<ReturnType<typeof authorize>>;
  type NativeAdmission = Effect.Success<ReturnType<typeof native.admit>>;
  const sendFresh = Effect.fn("SessionMessageIntake.sendFresh")(function* (
    input: SessionMessageIntakeInput,
    caller: AuthorizedSession,
    target: AuthorizedSession,
    messageId: string,
    fingerprint: string,
    admission: NativeAdmission | null,
  ) {
    const callerFacts = caller.session.execution_ref
      ? yield* runtime.inspect(input.caller)
      : yield* native.inspect(input.caller);
    if (target.session.execution_ref) {
      const resumed = yield* runtime.resume({
        target: input.request,
        operationId: input.operationId,
        messageId,
        fingerprint,
        modeLimit: {
          runtimeMode: callerFacts.runtimeMode,
          interactionMode: callerFacts.interactionMode,
        },
      });
      if (resumed) return resumed;
    }
    // The Native command owner, like Runtime execution, uses the Profile's fixed
    // full-access policy. Admission must precede even an owner resume.
    if (target.thread && !target.session.execution_ref && callerFacts.runtimeMode !== "full-access")
      return yield* new SessionMessageIntakeError({ message: "runtime_mode_escalation_denied" });
    if (target.thread?.execution_host_id === native.localHostId && !target.session.execution_ref) {
      if (target.thread.status.status_type === "active")
        return yield* new AgentRuntimeApplicationError({
          operation: "adopt-native",
          message: "Native source is still running; continue after it finishes",
          adoptionReason: "active_source_busy",
        });
      if (input.request.mode === "steer")
        return yield* new SessionMessageIntakeError({
          message: "This Session has no active Runtime Run to steer",
        });
    }
    const targetFacts: SessionMessageFacts = target.session.execution_ref
      ? yield* runtime.inspect(input.request)
      : target.thread
        ? yield* native.prepare(input.request)
        : {
            sessionId: target.session.id,
            threadId: null,
            runtimeMode: "full-access",
            interactionMode: callerFacts.interactionMode,
            modelSelection: callerFacts.modelSelection,
          };
    if (!target.thread && !target.session.execution_ref && input.request.execution)
      return yield* Effect.fail(
        new SessionMessageIntakeError({ message: "A draft has no descendant execution" }),
      );
    const denied = sessionMessageCeilingError(callerFacts, targetFacts);
    if (denied) return yield* Effect.fail(new SessionMessageIntakeError({ message: denied }));
    if (
      input.request.mode === "steer" &&
      ((!target.thread && !target.session.execution_ref) ||
        targetFacts.executionHostId === native.localHostId)
    )
      return yield* Effect.fail(
        new SessionMessageIntakeError({
          message: "This Session has no active Runtime Run to steer",
        }),
      );
    const attachments = yield* resolveAttachments(input.request.attachments);
    const after = yield* authorize(input.request.sessionId);
    if (
      JSON.stringify([after.session.execution_ref, after.thread?.thread_id]) !==
      JSON.stringify([target.session.execution_ref, target.thread?.thread_id])
    )
      return yield* Effect.fail(
        new SessionMessageIntakeError({
          message: "Message target binding changed during resource resolution",
        }),
      );
    const currentCallerFacts = caller.session.execution_ref
      ? yield* runtime.inspect(input.caller)
      : yield* native.inspect(input.caller);
    const currentTargetFacts = target.session.execution_ref
      ? yield* runtime.inspect(input.request)
      : target.thread
        ? yield* native.inspect(input.request)
        : targetFacts;
    const changed = sessionMessageCeilingError(currentCallerFacts, currentTargetFacts);
    if (changed) return yield* Effect.fail(new SessionMessageIntakeError({ message: changed }));
    let destination: SessionExecutionTarget = input.request;
    let destinationFacts = currentTargetFacts;
    let runtimeOwned =
      target.session.execution_ref !== null && target.session.execution_ref !== undefined;
    if (target.thread && currentTargetFacts.executionHostId === native.localHostId) {
      if (!currentTargetFacts.threadId)
        return yield* Effect.fail(
          new SessionMessageIntakeError({ message: "Native execution identity is unavailable" }),
        );
      // Local execution has one writer. Validate the actual Runtime ceiling before
      // importing history or changing the product Session's canonical binding.
      const predicted: SessionMessageFacts = {
        sessionId: target.session.id,
        threadId: null,
        runtimeMode: "full-access",
        interactionMode: currentTargetFacts.interactionMode,
        modelSelection: currentTargetFacts.modelSelection,
      };
      const migrationDenied = sessionMessageCeilingError(currentCallerFacts, predicted);
      if (migrationDenied)
        return yield* Effect.fail(new SessionMessageIntakeError({ message: migrationDenied }));
      const adopted = yield* application.adoptNativeSession({
        sessionId: target.session.id,
        requestId: input.operationId,
        acceptedAt: Number(input.operationId.split(":")[2]),
        expectedNativeThreadId: currentTargetFacts.threadId,
        expectedNativeHostId: native.localHostId,
        interactionMode: currentTargetFacts.interactionMode,
        model: currentTargetFacts.modelSelection.model,
      });
      const committed = yield* authorize(target.session.id);
      if (committed.session.execution_ref?.thread_id !== adopted.threadId)
        return yield* Effect.fail(
          new SessionMessageIntakeError({ message: "Message adoption binding is unavailable" }),
        );
      destination = { sessionId: adopted.sessionId, execution: { threadId: adopted.threadId } };
      destinationFacts = yield* runtime.inspect(destination);
      const actualDenied = sessionMessageCeilingError(currentCallerFacts, destinationFacts);
      if (actualDenied)
        return yield* Effect.fail(new SessionMessageIntakeError({ message: actualDenied }));
      runtimeOwned = true;
    }
    const current = destinationFacts.modelSelection;
    const modelSelection =
      input.request.model === undefined
        ? undefined
        : input.request.providerInstanceId &&
            input.request.providerInstanceId !== current.instanceId
          ? { instanceId: input.request.providerInstanceId, model: input.request.model }
          : { ...current, model: input.request.model };
    const command = {
      target: destination,
      messageId,
      fingerprint,
      prompt: input.request.prompt,
      mode: input.request.mode,
      attachments,
      ...(modelSelection ? { modelSelection } : {}),
      senderThreadId: input.sourceThreadId,
      ...(currentCallerFacts.interactionMode === "plan"
        ? { interactionModeCeiling: "plan" as const }
        : {}),
      ...(input.sourceRunId === undefined ? {} : { senderRunId: input.sourceRunId }),
    };
    if (runtimeOwned) return yield* runtime.send(command);
    if (target.thread) {
      if (!admission)
        return yield* new SessionMessageIntakeError({ message: "Native admission is unavailable" });
      return yield* native.send({
        ...command,
        expectedFacts: currentTargetFacts,
        admission,
      });
    }
    const launched = yield* application.launch({
      launchId: input.operationId,
      acceptedAt: Number(input.operationId.split(":")[2]),
      sessionId: target.session.id,
      projectId: target.session.project_id ?? null,
      title: target.session.display_title,
      modelSelection: modelSelection ?? targetFacts.modelSelection,
      interactionMode: targetFacts.interactionMode,
      ...(currentCallerFacts.interactionMode === "plan"
        ? { interactionModeCeiling: "plan" as const }
        : {}),
      resources: attachments,
      messageFingerprint: fingerprint,
      message: { messageId, text: input.request.prompt, attachments: [] },
    });
    const outcome = yield* application.execution({ sessionId: target.session.id, messageId });
    return {
      ...launched,
      messageId,
      runId: outcome.runId,
      status: outcome.status,
      delivery: "started",
    };
  });
  return {
    inspect: Effect.fn("SessionMessageIntake.inspect")(function* (target: SessionExecutionTarget) {
      const session = yield* authorize(target.sessionId);
      return session.session.execution_ref
        ? yield* runtime.inspect(target)
        : yield* native.inspect(target);
    }),
    send: Effect.fn("SessionMessageIntake.send")(function* (input: SessionMessageIntakeInput) {
      const caller = yield* authorize(input.caller.sessionId);
      const target = yield* authorize(input.request.sessionId);
      const messageId = deriveSessionDispatchIdentity(input.operationId, "message");
      const commandIdentity = {
        request: {
          sessionId: input.request.sessionId,
          execution: input.request.execution ?? null,
          prompt: input.request.prompt,
          mode: input.request.mode,
          attachments: input.request.attachments,
          model: input.request.model ?? null,
          providerInstanceId: input.request.providerInstanceId ?? null,
        },
        sourceThreadId: input.sourceThreadId,
      };
      const fingerprint = createHash("sha256")
        .update(stableStringifyBlockPropertyJson(commandIdentity))
        .digest("hex");
      // Accepted commands replay before mutable preparation; Core authority and binding still apply.
      const acceptedNative = yield* native.lookup({
        target: input.request,
        operationId: input.operationId,
        messageId,
        commandIdentity,
      });
      if (acceptedNative) return yield* native.replay(acceptedNative);
      if (target.session.execution_ref) {
        const replay = yield* runtime.replay({ target: input.request, messageId, fingerprint });
        if (replay) return replay;
      }
      const admission =
        target.thread &&
        !target.session.execution_ref &&
        target.thread.execution_host_id !== native.localHostId
          ? yield* native.admit({
              target: input.request,
              operationId: input.operationId,
              messageId,
              commandIdentity,
            })
          : null;
      if (admission && !admission.admitted) return yield* native.replay(admission);
      return yield* sendFresh(input, caller, target, messageId, fingerprint, admission).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) && admission ? native.reject(admission) : Effect.void,
        ),
      );
    }),
  };
});
