import { describe, expect, it } from "vite-plus/test";
import type { AgentRuntimeResponseInput } from "../agent-runtime-api";
import {
  AgentRuntimeControlSchema,
  AgentRuntimeModesSchema,
  AgentRuntimeResponseSchema,
} from "./agent-runtime-api";

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

describe("native execution controls", () => {
  it.each(["approval-required", "auto", "full-access"])(
    "accepts the canonical %s mode",
    (runtimeMode) => {
      expect(
        AgentRuntimeModesSchema.parse({
          sessionId: "session",
          requestId: "mode-change",
          runtimeMode,
        }).runtimeMode,
      ).toBe(runtimeMode);
    },
  );
  it("transports a decline and feedback while rejecting standing approval grants", () => {
    const input = {
      sessionId: "session",
      runId: null,
      requestId: "approval",
      decision: "decline",
      feedback: "Keep it inside the workspace",
    };
    expect(AgentRuntimeResponseSchema.parse(input)).toEqual(input);
    expect(
      AgentRuntimeResponseSchema.safeParse({ ...input, decision: "acceptAlways" }).success,
    ).toBe(false);
    expect(
      AgentRuntimeResponseSchema.safeParse({ ...input, feedback: "x".repeat(10_001) }).success,
    ).toBe(false);
  });
});

it("keeps an exact approval request and original Run in control reads", () => {
  const target = {
    sessionId: "session",
    threadId: "child",
    requestId: "approval",
    runId: "original-run",
    requireActive: true,
  };
  expect(AgentRuntimeControlSchema.parse(target)).toEqual(target);
});
