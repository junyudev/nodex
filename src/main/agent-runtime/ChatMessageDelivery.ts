import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import type { AgentRuntimeMessage } from "../../shared/agent-runtime-api";
import type { components } from "@nodex/core-protocol";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { createOperationId } from "../core-runtime/operation-identity";

export const inboundTextHash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Record admission evidence; the execution owner retains text and attachment bytes. */
export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  return Effect.fn("ChatMessageDelivery.record")(function* (
    sessionId: string,
    message: AgentRuntimeMessage,
    options?: {
      readonly host?: boolean;
      readonly senderThreadId?: string;
      readonly senderRunId?: string | null;
      readonly questionRunId?: string | null;
    },
  ) {
    const session = yield* core.workspace
      .pipe(Effect.provideService(CoreApplicationAgent, null));
    if (session.value.kind !== "session") return;
    if (!session.value.session.managed && !options?.questionRunId) return;
    const caller = yield* CoreApplicationAgent;
    const author: components["schemas"]["ProjectWorkspaceInboxSource"] =
      caller || options?.senderThreadId || options?.host
        ? {
            kind: "agent",
            session_id: caller?.authority.runtime?.session_id ?? null,
            thread_id: caller?.authority.thread_id ?? options?.senderThreadId ?? null,
            run_id: caller?.authority.turn_id ?? options?.senderRunId ?? null,
            project_id: caller?.authority.actor_project_id ?? null,
            label: options?.host ? "Nodex" : "Agent",
          }
        : { kind: "user" };
    yield* core.workspace
      .apply(
        {
          operationId: createOperationId("chat.delivery"),
          intent: {
            kind: "record_chat_delivery",
            session_id: sessionId,
            delivery_id: message.messageId,
            body_hash: inboundTextHash(message.text),
            author,
            attachment_count:
              message.attachments?.filter(
                (attachment) => attachment.type === "image" || attachment.type === "file",
              ).length ??
              message.images?.length ??
              0,
            question_answer_run_id: options?.questionRunId ?? null,
          },
        },
        undefined,
        null,
      )
      .pipe(Effect.provideService(CoreApplicationAgent, null));
  });
});
