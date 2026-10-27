import { describe, expect, test } from "vite-plus/test";
import {
  CodexReasoningEffortSchema,
  CodexAsyncQuestionResponseSchema,
  CodexThreadStatusTypeSchema,
  parseCodexThreadTokenUsage,
} from "./codex";
import type { CodexAsyncQuestionResponseInput } from "../codex-async-user-input";

const questionResponse = {
  threadId: "thread:questions",
  submissionId: "answer-batch",
  sourceTurnIds: ["source:completed", "source:interrupted"],
  replies: [
    { questionItemId: "question:color", question: "Color?", answer: "Blue" },
    { questionItemId: "question:name", question: "Name?", answer: "Release" },
  ],
  collaborationMode: "default",
  serviceTier: null,
} satisfies CodexAsyncQuestionResponseInput;

describe("native question response boundary", () => {
  test.each([null, "priority", "future-tier"])(
    "preserves a valid answer batch with tier %s",
    (serviceTier) => {
      const batch = { ...questionResponse, serviceTier };
      expect(CodexAsyncQuestionResponseSchema.parse(batch)).toEqual(batch);
    },
  );

  test.each([
    null,
    { ...questionResponse, threadId: " " },
    { ...questionResponse, submissionId: "" },
    { ...questionResponse, submissionId: " batch" },
    { ...questionResponse, sourceTurnIds: [] },
    { ...questionResponse, sourceTurnIds: [null] },
    { ...questionResponse, replies: [] },
    { ...questionResponse, replies: [{ ...questionResponse.replies[0], questionItemId: "" }] },
    { ...questionResponse, replies: [{ ...questionResponse.replies[0], answer: " \n " }] },
    { ...questionResponse, replies: [{ ...questionResponse.replies[0], answer: 12 }] },
    { ...questionResponse, replies: [questionResponse.replies[0], questionResponse.replies[0]] },
    {
      ...questionResponse,
      replies: [{ ...questionResponse.replies[0], turnId: "another-source" }],
    },
    { ...questionResponse, expectedTurnId: "another-source" },
    { ...questionResponse, collaborationMode: "unknown-mode" },
    { ...questionResponse, serviceTier: 5 },
    { ...questionResponse, serviceTier: " " },
  ])("rejects a malformed or ambiguous answer batch %#", (value) => {
    expect(CodexAsyncQuestionResponseSchema.safeParse(value).success).toBe(false);
  });
});

describe("generated Codex schemas", () => {
  test("parses the current generated thread token usage shape", () => {
    const value = {
      total: {
        totalTokens: 12,
        inputTokens: 5,
        cachedInputTokens: 1,
        cacheWriteInputTokens: 0,
        outputTokens: 6,
        reasoningOutputTokens: 2,
      },
      last: {
        totalTokens: 4,
        inputTokens: 2,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 2,
        reasoningOutputTokens: 1,
      },
      modelContextWindow: null,
    };

    expect(parseCodexThreadTokenUsage(value)).toEqual(value);
  });

  test("rejects historical spellings and invalid current payloads at the live boundary", () => {
    expect(
      parseCodexThreadTokenUsage({
        total_token_usage: {},
        last_token_usage: {},
        model_context_window: null,
      }),
    ).toBeUndefined();
    expect(
      parseCodexThreadTokenUsage({
        total: { totalTokens: 12 },
        last: {},
        modelContextWindow: null,
      }),
    ).toBeUndefined();
  });

  test("accepts dynamic reasoning efforts while deriving closed status values", () => {
    expect(CodexReasoningEffortSchema.parse("future-effort")).toBe("future-effort");
    expect(CodexReasoningEffortSchema.parse(" Thinking ")).toBe("Thinking");
    expect(CodexReasoningEffortSchema.safeParse("thinking\nunsafe").success).toBe(false);
    expect(CodexThreadStatusTypeSchema.safeParse("active").success).toBe(true);
    expect(CodexThreadStatusTypeSchema.safeParse("future-status").success).toBe(false);
  });
});
