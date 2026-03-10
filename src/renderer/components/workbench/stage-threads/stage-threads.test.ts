import { describe, expect, test } from "bun:test";
import type { CodexThreadDetail } from "@/lib/types";
import { resolveContextWindowIndicatorState } from "../../../lib/codex-context-window";

function makeThreadDetail(): CodexThreadDetail {
  return {
    threadId: "thr_context",
    projectId: "project-1",
    cardId: "card-1",
    threadName: "Context thread",
    threadPreview: "",
    modelProvider: "openai",
    cwd: "/tmp/project",
    statusType: "active",
    statusActiveFlags: [],
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    linkedAt: new Date(0).toISOString(),
    turns: [],
    items: [],
  };
}

describe("stage-threads context window indicator", () => {
  test("keeps the raw token count when usage exceeds the model context window", () => {
    const detail = makeThreadDetail();
    detail.turns = [
      {
        threadId: detail.threadId,
        turnId: "turn_over_limit",
        status: "inProgress",
        itemIds: [],
        tokenUsage: {
          total: {
            totalTokens: 300_000,
            inputTokens: 260_000,
            cachedInputTokens: 10_000,
            outputTokens: 40_000,
            reasoningOutputTokens: 5_000,
          },
          last: {
            totalTokens: 300_000,
            inputTokens: 260_000,
            cachedInputTokens: 10_000,
            outputTokens: 40_000,
            reasoningOutputTokens: 5_000,
          },
          modelContextWindow: 258_000,
        },
      },
    ];

    const state = resolveContextWindowIndicatorState(detail);

    expect(state.status).toBe("ready");
    expect(state.percentFull).toBe(100);
    expect(state.usedTokens).toBe(300_000);
    expect(state.windowTokens).toBe(258_000);
  });
});
