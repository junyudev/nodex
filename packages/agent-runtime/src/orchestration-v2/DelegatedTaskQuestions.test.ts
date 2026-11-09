import * as IdAllocator from "@nodex/provider-core/server/IdAllocator";
import { CommandId, RuntimeRequestId, ThreadId } from "@nodex/runtime-contracts";
import { describe, expect, it } from "vitest";

import { questionNoticeId } from "./DelegatedTaskQuestions.ts";

// Session item reads accept identities up to 512 characters.
const READ_BOUNDARY = 512;

const requestId = RuntimeRequestId.make(
  "runtime-request:provider:codex:provider-turn:provider-turn%3Aprovider%3Acodex%3Anative-turn%3A01a1c127-b65a-76d2-a9e4-2d30b7037c76:native-request:async%3Acall_9a63df1ae0fe4f109150c5b97402cdbf:4c9f96df-7b6f-40e1-a6a8-198bfb418013",
);
const parentThreadId = ThreadId.make(
  "nodex:thread:bf97bc53133eeedbf7d83741abd715d132c0b17b3869b2662c0897fc85f5fe7d",
);
const commandId = CommandId.make(
  `mcp:task-question:respond:${parentThreadId}:node:task:T7FvcF81e8mE_QeGYXwCa0:${requestId}`,
);

describe("question message identities", () => {
  it("stay readable as transcript items however long their request is", () => {
    const answer = IdAllocator.derive.questionAnswerMessage({ requestId, commandId });
    const notice = questionNoticeId(parentThreadId, requestId);
    for (const messageId of [answer, notice]) {
      expect(IdAllocator.derive.userTurnItem({ messageId }).length, messageId).toBeLessThanOrEqual(
        READ_BOUNDARY,
      );
    }
    expect(answer.startsWith("async-answer:")).toBe(true);
  });

  it("are stable for the same question and distinct across questions and answer batches", () => {
    const other = RuntimeRequestId.make(`${requestId}:2`);
    expect(questionNoticeId(parentThreadId, requestId)).toBe(
      questionNoticeId(parentThreadId, requestId),
    );
    expect(questionNoticeId(parentThreadId, requestId)).not.toBe(
      questionNoticeId(parentThreadId, other),
    );
    expect(IdAllocator.derive.questionAnswerMessage({ requestId, commandId })).not.toBe(
      IdAllocator.derive.questionAnswerMessage({
        requestId,
        commandId: CommandId.make(`${commandId}:retry`),
      }),
    );
  });
});
