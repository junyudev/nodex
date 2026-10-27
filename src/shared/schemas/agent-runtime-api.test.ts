import { describe, expect, it } from "vite-plus/test";
import type { AgentRuntimeResponseInput } from "../agent-runtime-api";
import { AgentRuntimeResponseSchema } from "./agent-runtime-api";

const answer = {
  sessionId: "session:questions",
  threadId: "thread:questions",
  runId: "run:source",
  requestId: "request:colors",
  submissionId: "answer-batch:request:colors",
  answers: { color: "Blue" },
} satisfies AgentRuntimeResponseInput;

describe("question answer admission", () => {
  it("keeps the answer batch identity across the strict renderer input boundary", () => {
    expect(AgentRuntimeResponseSchema.parse(answer)).toEqual(answer);
  });

  it.each(["", " batch", "batch ", "a".repeat(513)])(
    "rejects an invalid answer batch identity %#",
    (submissionId) => {
      expect(AgentRuntimeResponseSchema.safeParse({ ...answer, submissionId }).success).toBe(false);
    },
  );
});
