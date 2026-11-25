import { describe, expect, test, it } from "vite-plus/test";
import {
  buildBackgroundSubagentRows,
  type BuildBackgroundSubagentRowsInput,
  type SubagentConversation,
} from "./codex-subagent-row-model";
import type {
  CodexConversationItem,
  CodexConversationTurn,
  CodexSubagentActivityView,
  CodexTurnSummary,
} from "./types";
import { mergeCodexTurnSummaries, mergeCodexTurnSummary } from "./codex-thread-detail-reducer";
import { resolveCodexThreadHandoffStepLabel } from "./codex-thread-handoff";
import { parseCodexThreadImportReference } from "./codex-thread-import-reference";

describe("codex subagent row model", () => {
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
        {
          threadId: "child",
          parentThreadId: "root",
          role: "backgroundChild",
          displayName: "Scout",
        },
      ],
      knownConversationsById: child ? { child } : {},
      discoveryComplete: false,
      ...overrides,
    });
  }

  describe("shared subagent row contract", () => {
    test("keeps child identity separate from task observation keys", () => {
      expect(rows([activity("active")])[0]).toMatchObject({
        conversationId: "child",
        identityThreadId: "child",
      });
      const observed = rows([], undefined, {
        childMemberships: [
          {
            threadId: "observation-key",
            parentThreadId: "root",
            role: "backgroundChild",
            displayName: "Review",
            task: {
              id: "native-task",
              bornTurnSequence: null,
              description: "Review",
              status: "running",
            },
          },
        ],
      });
      expect(observed[0]).toMatchObject({
        conversationId: "observation-key",
        identityThreadId: null,
        canInteract: false,
      });
    });

    test("available child metadata remains interactive without spawn history or after a later parent Turn", () => {
      const child: SubagentConversation = {
        turns: [],
        threadRuntimeStatus: { type: "active", activeFlags: [] },
        archived: false,
      };
      expect(rows([], child)[0]?.canInteract).toBe(true);
      expect(
        rows([], child, {
          parentTurns: [turn([], "completed-parent"), turn([activity("active")], "later-parent")],
        })[0]?.canInteract,
      ).toBe(true);
      expect(rows([], { ...child, archived: true })).toEqual([]);
      expect(
        rows([], child, {
          childMemberships: [
            {
              threadId: "child",
              parentThreadId: "root",
              role: "backgroundChild",
              task: {
                id: "native-task",
                bornTurnSequence: null,
                description: "Native task",
                status: "running",
              },
            },
          ],
        })[0]?.canInteract,
      ).toBe(false);
    });

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
      expect(
        rows([activity("completed")], undefined, { childMemberships: [] })[0]?.displayName,
      ).toBe("Scout");
    });
    test("modern activity locates inline descendants while their own metadata supplies availability", () => {
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
          nested: { threadId: "nested", turns: [], archived: false },
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
          {
            ...turn([assistant], "child-turn"),
            turnStartedAtMs: 20,
            finalAssistantStartedAtMs: 30,
          },
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
          nested: { threadId: "nested", turns: [], archived: false },
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
});

describe("codex thread detail reducer", () => {
  function buildTurn(overrides: Partial<CodexTurnSummary> = {}): CodexTurnSummary {
    return {
      threadId: "thread_1",
      turnId: "turn_1",
      status: "inProgress",
      itemIds: [],
      ...overrides,
    };
  }

  describe("codex thread detail reducer", () => {
    test("preserves first work item timing across turn summary merges", () => {
      const existing = buildTurn({
        firstTurnWorkItemStartedAtMs: 123,
        itemIds: ["exec_1"],
      });
      const incoming = buildTurn({
        status: "completed",
        itemIds: ["assistant_1"],
      });

      const merged = mergeCodexTurnSummary(existing, incoming);

      expect(merged.firstTurnWorkItemStartedAtMs ?? 0).toBe(123);
      expect(merged.itemIds.join(",")).toBe("exec_1,assistant_1");
    });

    test("keeps cached first work item timing when refreshing turn lists", () => {
      const merged = mergeCodexTurnSummaries(
        [buildTurn({ status: "completed", itemIds: ["assistant_1"] })],
        [buildTurn({ firstTurnWorkItemStartedAtMs: 456, itemIds: ["exec_1"] })],
      );

      expect(merged.length).toBe(1);
      expect(merged[0]?.firstTurnWorkItemStartedAtMs ?? 0).toBe(456);
      expect(merged[0]?.itemIds.join(",") ?? "").toBe("exec_1,assistant_1");
    });

    test("keeps the whole observed command-start map over hydrated timing refreshes", () => {
      const merged = mergeCodexTurnSummary(
        buildTurn({
          commandExecutionStartedAtMsById: {
            observed: 100,
          },
        }),
        buildTurn({
          commandExecutionStartedAtMsById: {
            observed: 200,
            hydratedOnly: 300,
          },
        }),
      );

      expect(merged.commandExecutionStartedAtMsById?.observed).toBe(100);
      expect(merged.commandExecutionStartedAtMsById?.hydratedOnly).toBe(undefined);
    });
  });

  test("preserves observed assistant starts while merging additional message starts", () => {
    const existing = buildTurn({
      assistantMessageStartedAtMsById: { commentary: 100, answer: 300 },
    });
    const merged = mergeCodexTurnSummary(
      existing,
      buildTurn({ assistantMessageStartedAtMsById: { answer: 900, followup: 500 } }),
    );
    expect(merged.assistantMessageStartedAtMsById).toEqual({
      commentary: 100,
      answer: 300,
      followup: 500,
    });
    expect(
      mergeCodexTurnSummary(merged, buildTurn({ status: "completed" }))
        .assistantMessageStartedAtMsById,
    ).toEqual(merged.assistantMessageStartedAtMsById);
  });

  test("a new response with unknown timing clears the previous response's summary anchors", () => {
    const existing = buildTurn({
      finalAssistantStartedAtMs: 8000,
      assistantResponseWorkDurationMs: 7000,
    });
    expect(mergeCodexTurnSummary(existing, buildTurn())).toMatchObject({
      finalAssistantStartedAtMs: 8000,
      assistantResponseWorkDurationMs: 7000,
    });
    expect(
      mergeCodexTurnSummary(
        existing,
        buildTurn({
          finalAssistantStartedAtMs: null,
          assistantResponseWorkDurationMs: null,
        }),
      ),
    ).toMatchObject({ finalAssistantStartedAtMs: null, assistantResponseWorkDurationMs: null });
  });
});

describe("codex thread handoff", () => {
  const context = {
    direction: "local-to-worktree" as const,
    localBranch: "LocalCase",
    sourceBranch: "SourceCase",
    worktreeBranch: "WorktreeCase",
  };

  describe("Handoff step presentation", () => {
    test("uses the destination's branch and falls back to the source branch", () => {
      expect(resolveCodexThreadHandoffStepLabel("checkout-local-branch", context)).toBe(
        "Checking out LocalCase locally",
      );
      expect(resolveCodexThreadHandoffStepLabel("checkout-worktree-branch", context)).toBe(
        "Checking out WorktreeCase in worktree",
      );
      expect(
        resolveCodexThreadHandoffStepLabel("checkout-worktree-branch", {
          ...context,
          worktreeBranch: null,
        }),
      ).toBe("Checking out SourceCase in worktree");
      expect(
        resolveCodexThreadHandoffStepLabel("checkout-local-branch", {
          ...context,
          localBranch: null,
        }),
      ).toBe("Checking out SourceCase locally");
    });

    test.each([
      ["local-to-worktree", "Moving chat to worktree"],
      ["worktree-to-local", "Moving chat to local"],
      ["cross-host", "Moving chat to the destination worktree"],
    ] as const)("describes the destination for %s", (direction, label) => {
      expect(
        resolveCodexThreadHandoffStepLabel("switching-thread", { ...context, direction }),
      ).toBe(label);
    });
  });
});

describe("codex thread import reference", () => {
  const THREAD_ID = "019abcde-1234-7000-8000-123456789abc";

  describe("Codex thread import references", () => {
    it.each([
      THREAD_ID,
      ` ${THREAD_ID.toUpperCase()}\n`,
      `codex://threads/${THREAD_ID}`,
      `codex://threads/${THREAD_ID.toUpperCase()}/`,
      `codex://threads/${THREAD_ID}?hostId=local`,
      `codex://threads/${THREAD_ID}?view=review#latest`,
    ])("resolves a local native conversation identity: %s", (reference) => {
      expect(parseCodexThreadImportReference(reference)).toBe(THREAD_ID);
    });

    it.each([
      "",
      "not-a-thread",
      "nodex:thread:root",
      `${THREAD_ID}/extra`,
      `https://example.com/threads/${THREAD_ID}`,
      `file:///threads/${THREAD_ID}`,
      `codex://chat/${THREAD_ID}`,
      `codex://threads/`,
      `codex://threads/${THREAD_ID}/extra`,
      `codex://threads/%30${THREAD_ID.slice(1)}`,
      `codex://user:secret@threads/${THREAD_ID}`,
      `codex://threads:9229/${THREAD_ID}`,
      `codex://threads/${THREAD_ID}?hostId=remote-ssh:work`,
      `codex://threads/${THREAD_ID}?hostId=`,
      `codex://threads/${THREAD_ID}?hostId=local&hostId=remote`,
    ])("rejects remote or malformed references: %s", (reference) => {
      expect(parseCodexThreadImportReference(reference)).toBeNull();
    });
  });
});
