import * as Effect from "effect/Effect";
import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { stableStringifyBlockPropertyJson } from "../../shared/block-property-mutations";
import { SessionMessageIntakeError } from "./SessionMessageIntakeError";
import type { CodexCanonicalPermissionContext, CodexPromptInput } from "../../shared/types";
import type { SessionExecutionTarget } from "../../shared/nodex-app-tools/session-execution-target";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { CodexThreadDirectory } from "../codex-application/CodexThreadDirectory";
import { CodexMainConversationResume } from "../codex-application/CodexMainConversationResume";
import { CodexDelegatedMessages } from "../codex-application/CodexDelegatedMessages";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { CodexAttachments } from "../codex-application/CodexAttachments";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { RuntimeSessionMessageInput } from "./RuntimeSessionMessageIntake";
import type { SessionMessageFacts } from "./session-message-policy";

interface NativeFacts extends SessionMessageFacts {
  readonly threadId: string;
  readonly executionHostId: string;
  readonly permissions: CodexCanonicalPermissionContext;
}

type Receipt = AgentRuntimeOperations["native-message.reserve"]["output"];
export interface NativeMessageAdmission extends Receipt {
  readonly messageId: string;
  readonly fingerprint: string;
}
interface MessageIdentity {
  readonly target: SessionExecutionTarget;
  readonly operationId: string;
  readonly messageId: string;
  readonly commandIdentity: unknown;
}
const fingerprintOf = (identity: MessageIdentity) =>
  createHash("sha256")
    .update(stableStringifyBlockPropertyJson(JSON.parse(JSON.stringify(identity.commandIdentity))))
    .digest("hex");

/** Remote Native messages stay with their retained execution owner. */
export const make = Effect.gen(function* () {
  const gateway = yield* CodexGateway;
  const workspace = yield* ProjectWorkspace;
  const directory = yield* CodexThreadDirectory;
  const resume = yield* CodexMainConversationResume;
  const messages = yield* CodexDelegatedMessages;
  const application = yield* AgentRuntimeApplication;
  const attachments = yield* CodexAttachments;
  const resolve = Effect.fn("NativeSessionMessageIntake.resolve")(function* (
    target: SessionExecutionTarget,
  ) {
    const session = yield* workspace.getProjectSession(target.sessionId);
    if (
      !session ||
      session.archived ||
      session.executionRef ||
      session.thread?.backendBinding.kind !== "codex"
    )
      return yield* new SessionMessageIntakeError({ message: "Native Session is unavailable" });
    const threadId = session.thread.threadId;
    if (target.execution)
      return yield* new SessionMessageIntakeError({
        message: "Native execution is outside this Session",
      });
    return { session, thread: session.thread, threadId };
  });
  const inspect = Effect.fn("NativeSessionMessageIntake.inspect")(function* (
    target: SessionExecutionTarget,
  ): Effect.fn.Return<NativeFacts, unknown> {
    const { session, thread, threadId } = yield* resolve(target);
    const entry = yield* directory.resolve({
      threadId,
      fidelity: "durable",
      expectedHostId: thread.executionHostId,
    });
    const state = entry?.canonical;
    const permissions = state?.currentPermissions;
    const settings = state?.latestThreadSettings ?? state?.hydrationContext?.latestThreadSettings;
    if (
      !state ||
      state.hostId !== thread.executionHostId ||
      !permissions ||
      !settings?.model ||
      !settings.collaborationMode ||
      !settings.approvalPolicy ||
      !settings.sandboxPolicy
    )
      return yield* Effect.fail(
        new SessionMessageIntakeError({
          message: "Native execution permission facts are unavailable",
        }),
      );
    const runtimeMode =
      permissions.sandboxPolicy.type === "dangerFullAccess"
        ? ("full-access" as const)
        : permissions.sandboxPolicy.type === "workspaceWrite"
          ? permissions.approvalPolicy === "never"
            ? ("auto-accept-edits" as const)
            : ("approval-required" as const)
          : permissions.sandboxPolicy.type === "readOnly"
            ? ("approval-required" as const)
            : null;
    if (runtimeMode === null)
      return yield* Effect.fail(
        new SessionMessageIntakeError({
          message: "Native execution permissions cannot be compared",
        }),
      );
    return {
      sessionId: session.id,
      threadId,
      executionHostId: thread.executionHostId,
      permissions,
      runtimeMode,
      nativeSandbox: permissions.sandboxPolicy.type as
        | "readOnly"
        | "workspaceWrite"
        | "dangerFullAccess",
      nativePermissions: permissions,
      interactionMode: settings.collaborationMode.mode === "plan" ? "plan" : "default",
      modelSelection: {
        instanceId: "codex",
        model: settings.model,
        options: state.latestReasoningEffort
          ? [{ id: "reasoningEffort", value: state.latestReasoningEffort }]
          : [],
      },
    };
  });
  const phases = new WeakMap<
    NativeMessageAdmission,
    "fresh" | "dispatching" | "settled" | "releasing" | "released"
  >();
  const admission = (receipt: Receipt, identity: MessageIdentity): NativeMessageAdmission => {
    const value = {
      ...receipt,
      messageId: identity.messageId,
      fingerprint: fingerprintOf(identity),
    };
    phases.set(value, receipt.admitted ? "fresh" : "settled");
    return value;
  };
  const receiptCommand = (value: NativeMessageAdmission) => ({
    sessionId: value.sessionId,
    messageId: value.messageId,
    fingerprint: value.fingerprint,
    attemptId: value.attemptId,
  });
  const unconfirmed = (value: NativeMessageAdmission) => ({
    messageId: value.messageId,
    runId: null,
    status: "unknown",
    delivery: "unconfirmed" as const,
  });
  const result = (value: NativeMessageAdmission, delivered: NonNullable<Receipt["result"]>) => ({
    sessionId: value.sessionId,
    threadId: value.threadId,
    ...delivered,
  });
  const reject = Effect.fn("NativeSessionMessageIntake.reject")(function* (
    value: NativeMessageAdmission,
  ) {
    const phase = phases.get(value);
    if (!value.admitted || (phase !== "fresh" && phase !== "releasing")) return;
    // Cleanup can retry a lost reply, but can never release a dispatched attempt.
    phases.set(value, "releasing");
    yield* application.nativeMessageSettle({ ...receiptCommand(value), phase: "rejected" });
    phases.set(value, "released");
  });
  const assertBinding = Effect.fn("NativeSessionMessageIntake.assertBinding")(function* (
    value: NativeMessageAdmission,
  ) {
    const { threadId, thread } = yield* resolve({ sessionId: value.sessionId });
    if (threadId !== value.threadId || thread.executionHostId !== value.hostId)
      return yield* new SessionMessageIntakeError({
        message: "Native message binding changed before delivery",
      });
  });
  return {
    lookup: Effect.fn("NativeSessionMessageIntake.lookup")(function* (identity: MessageIdentity) {
      const receipt = yield* application.nativeMessageReceipt({
        sessionId: identity.target.sessionId,
        messageId: identity.messageId,
        fingerprint: fingerprintOf(identity),
      });
      return receipt ? admission(receipt, identity) : null;
    }),
    admit: Effect.fn("NativeSessionMessageIntake.admit")(function* (identity: MessageIdentity) {
      const { threadId, thread } = yield* resolve(identity.target);
      const receipt = yield* application.nativeMessageReserve({
        sessionId: identity.target.sessionId,
        hostId: thread.executionHostId,
        threadId,
        messageId: identity.messageId,
        fingerprint: fingerprintOf(identity),
        attemptId: randomUUID(),
        expiresAt: Number(identity.operationId.split(":")[3]),
      });
      return admission(receipt, identity);
    }),
    replay: Effect.fn("NativeSessionMessageIntake.replay")(function* (
      value: NativeMessageAdmission,
    ) {
      if (value.admitted)
        return yield* new SessionMessageIntakeError({
          message: "Fresh Native admission cannot be replayed",
        });
      if (value.result) return result(value, value.result);
      const evidence = yield* messages
        .reconcile({
          hostId: value.hostId,
          threadId: value.threadId,
          messageId: value.messageId,
        })
        .pipe(Effect.catch(() => Effect.succeed(unconfirmed(value))));
      // Absence is no producer fact: do not poison a concurrently preparing fresh attempt.
      if (evidence.delivery === "unconfirmed") return result(value, evidence);
      const settled = yield* application.nativeMessageSettle({
        ...receiptCommand(value),
        phase: "confirmed",
        result: evidence,
      });
      return result(value, settled.result ?? evidence);
    }),
    reject,
    localHostId: gateway.localHostId,
    inspect,
    prepare: Effect.fn("NativeSessionMessageIntake.prepare")(function* (
      target: SessionExecutionTarget,
    ) {
      const { threadId } = yield* resolve(target);
      const ready = yield* resume.resume(threadId);
      if (ready.status !== "ready")
        return yield* new SessionMessageIntakeError({
          message: "Native execution owner is not ready",
        });
      return yield* inspect(target);
    }),
    send: Effect.fn("NativeSessionMessageIntake.send")(function* (
      input: Omit<RuntimeSessionMessageInput, "fingerprint"> & {
        readonly expectedFacts: SessionMessageFacts;
        readonly admission: NativeMessageAdmission;
      },
    ) {
      const value = input.admission;
      if (!value.admitted || phases.get(value) !== "fresh")
        return yield* new SessionMessageIntakeError({
          message: "Native message requires a fresh admission",
        });
      const deliver = Effect.gen(function* () {
        yield* assertBinding(value);
        const facts = yield* inspect(input.target);
        if (
          facts.sessionId !== value.sessionId ||
          facts.threadId !== value.threadId ||
          facts.executionHostId !== value.hostId ||
          facts.runtimeMode !== input.expectedFacts.runtimeMode ||
          facts.interactionMode !== input.expectedFacts.interactionMode ||
          facts.threadId !== input.expectedFacts.threadId ||
          !isDeepStrictEqual(facts.nativePermissions, input.expectedFacts.nativePermissions)
        )
          return yield* new SessionMessageIntakeError({
            message: "Target execution changed before message delivery",
          });
        if (input.modelSelection && input.modelSelection.instanceId !== "codex")
          return yield* new SessionMessageIntakeError({
            message: "A native Session cannot switch execution owners",
          });
        const materialized = yield* attachments.materializeResources(
          value.hostId,
          input.attachments,
        );
        const promptInput: CodexPromptInput = { text: input.prompt, ...materialized };
        yield* assertBinding(value);
        const outcome = yield* messages
          .send(
            value.threadId,
            input.senderThreadId ?? "application",
            input.prompt,
            {
              clientUserMessageId: value.messageId,
              promptInput,
              ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
            },
            {
              expectedHostId: value.hostId,
              beforeNativeDispatch: assertBinding(value),
              onNativeDispatch: () => {
                phases.set(value, "dispatching");
              },
              mode: input.mode,
              expectedPermissions: facts.permissions,
              expectedInteractionMode: facts.interactionMode,
              ...(input.interactionModeCeiling
                ? { interactionModeCeiling: input.interactionModeCeiling }
                : {}),
            },
          )
          .pipe(Effect.result);
        if (outcome._tag === "Failure") {
          if (phases.get(value) !== "dispatching") return yield* Effect.fail(outcome.failure);
          const settled = yield* application.nativeMessageSettle({
            ...receiptCommand(value),
            phase: "unconfirmed",
          });
          phases.set(value, "settled");
          return result(value, settled.result ?? unconfirmed(value));
        }
        const delivered = outcome.success;
        // Producer evidence is irreversible even when this attempt only found a prior write.
        phases.set(value, "dispatching");
        const settled = yield* application.nativeMessageSettle(
          delivered.delivery === "unconfirmed"
            ? { ...receiptCommand(value), phase: "unconfirmed" }
            : { ...receiptCommand(value), phase: "confirmed", result: delivered },
        );
        phases.set(value, "settled");
        return result(value, settled.result ?? delivered);
      });
      return yield* deliver.pipe(
        Effect.onExit((exit) => {
          if (exit._tag !== "Failure") return Effect.void;
          if (phases.get(value) !== "dispatching") return reject(value);
          // Cancellation after producer admission leaves a durable fence, never a resend permit.
          return application
            .nativeMessageSettle({ ...receiptCommand(value), phase: "unconfirmed" })
            .pipe(Effect.asVoid);
        }),
      );
    }),
  };
});
