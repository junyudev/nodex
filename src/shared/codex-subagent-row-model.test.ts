import { describe, expect, test } from "vitest";
import {
  buildBackgroundSubagentRows,
  type BuildBackgroundSubagentRowsInput,
  type SubagentConversation,
} from "./codex-subagent-row-model";
import type {
  CodexConversationItem,
  CodexConversationTurn,
  CodexSubagentActivityView,
} from "./types";

function item(
  rawItem: unknown,
  subagentActivity?: CodexSubagentActivityView,
): CodexConversationItem {
  return {
    entryId: "event",
    itemId: "event",
    threadId: "root",
    turnId: "turn",
    type: subagentActivity ? "subAgentActivity" : "collabAgentToolCall",
    kind: "toolCall",
    status: "completed",
    createdAt: 10,
    updatedAt: 10,
    rawItem,
    subagentActivity,
  };
}
function action(tool: string, status = "running") {
  return item({
    type: "collabAgentToolCall",
    tool,
    status: "completed",
    receiverThreadIds: ["child"],
    receiverThreads: [],
    agentsStates: { child: { status, message: null } },
    model: "spawn-model",
    prompt: "Investigate the failure",
  });
}
function activity(displayStatus: CodexSubagentActivityView["displayStatus"], isMessage = false) {
  return item(null, { agentThreadId: "child", displayName: "Scout", displayStatus, isMessage });
}
function turn(
  items: CodexConversationItem[],
  turnId = "turn",
  status: CodexConversationTurn["status"] = "completed",
): CodexConversationTurn {
  return {
    threadId: "root",
    turnId,
    items,
    itemIds: items.map((x) => x.itemId),
    status,
    turnStartedAtMs: 10,
  };
}
function rows(
  items: CodexConversationItem[],
  child?: SubagentConversation,
  overrides: Partial<BuildBackgroundSubagentRowsInput> = {},
) {
  return buildBackgroundSubagentRows({
    parentConversationId: "root",
    parentTurns: [turn(items)],
    childMemberships: [
      { threadId: "child", parentThreadId: "root", role: "backgroundChild", displayName: "Scout" },
    ],
    knownConversationsById: child ? { child } : {},
    discoveryComplete: false,
    ...overrides,
  });
}

describe("shared subagent row contract", () => {
  test("runtime status has the same priority independently of active waiting flags", () => {
    expect(rows([action("spawnAgent", "pendingInit")])[0]?.status).toBe("waiting");
    expect(
      rows([action("spawnAgent", "pendingInit")], {
        turns: [],
        threadRuntimeStatus: { type: "active", activeFlags: ["waitingOnApproval"] },
      })[0]?.status,
    ).toBe("active");
    expect(rows([], { turns: [], threadRuntimeStatus: { type: "notLoaded" } })[0]?.status).toBe(
      "done",
    );
    expect(rows([], undefined, { discoveryComplete: true })[0]?.status).toBe("done");
    expect(rows([])[0]?.status).toBe("active");
  });
  test("close, system errors and failed turns hide, while live runtime overrides stale agent failures", () => {
    const active: SubagentConversation = {
      turns: [turn([], "failed", "failed")],
      threadRuntimeStatus: { type: "active", activeFlags: [] },
    };
    expect(rows([action("spawnAgent", "errored")], active)[0]?.status).toBe("active");
    expect(rows([action("closeAgent")], active)).toEqual([]);
    expect(rows([], { turns: [], threadRuntimeStatus: { type: "systemError" } })).toEqual([]);
    expect(
      rows([], {
        turns: [turn([], "failed", "interrupted")],
        threadRuntimeStatus: { type: "idle" },
      }),
    ).toEqual([]);
  });
  test("activity resets close and spawn model; completed and interacted preserve completion", () => {
    const result = rows([action("closeAgent"), activity("active")])[0];
    expect(result).toMatchObject({ status: "active", spawnModel: null });
    expect(rows([activity("completed"), activity("updated", true)])[0]?.status).toBe("done");
    expect(rows([activity("interrupted")])[0]?.status).toBe("done");
  });
  test("send and wait preserve close, resume explicitly reopens it", () => {
    expect(rows([action("closeAgent"), action("sendInput")])).toEqual([]);
    expect(rows([action("closeAgent"), action("wait")])).toEqual([]);
    expect(rows([action("closeAgent"), action("resumeAgent")])).toHaveLength(1);
  });
  test("messages alone create no membership, lifecycle activity does", () => {
    expect(rows([activity("updated", true)], undefined, { childMemberships: [] })).toEqual([]);
    expect(rows([activity("completed")], undefined, { childMemberships: [] })[0]?.displayName).toBe(
      "Scout",
    );
  });
  test("modern activity makes source-only descendants inline and nested grants use immediate parent history", () => {
    const result = rows([activity("active")], undefined, {
      childMemberships: [
        {
          threadId: "nested",
          parentThreadId: "child",
          role: "backgroundChild",
          displayName: "Nested",
        },
      ],
      knownConversationsById: {
        child: {
          turns: [
            turn([
              item({
                type: "collabAgentToolCall",
                tool: "spawnAgent",
                status: "completed",
                receiverThreadIds: ["nested"],
                receiverThreads: [],
                agentsStates: {},
              }),
            ]),
          ],
        },
      },
    });
    expect(result.find((x) => x.conversationId === "nested")).toMatchObject({
      canInteract: true,
      showInlineActivity: true,
    });
  });
  test("blank and raw-id metadata never become display names", () => {
    const result = rows([], undefined, {
      childMemberships: [
        {
          threadId: "child",
          parentThreadId: "root",
          role: "backgroundChild",
          displayName: "child",
        },
      ],
    });
    expect(result[0]?.displayName).toBe("");
  });
  test("assistant start time drives completion clock, latest turn and recency still affect sorting", () => {
    const assistant = {
      ...item(null),
      role: "assistant" as const,
      kind: "assistantMessage" as const,
      markdownText: "Done",
      updatedAt: 999,
      rawItem: { phase: "final_answer" },
    };
    const child = {
      turns: [
        { ...turn([assistant], "child-turn"), turnStartedAtMs: 20, finalAssistantStartedAtMs: 30 },
      ],
      updatedAt: 50,
    };
    expect(rows([], child)[0]).toMatchObject({
      lastAssistantMessageAtMs: 30,
      recencyAtMs: 50,
      startedAtMs: 20,
    });
  });
  test("parent event order precedes source-only memberships despite different recency", () => {
    const result = rows([activity("active")], undefined, {
      childMemberships: [
        {
          threadId: "source",
          parentThreadId: "root",
          displayName: "Source",
          role: "backgroundChild",
          updatedAtMs: 900,
        },
        {
          threadId: "child",
          parentThreadId: "root",
          displayName: "Scout",
          role: "backgroundChild",
          updatedAtMs: 1,
        },
      ],
    });
    expect(result.map((row) => row.conversationId)).toEqual(["child", "source"]);
  });
  test("nested source membership uses its ancestor reference at the child creation time", () => {
    const result = rows([], undefined, {
      parentTurns: [
        turn([activity("active")], "first"),
        { ...turn([activity("active")], "second"), turnStartedAtMs: 100 },
      ],
      childMemberships: [
        { threadId: "nested", parentThreadId: "child", role: "backgroundChild", createdAtMs: 50 },
      ],
    });
    expect(result.find((row) => row.conversationId === "nested")?.parentTurnKey).toBe("first");
  });
  test("a message updates a known legacy reference without making its membership inline", () => {
    expect(rows([action("spawnAgent"), activity("updated", true)])[0]?.showInlineActivity).toBe(
      false,
    );
  });
  test("source-only nested grants override incidental root wait references", () => {
    const result = rows([], undefined, {
      parentTurns: [
        turn([activity("active")], "first"),
        {
          ...turn(
            [
              item({
                type: "collabAgentToolCall",
                tool: "wait",
                status: "completed",
                receiverThreadIds: ["nested"],
                receiverThreads: [],
                agentsStates: {},
              }),
            ],
            "later",
          ),
          turnStartedAtMs: 100,
        },
      ],
      childMemberships: [
        { threadId: "nested", parentThreadId: "child", role: "backgroundChild", createdAtMs: 50 },
      ],
      knownConversationsById: {
        child: {
          turns: [
            turn(
              [
                item({
                  type: "collabAgentToolCall",
                  tool: "spawnAgent",
                  status: "completed",
                  receiverThreadIds: ["nested"],
                  receiverThreads: [],
                  agentsStates: {},
                }),
              ],
              "child-turn",
            ),
          ],
        },
      },
    });
    expect(result.find((row) => row.conversationId === "nested")).toMatchObject({
      parentTurnKey: "first",
      canInteract: true,
      showInlineActivity: true,
    });
  });
  test("current summary wins stale unresumed or unloaded resident runtime", () => {
    const override = {
      childMemberships: [
        {
          threadId: "child",
          parentThreadId: "root",
          role: "backgroundChild" as const,
          displayName: "Scout",
          statusType: "active" as const,
        },
      ],
    };
    expect(
      rows(
        [],
        { turns: [], resumeState: "needs_resume", threadRuntimeStatus: { type: "idle" } },
        override,
      )[0]?.status,
    ).toBe("active");
    expect(
      rows(
        [],
        { turns: [], resumeState: "resumed", threadRuntimeStatus: { type: "notLoaded" } },
        override,
      )[0]?.status,
    ).toBe("active");
    expect(
      rows(
        [],
        { turns: [], resumeState: "resumed", threadRuntimeStatus: { type: "idle" } },
        override,
      )[0]?.status,
    ).toBe("done");
  });

  test("specific assistant start time wins the shared final-answer timestamp", () => {
    const assistant = {
      ...item(null),
      role: "assistant" as const,
      kind: "assistantMessage" as const,
      markdownText: "Done",
      rawItem: { phase: "final_answer" },
    };
    expect(
      rows([], {
        turns: [
          {
            ...turn([assistant], "child-turn"),
            assistantMessageStartedAtMsById: { event: 30 },
            finalAssistantStartedAtMs: 20,
            turnStartedAtMs: 10,
          },
        ],
      })[0]?.lastAssistantMessageAtMs,
    ).toBe(30);
  });
});
