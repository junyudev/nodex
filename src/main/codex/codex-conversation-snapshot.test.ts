import { describe, expect, test } from "vite-plus/test";
import { buildCodexConversationSnapshot } from "./codex-conversation-snapshot";
import type {
  CodexApprovalRequest,
  CodexCanonicalConversationState,
  CodexThreadDetail,
} from "../../shared/types";

function buildThreadDetail(overrides?: Partial<CodexThreadDetail>): CodexThreadDetail {
  return {
    threadId: "thread_1",
    projectId: "project_1",
    source: null,
    threadName: "Thread",
    threadPreview: "Preview",
    modelProvider: "openai",
    cwd: "/tmp/project",
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    linkedAt: "2026-03-22T00:00:00.000Z",
    turns: [
      {
        threadId: "thread_1",
        turnId: "turn_1",
        status: "completed",
        itemIds: ["assistant_1", "user_1"],
      },
    ],
    transcript: [
      {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "assistant_1",
        type: "assistant_message",
        kind: "assistantMessage",
        semanticKind: "assistantMessage",
        role: "assistant",
        sequence: 2,
        markdownText: "Answer",
        createdAt: 2,
        updatedAt: 2,
      },
      {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "user_1",
        type: "user_message",
        kind: "userMessage",
        semanticKind: "userMessage",
        role: "user",
        sequence: 1,
        markdownText: "Question",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    ...overrides,
    hasUnreadTurn: overrides?.hasUnreadTurn ?? false,
  };
}

describe("buildCodexConversationSnapshot", () => {
  test("carries the lossless canonical document without reconstructing it from view turns", () => {
    const canonicalState = {
      ...{ id: "thread_1" },
      turns: [{ turnId: "turn_1", items: [{ id: "hidden-1" }] }],
      requests: [{ id: 7 }],
      hasUnreadTurn: true,
    } as unknown as CodexCanonicalConversationState;
    const snapshot = buildCodexConversationSnapshot({
      detail: buildThreadDetail(),
      resumeState: "resumed",
      requests: [],
      canonicalState,
      capabilityFlags: {
        canEditLastUserTurn: true,
        canForkFromTurn: true,
        canSearch: true,
        canCollapseTurns: true,
      },
    });

    expect(snapshot.canonicalState === canonicalState).toBe(true);
    expect(snapshot.canonicalState?.turns[0]?.items[0]?.id).toBe("hidden-1");
    expect(snapshot.canonicalState?.requests[0]?.id).toBe(7);
  });

  test("orders turn items by the canonical turn itemIds instead of transcript sequence", () => {
    const request: CodexApprovalRequest = {
      type: "approval",
      requestId: "approval_1",
      kind: "command",
      projectId: "project_1",
      threadId: "thread_1",
      turnId: "turn_1",
      itemId: "assistant_1",
      createdAt: 5,
    };

    const snapshot = buildCodexConversationSnapshot({
      detail: buildThreadDetail(),
      resumeState: "resumed",
      requests: [request],
      capabilityFlags: {
        canEditLastUserTurn: true,
        canForkFromTurn: true,
        canSearch: true,
        canCollapseTurns: true,
      },
    });

    expect(snapshot.turns.length).toBe(1);
    expect(snapshot.turns[0]?.items[0]?.itemId).toBe("assistant_1");
    expect(snapshot.turns[0]?.items[1]?.itemId).toBe("user_1");
    expect(snapshot.requests[0]?.requestId).toBe("approval_1");
    expect(snapshot.capabilityFlags.canSearch).toBe(true);
    expect(snapshot.turnPagination?.hasLoadedOldest ?? false).toBe(true);
    expect(snapshot.turnPagination?.loadedTurnCount ?? 0).toBe(1);
  });

  test("keeps app-local null-id goal turns separate by projected item identity", () => {
    const nullTurnId = null as unknown as string;
    const detail = buildThreadDetail({
      turns: [
        {
          threadId: "thread_1",
          turnId: nullTurnId,
          status: "completed",
          itemIds: ["goal_1"],
        },
        {
          threadId: "thread_1",
          turnId: nullTurnId,
          status: "completed",
          itemIds: ["goal_2"],
        },
      ],
      transcript: [
        {
          threadId: "thread_1",
          turnId: nullTurnId,
          itemId: "goal_1",
          type: "user_message",
          kind: "userMessage",
          semanticKind: "userMessage",
          role: "user",
          sequence: 1,
          markdownText: "First goal",
          goal: true,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          threadId: "thread_1",
          turnId: nullTurnId,
          itemId: "goal_2",
          type: "user_message",
          kind: "userMessage",
          semanticKind: "userMessage",
          role: "user",
          sequence: 2,
          markdownText: "Second goal",
          goal: true,
          createdAt: 2,
          updatedAt: 2,
        },
      ],
    });
    const snapshot = buildCodexConversationSnapshot({
      detail,
      resumeState: "resumed",
      requests: [],
      capabilityFlags: {
        canEditLastUserTurn: true,
        canForkFromTurn: true,
        canSearch: true,
        canCollapseTurns: true,
      },
    });

    expect(snapshot.turns[0]?.items[0]?.markdownText).toBe("First goal");
    expect(snapshot.turns[1]?.items[0]?.markdownText).toBe("Second goal");
    expect(String(snapshot.turns[0]?.items.length ?? -1)).toBe("1");
    expect(String(snapshot.turns[1]?.items.length ?? -1)).toBe("1");
  });

  test("preserves protocol-backed turn pagination metadata", () => {
    const snapshot = buildCodexConversationSnapshot({
      detail: buildThreadDetail(),
      resumeState: "resumed",
      requests: [],
      capabilityFlags: {
        canEditLastUserTurn: true,
        canForkFromTurn: true,
        canSearch: true,
        canCollapseTurns: true,
      },
      turnPagination: {
        olderCursor: "cursor-older",
        backwardsCursor: "cursor-newer",
        oldestLoadedTurnId: "turn_older",
        isLoadingOlder: false,
        hasLoadedOldest: false,
        loadedTurnCount: 50,
        itemsView: "full",
      },
    });

    expect(snapshot.turnPagination?.olderCursor ?? null).toBe("cursor-older");
    expect(snapshot.turnPagination?.backwardsCursor ?? null).toBe("cursor-newer");
    expect(snapshot.turnPagination?.oldestLoadedTurnId ?? null).toBe("turn_older");
    expect(snapshot.turnPagination?.hasLoadedOldest ?? true).toBe(false);
    expect(snapshot.turnPagination?.itemsView ?? "summary").toBe("full");
  });

  test("appends unknown turn entries after known itemIds using transcript fallback order", () => {
    const snapshot = buildCodexConversationSnapshot({
      detail: buildThreadDetail({
        turns: [
          {
            threadId: "thread_1",
            turnId: "turn_1",
            status: "completed",
            itemIds: ["assistant_1", "user_1"],
          },
        ],
        transcript: [
          ...buildThreadDetail().transcript,
          {
            threadId: "thread_1",
            turnId: "turn_1",
            itemId: "tool_1",
            type: "function_call",
            kind: "toolCall",
            semanticKind: "toolCall",
            sequence: 0,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      }),
      resumeState: "resumed",
      requests: [],
      capabilityFlags: {
        canEditLastUserTurn: true,
        canForkFromTurn: true,
        canSearch: true,
        canCollapseTurns: true,
      },
    });

    expect(snapshot.turns[0]?.items.length).toBe(3);
    expect(snapshot.turns[0]?.items[0]?.itemId).toBe("assistant_1");
    expect(snapshot.turns[0]?.items[1]?.itemId).toBe("user_1");
    expect(snapshot.turns[0]?.items[2]?.itemId).toBe("tool_1");
  });

  test("keeps the params input before canonical raw items", () => {
    const detail = buildThreadDetail({
      turns: [
        {
          threadId: "thread_1",
          turnId: "turn_1",
          status: "completed",
          itemIds: ["tool_1", "assistant_1"],
        },
      ],
      transcript: [
        {
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "tool_1",
          type: "commandExecution",
          kind: "commandExecution",
          semanticKind: "exec",
          sequence: 1,
          createdAt: 2,
          updatedAt: 2,
        },
        {
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "assistant_1",
          type: "agentMessage",
          kind: "assistantMessage",
          semanticKind: "assistantMessage",
          sequence: 2,
          createdAt: 3,
          updatedAt: 3,
        },
        {
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "turn_1:input",
          type: "userMessage",
          kind: "userMessage",
          semanticKind: "userMessage",
          sequence: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    const snapshot = buildCodexConversationSnapshot({
      detail,
      resumeState: "resumed",
      requests: [],
      capabilityFlags: {
        canEditLastUserTurn: true,
        canForkFromTurn: true,
        canSearch: true,
        canCollapseTurns: true,
      },
    });

    expect(snapshot.turns[0]?.items.map((item) => item.itemId)).toEqual([
      "turn_1:input",
      "tool_1",
      "assistant_1",
    ]);
  });

  test("orders synthetic steer entries with canonical turn item ids", () => {
    const snapshot = buildCodexConversationSnapshot({
      detail: buildThreadDetail({
        turns: [
          {
            threadId: "thread_1",
            turnId: "turn_1",
            status: "completed",
            itemIds: ["assistant_before", "steer_1", "user_msg_1:steered", "assistant_after"],
          },
        ],
        transcript: [
          {
            threadId: "thread_1",
            turnId: "turn_1",
            itemId: "assistant_after",
            type: "agentMessage",
            kind: "assistantMessage",
            semanticKind: "assistantMessage",
            role: "assistant",
            sequence: 4,
            markdownText: "Answer after steering",
            createdAt: 4,
            updatedAt: 4,
          },
          {
            threadId: "thread_1",
            turnId: "turn_1",
            itemId: "steer_1",
            type: "steeringUserMessage",
            kind: "userMessage",
            semanticKind: "userMessage",
            role: "user",
            steeringStatus: "accepted",
            sequence: 2,
            markdownText: "who are you",
            createdAt: 2,
            updatedAt: 2,
          },
          {
            threadId: "thread_1",
            turnId: "turn_1",
            itemId: "assistant_before",
            type: "agentMessage",
            kind: "assistantMessage",
            semanticKind: "assistantMessage",
            role: "assistant",
            sequence: 1,
            markdownText: "Answer before steering",
            createdAt: 1,
            updatedAt: 1,
          },
          {
            threadId: "thread_1",
            turnId: "turn_1",
            itemId: "user_msg_1:steered",
            type: "steered",
            kind: "systemEvent",
            semanticKind: "steered",
            sequence: 3,
            markdownText: "Steered conversation",
            createdAt: 3,
            updatedAt: 3,
          },
        ],
      }),
      resumeState: "resumed",
      requests: [],
      capabilityFlags: {
        canEditLastUserTurn: true,
        canForkFromTurn: true,
        canSearch: true,
        canCollapseTurns: true,
      },
    });

    expect(snapshot.turns[0]?.items.map((item) => item.itemId).join(",")).toBe(
      "assistant_before,steer_1,user_msg_1:steered,assistant_after",
    );
  });
});
