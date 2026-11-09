import * as Effect from "effect/Effect";
import type { AgentRuntimeLaunch } from "../../shared/agent-runtime-api";
import {
  AgentRuntimeApplicationError,
  type AgentRuntimeApplication,
} from "../../main/agent-runtime/AgentRuntimeApplication";

/** Shared local-chat outbox delivery: reconcile admission before repeating a frozen launch. */
export const deliverChatLaunch = Effect.fn("ChatLaunchDelivery.deliver")(function* (
  runtime: Pick<AgentRuntimeApplication["Service"], "messageAdmission" | "launch">,
  input: AgentRuntimeLaunch,
) {
  const receipt = yield* runtime.messageAdmission({
    sessionId: input.sessionId,
    launchId: input.launchId,
    messageId: input.message.messageId,
  });
  if (receipt?.status === "accepted") return receipt.threadId;
  if (receipt?.status === "rejected")
    return yield* new AgentRuntimeApplicationError({
      operation: "launch",
      message: receipt.error || "The chat rejected this launch",
      admissionRejected: true,
    });
  return (yield* runtime.launch(input)).threadId;
});
