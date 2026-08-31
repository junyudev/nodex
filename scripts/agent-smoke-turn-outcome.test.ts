import { describe, expect, test } from "vitest";

import {
  classifyAgentSmokeTurnSnapshot,
  summarizeAgentSmokeTurnSnapshot,
} from "./agent-smoke-turn-outcome";

describe("Agent smoke Turn outcome", () => {
  test("keeps sparse and retryable in-progress snapshots pending", () => {
    expect(classifyAgentSmokeTurnSnapshot(null)).toEqual({ kind: "pending" });
    expect(
      classifyAgentSmokeTurnSnapshot({
        statusType: "active",
        turns: [
          {
            status: "inProgress",
            items: [{ semanticKind: "streamError", message: "retrying", willRetry: true }],
          },
        ],
      }),
    ).toEqual({ kind: "pending" });
  });

  test.each(["failed", "interrupted"] as const)("fails immediately on a %s Turn", (status) => {
    expect(classifyAgentSmokeTurnSnapshot({ statusType: "idle", turns: [{ status }] })).toEqual({
      kind: "terminalFailure",
      reason: status,
    });
  });

  test("treats a Thread system error without a terminal Turn as failure", () => {
    expect(
      classifyAgentSmokeTurnSnapshot({
        statusType: "systemError",
        turns: [{ status: "inProgress" }],
      }),
    ).toEqual({ kind: "terminalFailure", reason: "systemError" });
  });

  test("does not let a completed Turn hide a Thread system error", () => {
    expect(
      classifyAgentSmokeTurnSnapshot({
        statusType: "systemError",
        turns: [{ status: "completed" }],
      }),
    ).toEqual({ kind: "terminalFailure", reason: "systemError" });
  });

  test("accepts only the completed Turn state", () => {
    expect(
      classifyAgentSmokeTurnSnapshot({ statusType: "idle", turns: [{ status: "completed" }] }),
    ).toEqual({ kind: "completed" });
    expect(
      classifyAgentSmokeTurnSnapshot({ statusType: "active", turns: [{ status: "completed" }] }),
    ).toEqual({ kind: "pending" });
  });

  test("keeps bounded terminal error details in diagnostics", () => {
    const summary = summarizeAgentSmokeTurnSnapshot(
      {
        threadId: "thread-a",
        statusType: "idle",
        turns: [
          {
            id: "turn-a",
            status: "failed",
            errorMessage: "provider rejected tools",
            items: [{ type: "error", message: "bad schema" }],
          },
        ],
      },
      "fallback-thread",
    );
    expect(summary).toMatchObject({
      threadId: "thread-a",
      turn: {
        id: "turn-a",
        status: "failed",
        errorMessage: "provider rejected tools",
        items: [{ type: "error", message: "bad schema" }],
      },
    });
  });
});
