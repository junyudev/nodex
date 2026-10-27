import * as Effect from "effect/Effect";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import type { AgentRuntimeMessage } from "../../shared/agent-runtime-api";
import {
  runtimeSessionTarget,
  type SessionExecutionTarget,
} from "../../shared/nodex-app-tools/session-execution-target";
import type { ResolvedSessionAttachment } from "./SessionMessageAttachments";
import type { SessionMessageFacts } from "./session-message-policy";

export interface RuntimeSessionMessageInput {
  readonly target: SessionExecutionTarget;
  readonly messageId: string;
  readonly fingerprint: string;
  readonly prompt: string;
  readonly mode: "auto" | "queue" | "steer" | "restart";
  readonly modelSelection?: NonNullable<AgentRuntimeMessage["modelSelection"]>;
  readonly attachments: readonly ResolvedSessionAttachment[];
  readonly interactionModeCeiling?: "plan";
  readonly senderThreadId?: string;
  readonly senderRunId?: string | null;
}

/** Runtime owns both descendant proof and durable message delivery; intake supplies resources. */
export const make = Effect.gen(function* () {
  const application = yield* AgentRuntimeApplication;
  return {
    resume: (input: {
      readonly target: SessionExecutionTarget;
      readonly operationId: string;
      readonly messageId: string;
      readonly fingerprint: string;
      readonly modeLimit: import("@nodex/agent-runtime/contracts").AgentDispatchModeLimit;
    }) =>
      input.target.execution
        ? Effect.succeed(null)
        : application.resumeMessageLaunch({
            sessionId: input.target.sessionId,
            launchId: input.operationId,
            messageId: input.messageId,
            fingerprint: input.fingerprint,
            modeLimit: input.modeLimit,
          }),
    replay: (input: {
      readonly target: SessionExecutionTarget;
      readonly messageId: string;
      readonly fingerprint: string;
    }) =>
      application.replayMessage({
        ...runtimeSessionTarget(input.target),
        messageId: input.messageId,
        fingerprint: input.fingerprint,
      }),
    inspect: (target: SessionExecutionTarget) =>
      application.inspect(runtimeSessionTarget(target)).pipe(
        Effect.map((inspection): SessionMessageFacts => ({
          sessionId: inspection.sessionId,
          threadId: inspection.threadId,
          runtimeMode: inspection.thread.runtimeMode,
          interactionMode: inspection.thread.interactionMode,
          modelSelection: inspection.thread.modelSelection,
        })),
      ),
    send: (input: RuntimeSessionMessageInput) =>
      application.sendMessage({
        ...runtimeSessionTarget(input.target),
        mode: input.mode,
        messageFingerprint: input.fingerprint,
        resources: input.attachments,
        ...(input.interactionModeCeiling
          ? { interactionModeCeiling: input.interactionModeCeiling }
          : {}),
        ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
        ...(input.senderRunId === undefined ? {} : { senderRunId: input.senderRunId }),
        message: {
          messageId: input.messageId,
          text: input.prompt,
          ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
        },
      }),
  };
});
