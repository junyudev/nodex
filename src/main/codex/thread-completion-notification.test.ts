import { describe, expect, test } from "bun:test";
import type { CodexThreadDetail, CodexThreadSummary, CodexTurnSummary } from "../../shared/types";
import { resolveThreadCompletionNotificationContent } from "./thread-completion-notification";

function makeThread(overrides?: Partial<CodexThreadSummary>): CodexThreadSummary {
  return {
    threadId: "thread-1",
    projectId: "default",
    cardId: "card-1",
    threadName: "Ship thread notifications",
    threadPreview: "Preview fallback",
    modelProvider: "openai",
    cwd: null,
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    linkedAt: "2026-03-04T00:00:00.000Z",
    ...overrides,
  };
}

function makeTurn(overrides?: Partial<CodexTurnSummary>): CodexTurnSummary {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    itemIds: [],
    ...overrides,
  };
}

function makeDetail(overrides?: Partial<CodexThreadDetail>): CodexThreadDetail {
  return {
    threadId: "thread-1",
    projectId: "default",
    cardId: "card-1",
    threadName: "Ship thread notifications",
    threadPreview: "Preview fallback",
    modelProvider: "openai",
    cwd: null,
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    linkedAt: "2026-03-04T00:00:00.000Z",
    turns: [],
    items: [
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        type: "agentMessage",
        normalizedKind: "assistantMessage",
        role: "assistant",
        markdownText: "Final answer ready.",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    ...overrides,
  };
}

describe("resolveThreadCompletionNotificationContent", () => {
  test("uses the last assistant message for a completed turn", () => {
    const content = resolveThreadCompletionNotificationContent({
      thread: makeThread(),
      detail: makeDetail({
        items: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "user-1",
            type: "userMessage",
            normalizedKind: "userMessage",
            role: "user",
            markdownText: "Please add thread notifications",
            createdAt: 1,
            updatedAt: 1,
          },
          {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "assistant-1",
            type: "agentMessage",
            normalizedKind: "assistantMessage",
            role: "assistant",
            markdownText: "Implemented native notifications and a settings toggle.",
            createdAt: 2,
            updatedAt: 2,
          },
        ],
      }),
      turn: makeTurn(),
    });

    expect(content?.title).toBe("Ship thread notifications");
    expect(content?.body).toBe("Implemented native notifications and a settings toggle.");
  });

  test("falls back to the thread preview when the turn has no text items", () => {
    const content = resolveThreadCompletionNotificationContent({
      thread: makeThread({ threadPreview: "Preview from thread summary" }),
      detail: makeDetail({ items: [] }),
      turn: makeTurn(),
    });

    expect(content?.title).toBe("Ship thread notifications");
    expect(content?.body).toBe("Preview from thread summary");
  });

  test("uses a status fallback for failed turns without text", () => {
    const content = resolveThreadCompletionNotificationContent({
      thread: makeThread({ threadPreview: "" }),
      detail: makeDetail({ items: [] }),
      turn: makeTurn({ status: "failed", errorMessage: "Process exited with code 1" }),
    });

    expect(content?.title).toBe("Ship thread notifications");
    expect(content?.body).toBe("Process exited with code 1");
  });

  test("does not build content for active turns", () => {
    const content = resolveThreadCompletionNotificationContent({
      thread: makeThread(),
      detail: makeDetail(),
      turn: makeTurn({ status: "inProgress" }),
    });

    expect(content).toBe(null);
  });

  test("does not build content for unlinked helper threads", () => {
    const content = resolveThreadCompletionNotificationContent({
      thread: null,
      detail: makeDetail(),
      turn: makeTurn(),
    });

    expect(content).toBe(null);
  });
});
