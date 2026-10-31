import { CommandId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";

/** Compaction is an ordinary, durable maintenance Run with fresh Turn authority. */
export const compactThread = Effect.fn("AgentRuntime.compactThread")(function* (input: {
  readonly threadId: ThreadId;
  readonly requestId: CommandId;
  readonly failedRunId?: RunId | undefined;
}) {
  const threads = yield* ThreadManagementService;
  const commandId = CommandId.make(
    input.failedRunId === undefined
      ? `host:thread.compact:${input.requestId}`
      : `context-recovery:${input.threadId}:${input.failedRunId}:compact`,
  );
  const messageId = MessageId.make(`message:thread.compact:${input.requestId}`);
  const receipt = yield* threads.dispatch(
    input.failedRunId === undefined
      ? {
          type: "message.dispatch",
          commandId,
          threadId: input.threadId,
          messageId,
          text: "/compact",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        }
      : {
          type: "run.context-recover",
          commandId,
          threadId: input.threadId,
          failedRunId: input.failedRunId,
        },
  );
  const created = receipt.storedEvents.find(({ event }) => event.type === "run.created");
  if (created?.event.type !== "run.created")
    return yield* Effect.fail(new Error("Compaction was accepted without a durable Run."));
  return {
    commandId,
    messageId: created.event.payload.userMessageId,
    runId: created.event.payload.id,
    sequence: receipt.sequence,
  };
});
