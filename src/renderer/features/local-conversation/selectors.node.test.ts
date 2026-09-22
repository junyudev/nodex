import { describe, expect, test } from "vite-plus/test";
import type {
  CodexConversationItem,
  CodexCanonicalServerRequest,
  CodexConversationSnapshot,
  CodexConversationTurn,
} from "../../lib/types";
import {
  selectConversationTurnRequestsByTurnId,
  selectPrimaryBackgroundConversationRequest,
  selectPrimaryConversationRequest,
} from "./conversation-request-helpers";
import {
  selectBlockedTurnIds,
  selectConversationLiveRequests,
  selectConversationSearchUnits,
  selectPlanImplementationRequest,
  selectVisibleConversationTurnEntries,
} from "./selectors";

function buildItem(overrides: Partial<CodexConversationItem>): CodexConversationItem {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    itemId: "item_1",
    type: "assistant_message",
    kind: "assistantMessage",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function buildTurn(overrides: Partial<CodexConversationTurn>): CodexConversationTurn {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    status: "completed",
    itemIds: [],
    items: [],
    ...overrides,
  };
}

function buildConversation(
  overrides?: Partial<CodexConversationSnapshot>,
): CodexConversationSnapshot {
  return {
    threadId: "thread_1",
    projectId: "project_1",
    source: overrides?.source ?? null,
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
    resumeState: "resumed",
    turns: [],
    requests: [],
    queuedFollowUps: {
      status: "ready",
      ledgerRevision: 0,
      projectionRevision: 0,
      entries: [],
      inFlightFollowUpId: null,
      editingFollowUpId: null,
      error: null,
    },
    pendingSteers: [],
    backgroundTerminalRows: [],
    capabilityFlags: {
      canEditLastUserTurn: true,
      canForkFromTurn: true,
      canSearch: true,
      canCollapseTurns: true,
    },
    ...overrides,
  };
}

describe("local-conversation selectors", () => {
  test("derives implement-plan requests from the live planImplementation item", () => {
    const conversation = buildConversation({
      requests: [
        {
          type: "implementPlan",
          requestId: "implement-plan:turn_1",
          projectId: "project_1",
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "implement-plan:turn_1",
          planContent: "- step 1\n- step 2",
          createdAt: 10,
        },
      ],
      turns: [
        buildTurn({
          turnId: "turn_1",
          items: [
            buildItem({
              itemId: "implement-plan:turn_1",
              type: "planImplementation",
              kind: "planImplementation",
              semanticKind: "planImplementation",
              markdownText: "- step 1\n- step 2",
              updatedAt: 10,
              status: "inProgress",
            }),
          ],
        }),
      ],
    });

    const request = selectPlanImplementationRequest(conversation);
    expect(request?.type).toBe("implementPlan");
    expect(request?.turnId).toBe("turn_1");
    expect(request?.planContent).toBe("- step 1\n- step 2");
  });

  test("synthesizes an implement-plan request even when the raw request-plane entry is missing", () => {
    const conversation = buildConversation({
      turns: [
        buildTurn({
          turnId: "turn_1",
          items: [
            buildItem({
              itemId: "implement-plan:turn_1",
              type: "planImplementation",
              kind: "planImplementation",
              semanticKind: "planImplementation",
              markdownText: "- step 1\n- step 2",
              updatedAt: 10,
              status: "inProgress",
            }),
          ],
        }),
      ],
    });

    const request = selectPlanImplementationRequest(conversation);
    expect(request?.type).toBe("implementPlan");
    expect(request?.requestId).toBe("implement-plan:turn_1");
    expect(request?.planContent).toBe("- step 1\n- step 2");
  });

  test("does not surface an implement-plan request once the backing item is completed", () => {
    const conversation = buildConversation({
      requests: [
        {
          type: "implementPlan",
          requestId: "implement-plan:turn_1",
          projectId: "project_1",
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "implement-plan:turn_1",
          planContent: "- step 1\n- step 2",
          createdAt: 10,
        },
      ],
      turns: [
        buildTurn({
          turnId: "turn_1",
          items: [
            buildItem({
              itemId: "implement-plan:turn_1",
              type: "planImplementation",
              kind: "planImplementation",
              semanticKind: "planImplementation",
              markdownText: "- step 1\n- step 2",
              updatedAt: 10,
              status: "completed",
            }),
          ],
        }),
      ],
    });

    expect(selectPlanImplementationRequest(conversation)).toBe(null);
  });

  test("marks approval and elicitation turns as blocked", () => {
    const conversation = buildConversation({
      turns: [buildTurn({ turnId: "turn_1" }), buildTurn({ turnId: "turn_2" })],
      requests: [
        {
          type: "approval",
          requestId: "approval_1",
          kind: "command",
          projectId: "project_1",
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "item_1",
          createdAt: 2,
        },
        {
          type: "mcpServerElicitation",
          requestId: "elicitation_1",
          projectId: "project_1",
          threadId: "thread_1",
          turnId: "turn_2",
          itemId: "item_2",
          kind: "generic",
          mode: "form",
          serverName: "Context7",
          message: "Need more input",
          createdAt: 3,
        },
      ],
    });

    expect(selectBlockedTurnIds(conversation).join(",")).toBe("turn_2,turn_1");
    expect(selectConversationLiveRequests(conversation).length).toBe(2);
  });

  test("blocks turns only for user-input requests that require an indefinite response", () => {
    const conversation = buildConversation({
      turns: [buildTurn({ turnId: "turn_1" }), buildTurn({ turnId: "turn_2" })],
      requests: [
        {
          type: "userInput",
          requestId: "nonblocking_input",
          projectId: "project_1",
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "item_1",
          questions: [],
          isBlocking: false,
          createdAt: 1,
        },
        {
          type: "userInput",
          requestId: "blocking_input",
          projectId: "project_1",
          threadId: "thread_1",
          turnId: "turn_2",
          itemId: "item_2",
          questions: [],
          isBlocking: true,
          createdAt: 2,
        },
      ],
    });

    expect(selectBlockedTurnIds(conversation)).toEqual(["turn_2"]);
    expect(selectConversationLiveRequests(conversation)).toHaveLength(2);
  });

  test("prioritizes request-user-input ahead of approval in the live request order", () => {
    const conversation = buildConversation({
      turns: [buildTurn({ turnId: "turn_1" }), buildTurn({ turnId: "turn_2" })],
      requests: [
        {
          type: "approval",
          requestId: "approval_1",
          kind: "command",
          projectId: "project_1",
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "item_1",
          createdAt: 1,
        },
        {
          type: "userInput",
          requestId: "user_input_1",
          projectId: "project_1",
          threadId: "thread_1",
          turnId: "turn_2",
          itemId: "item_2",
          createdAt: 2,
          questions: [],
          isBlocking: true,
        },
      ],
    });

    const liveRequests = selectConversationLiveRequests(conversation);
    expect(liveRequests[0]?.type).toBe("userInput");
    expect(liveRequests[1]?.type).toBe("approval");
  });

  test("filters resumed child turns that already exist in the parent thread", () => {
    const duplicateTurn = buildTurn({
      turnId: "turn_shared",
      items: [
        buildItem({
          turnId: "turn_shared",
          itemId: "shared_item",
          markdownText: "Shared turn",
        }),
      ],
    });
    const uniqueTurn = buildTurn({
      turnId: "turn_child_unique",
      items: [
        buildItem({
          turnId: "turn_child_unique",
          itemId: "unique_item",
          markdownText: "Unique turn",
        }),
      ],
    });
    const conversation = buildConversation({
      threadId: "thread_child",
      resumeState: "resumed",
      turns: [duplicateTurn, uniqueTurn],
    });
    const parentTurns = [
      buildTurn({
        threadId: "thread_parent",
        turnId: "turn_shared",
        items: [
          buildItem({
            threadId: "thread_parent",
            turnId: "turn_shared",
            itemId: "parent_shared",
            markdownText: "Parent shared",
          }),
        ],
      }),
      buildTurn({
        threadId: "thread_parent",
        turnId: "turn_parent_only",
        items: [
          buildItem({
            threadId: "thread_parent",
            turnId: "turn_parent_only",
            itemId: "parent_only",
            markdownText: "Parent only",
          }),
        ],
      }),
    ];

    const entries = selectVisibleConversationTurnEntries({
      conversation,
      parentTurns,
    });

    expect(entries.length).toBe(1);
    expect(entries[0]?.turnId).toBe("turn_child_unique");
  });

  test("uses exact occurrence keys for distinct nullable local turns", () => {
    const conversation = buildConversation({
      turns: [
        buildTurn({
          turnId: null,
          items: [buildItem({ turnId: null, itemId: "goal", markdownText: "Goal" })],
        }),
        buildTurn({
          turnId: null,
          items: [buildItem({ turnId: null, itemId: "worktree", markdownText: "Worktree" })],
        }),
      ],
    });

    const entries = selectVisibleConversationTurnEntries({ conversation });

    expect(entries.map((entry) => entry.turnKey)).toStrictEqual(["turn-index-0", "turn-index-1"]);
    expect(entries.map((entry) => entry.isMostRecentTurn)).toStrictEqual([false, true]);
  });

  test("hides startup tool prewarm turns", () => {
    const conversation = buildConversation({
      turns: [
        buildTurn({
          items: [
            buildItem({
              semanticKind: "userMessage",
              rawItem: {
                id: "prewarm",
                type: "userMessage",
                content: [{ type: "text", text: "<startup_tool_prewarm>browser" }],
              },
            }),
          ],
        }),
      ],
    });

    expect(selectVisibleConversationTurnEntries({ conversation })).toStrictEqual([]);
  });

  test("keeps visible turn entry references stable across unrelated conversation updates", () => {
    const turn = buildTurn({ turnId: "turn_1" });
    const requests = [
      {
        type: "approval" as const,
        requestId: "approval_1",
        kind: "command" as const,
        projectId: "project_1",
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "item_1",
        createdAt: 1,
      },
    ];
    const conversationA = buildConversation({
      turns: [turn],
      requests,
      cwd: "/tmp/project-a",
    });
    const conversationB = {
      ...conversationA,
      cwd: "/tmp/project-b",
    };

    const parentTurns: CodexConversationTurn[] = [];
    const entriesA = selectVisibleConversationTurnEntries({
      conversation: conversationA,
      parentTurns,
    });
    const entriesB = selectVisibleConversationTurnEntries({
      conversation: conversationB,
      parentTurns,
    });

    expect(entriesA === entriesB).toBe(true);
    expect(entriesA[0] === entriesB[0]).toBe(true);
  });

  test("refreshes a visible turn when assistant start timing arrives independently", () => {
    const item = buildItem({ itemId: "assistant", markdownText: "Reply" });
    const turn = buildTurn({ items: [item], itemIds: [item.itemId] });
    const conversation = buildConversation({ turns: [turn] });
    const before = selectVisibleConversationTurnEntries({ conversation });

    turn.assistantMessageStartedAtMsById = { assistant: 1 };
    const after = selectVisibleConversationTurnEntries({ conversation });

    expect(after).not.toBe(before);
    expect(after[0]?.turn.assistantMessageStartedAtMsById).toEqual({ assistant: 1 });
    expect(before[0]?.turn.assistantMessageStartedAtMsById).toBeUndefined();
    expect(selectVisibleConversationTurnEntries({ conversation })).toBe(after);
  });

  test("publishes a fresh immutable turn snapshot when an identity-stable item advances", () => {
    const item = buildItem({ markdownText: "Initial reasoning" });
    const turn = buildTurn({
      itemIds: [item.itemId],
      items: [item],
      status: "inProgress",
    });
    const conversation = buildConversation({ turns: [turn] });

    const initialEntries = selectVisibleConversationTurnEntries({ conversation });
    const initialEntry = initialEntries[0];
    if (!initialEntry) throw new Error("expected initial visible turn");

    item.markdownText = "Updated reasoning";
    item.updatedAt = 2;

    const updatedEntries = selectVisibleConversationTurnEntries({ conversation });
    const updatedEntry = updatedEntries[0];
    if (!updatedEntry) throw new Error("expected updated visible turn");

    expect(updatedEntries).not.toBe(initialEntries);
    expect(updatedEntry).not.toBe(initialEntry);
    expect(updatedEntry.turn).not.toBe(initialEntry.turn);
    expect(updatedEntry.turn.items[0]).toBe(initialEntry.turn.items[0]);
    expect(updatedEntry.turn.items[0]).toBe(item);
    expect(updatedEntry.renderRevision).not.toBe(initialEntry.renderRevision);
  });

  test("prefers the newest turn when selecting the primary live request", () => {
    const conversation = buildConversation({
      turns: [buildTurn({ turnId: "turn_1" }), buildTurn({ turnId: "turn_2" })],
      requests: [
        {
          type: "userInput",
          requestId: "user_input_1",
          projectId: "project_1",
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "item_1",
          createdAt: 2,
          questions: [],
          isBlocking: true,
        },
        {
          type: "approval",
          requestId: "approval_2",
          kind: "command",
          projectId: "project_1",
          threadId: "thread_1",
          turnId: "turn_2",
          itemId: "item_2",
          createdAt: 1,
        },
      ],
    });

    expect(selectPrimaryConversationRequest(conversation)?.type).toBe("approval");
  });

  test("prefers a newer implement-plan request over older request surfaces", () => {
    const conversation = buildConversation({
      turns: [
        buildTurn({ turnId: "turn_1" }),
        buildTurn({
          turnId: "turn_2",
          items: [
            buildItem({
              turnId: "turn_2",
              itemId: "implement-plan:turn_2",
              type: "planImplementation",
              kind: "planImplementation",
              semanticKind: "planImplementation",
              markdownText: "- step 1",
              updatedAt: 10,
              status: "inProgress",
            }),
          ],
        }),
      ],
      requests: [
        {
          type: "userInput",
          requestId: "user_input_1",
          projectId: "project_1",
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "item_1",
          createdAt: 2,
          questions: [],
          isBlocking: true,
        },
      ],
    });

    const primaryRequest = selectPrimaryConversationRequest(conversation);
    expect(primaryRequest?.type).toBe("implementPlan");
    expect(primaryRequest?.turnId).toBe("turn_2");
  });

  test("reuses per-turn request arrays when the conversation inputs are unchanged", () => {
    const conversation = buildConversation({
      turns: [buildTurn({ turnId: "turn_1" }), buildTurn({ turnId: "turn_2" })],
      requests: [
        {
          type: "approval",
          requestId: "approval_1",
          kind: "command",
          projectId: "project_1",
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "item_1",
          createdAt: 1,
        },
      ],
    });

    const firstSelection = selectConversationTurnRequestsByTurnId(conversation);
    const secondSelection = selectConversationTurnRequestsByTurnId(conversation);

    expect(firstSelection === secondSelection).toBe(true);
    expect(firstSelection.get("turn_1") === secondSelection.get("turn_1")).toBe(true);
    expect((firstSelection.get("turn_2") ?? null) === (secondSelection.get("turn_2") ?? null)).toBe(
      true,
    );
  });

  test("invalidates request selection when turns reorder under the same requests array", () => {
    const sharedRequests = [
      {
        type: "userInput" as const,
        requestId: "user_input_1",
        projectId: "project_1",
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "item_1",
        createdAt: 2,
        questions: [],
        isBlocking: true,
      },
      {
        type: "approval" as const,
        requestId: "approval_2",
        kind: "command" as const,
        projectId: "project_1",
        threadId: "thread_1",
        turnId: "turn_2",
        itemId: "item_2",
        createdAt: 1,
      },
    ];
    const firstConversation = buildConversation({
      turns: [buildTurn({ turnId: "turn_1" }), buildTurn({ turnId: "turn_2" })],
      requests: sharedRequests,
    });
    const secondConversation = buildConversation({
      turns: [buildTurn({ turnId: "turn_2" }), buildTurn({ turnId: "turn_1" })],
      requests: sharedRequests,
    });

    const firstPrimary = selectPrimaryConversationRequest(firstConversation);
    const secondPrimary = selectPrimaryConversationRequest(secondConversation);
    const firstLiveRequests = selectConversationLiveRequests(firstConversation);
    const secondLiveRequests = selectConversationLiveRequests(secondConversation);

    expect(firstPrimary?.type).toBe("approval");
    expect(secondPrimary?.type).toBe("userInput");
    expect(firstLiveRequests[0]?.type).toBe("approval");
    expect(secondLiveRequests[0]?.type).toBe("userInput");
    expect(firstLiveRequests === secondLiveRequests).toBe(false);
  });

  test("invalidates cached selection when only the canonical request plane changes", () => {
    const turns = [buildTurn({ turnId: "turn_1", status: "inProgress" })];
    const requests: CodexConversationSnapshot["requests"] = [];
    const optionRequest: CodexCanonicalServerRequest = {
      id: "option-1",
      method: "item/tool/requestOptionPicker",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        question: "Choose a slice",
        options: [{ label: "UI" }],
      },
    };
    const setupRequest: CodexCanonicalServerRequest = {
      id: "setup-1",
      method: "item/tool/call",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        callId: "setup-call-1",
        namespace: "codex_app",
        tool: "setup_codex_step",
        arguments: { step: "task" },
      },
    };

    const first = buildConversation({ turns, requests, canonicalRequests: [optionRequest] });
    const second = buildConversation({ turns, requests, canonicalRequests: [setupRequest] });

    expect(selectPrimaryConversationRequest(first)?.type).toBe("optionPicker");
    expect(selectPrimaryConversationRequest(second)?.type).toBe("setupCodexStep");
    expect(selectConversationLiveRequests(first) === selectConversationLiveRequests(second)).toBe(
      false,
    );
  });

  test("recomputes request scope when unchanged request arrays move to a different context", () => {
    const context = {
      projectId: "project_1",
      threadId: "thread_1",
      turns: [buildTurn({ turnId: "turn_1", status: "inProgress" })],
      requests: [],
      canonicalRequests: [
        {
          id: "option-1",
          method: "item/tool/requestOptionPicker",
          params: {
            threadId: "thread_1",
            turnId: "turn_1",
            question: "Choose a slice",
            options: [{ label: "UI" }],
          },
        } satisfies CodexCanonicalServerRequest,
      ],
    };
    expect(selectPrimaryConversationRequest(context)).toMatchObject({
      projectId: "project_1",
      threadId: "thread_1",
    });
    expect(selectPrimaryConversationRequest({ ...context, projectId: "project_2" })).toMatchObject({
      projectId: "project_2",
      threadId: "thread_1",
    });
    expect(selectPrimaryConversationRequest({ ...context, threadId: "thread_2" })).toMatchObject({
      projectId: "project_1",
      threadId: "thread_2",
    });
  });

  test("does not duplicate a direct user-input request across canonical and legacy projections", () => {
    const conversation = buildConversation({
      turns: [buildTurn({ turnId: "turn_1", status: "inProgress" })],
      requests: [
        {
          type: "userInput",
          requestId: "input-1",
          projectId: "project_1",
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "input-item-1",
          questions: [],
          isBlocking: true,
          createdAt: 1,
        },
      ],
      canonicalRequests: [
        {
          id: "input-1",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread_1",
            turnId: "turn_1",
            itemId: "input-item-1",
            questions: [],
            isBlocking: true,
            autoResolutionMs: null,
          },
        },
      ],
    });

    const liveRequests = selectConversationLiveRequests(conversation);
    expect(liveRequests.length).toBe(1);
    expect(liveRequests[0]?.requestId).toBe("input-1");
  });

  test("keeps background approval visible when a child private request is primary", () => {
    const conversation = buildConversation({
      turns: [buildTurn({ turnId: "turn_1", status: "inProgress" })],
      requests: [
        {
          type: "permissionRequest",
          requestId: "permission-1",
          projectId: "project_1",
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "permission-item-1",
          reason: "Allow access",
          cwd: "/tmp/project",
          permissions: { network: null, fileSystem: null },
          completed: false,
          response: null,
          createdAt: 1,
        },
      ],
      canonicalRequests: [
        {
          id: "option-1",
          method: "item/tool/requestOptionPicker",
          params: {
            threadId: "thread_1",
            turnId: "turn_1",
            question: "Choose a slice",
            options: [{ label: "UI" }],
          },
        },
      ],
    });

    expect(selectPrimaryConversationRequest(conversation)?.type).toBe("optionPicker");
    expect(selectPrimaryBackgroundConversationRequest(conversation)?.type).toBe(
      "permissionRequest",
    );
    expect(JSON.stringify(selectBlockedTurnIds(conversation))).toBe(JSON.stringify(["turn_1"]));
  });

  test("projects Nodex authorization as the blocking background request for its turn", () => {
    const conversation = buildConversation({
      turns: [buildTurn({ turnId: "turn_1", status: "inProgress" })],
      requests: [
        {
          type: "nodexAgentAuthorization",
          requestId: "nodex-auth-1",
          projectId: "project_1",
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "call-1",
          tool: "edit_document",
          effect: "write",
          preview: {
            title: "Append rollout plan",
            summary: "Append four Blocks.",
            details: [],
          },
          createdAt: 1,
        },
      ],
    });

    expect(selectPrimaryBackgroundConversationRequest(conversation)?.type).toBe(
      "nodexAgentAuthorization",
    );
    expect(selectConversationLiveRequests(conversation)[0]?.type).toBe("nodexAgentAuthorization");
    expect(selectBlockedTurnIds(conversation)).toEqual(["turn_1"]);
  });

  test("uses the unfinished synthetic user-input item before approval when raw input is gone", () => {
    const conversation = buildConversation({
      turns: [
        buildTurn({
          turnId: "turn_1",
          status: "inProgress",
          items: [
            buildItem({
              itemId: "synthetic-input",
              type: "request_user_input",
              kind: "userInputResponse",
              semanticKind: "userInputResponse",
              status: "inProgress",
              requestId: 41,
              userInputQuestions: [
                {
                  id: "scope",
                  header: "Scope",
                  question: "Which scope?",
                  isOther: true,
                  options: [{ label: "UI", description: "Renderer" }],
                },
              ],
            }),
          ],
        }),
      ],
      requests: [
        {
          type: "approval",
          requestId: "approval-1",
          kind: "command",
          projectId: "project_1",
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "command-1",
          createdAt: 2,
        },
      ],
    });

    const primary = selectPrimaryConversationRequest(conversation);
    expect(primary?.type).toBe("userInput");
    expect(primary?.requestId).toBe(41);
    if (primary?.type === "userInput") {
      expect(primary.questions[0]?.isOther).toBe(false);
    }
  });

  test("falls back to the newest turnless MCP elicitation after scanning materialized turns", () => {
    const conversation = buildConversation({
      turns: [buildTurn({ turnId: "turn_1", status: "inProgress" })],
      requests: [
        {
          type: "mcpServerElicitation",
          requestId: "turnless-elicitation",
          projectId: "project_1",
          threadId: "thread_1",
          turnId: "",
          itemId: "turnless-elicitation-item",
          kind: "generic",
          mode: "form",
          serverName: "Context7",
          message: "Need workspace context",
          createdAt: 5,
        },
      ],
    });

    expect(selectPrimaryConversationRequest(conversation)?.requestId).toBe("turnless-elicitation");
  });

  test("uses raw request order and skips invalid file approvals before permission fallback", () => {
    const permission = {
      type: "permissionRequest" as const,
      requestId: "permission-1",
      projectId: "project_1",
      threadId: "thread_1",
      turnId: "turn_1",
      itemId: "permission-item",
      cwd: "/tmp/project",
      reason: "Need network",
      permissions: { network: null, fileSystem: null },
      response: null,
      completed: false,
      createdAt: 50,
    };
    const invalidNewestFileApproval = {
      type: "approval" as const,
      requestId: "missing-file-approval",
      kind: "file" as const,
      projectId: "project_1",
      threadId: "thread_1",
      turnId: "turn_1",
      itemId: "missing-file-item",
      createdAt: 100,
    };
    const newerByArrayOrder = {
      type: "approval" as const,
      requestId: "newer-command",
      kind: "command" as const,
      projectId: "project_1",
      threadId: "thread_1",
      turnId: "turn_1",
      itemId: "newer-command-item",
      createdAt: 1,
    };
    const olderByArrayOrder = {
      ...newerByArrayOrder,
      requestId: "older-command",
      itemId: "older-command-item",
      createdAt: 200,
    };
    const turn = buildTurn({ turnId: "turn_1", status: "inProgress" });

    const approvalConversation = buildConversation({
      turns: [turn],
      requests: [olderByArrayOrder, permission, newerByArrayOrder, invalidNewestFileApproval],
    });
    const permissionConversation = buildConversation({
      turns: [turn],
      requests: [permission, invalidNewestFileApproval],
    });

    expect(selectPrimaryBackgroundConversationRequest(approvalConversation)?.requestId).toBe(
      "newer-command",
    );
    expect(selectPrimaryBackgroundConversationRequest(permissionConversation)?.requestId).toBe(
      "permission-1",
    );
  });

  test("builds searchable user and assistant units from visible turns", () => {
    const conversation = buildConversation({
      turns: [
        buildTurn({
          items: [
            buildItem({
              itemId: "user_1",
              type: "user_message",
              kind: "userMessage",
              role: "user",
              markdownText: "Need a refactor.",
            }),
            buildItem({
              itemId: "assistant_1",
              type: "assistant_message",
              kind: "assistantMessage",
              role: "assistant",
              markdownText: "I will rewrite the shell.",
            }),
          ],
        }),
      ],
    });

    const units = selectConversationSearchUnits(conversation);
    expect(units.length).toBe(2);
    expect(units[0]?.key).toBe("turn_1:user_1");
    expect(units[1]?.role).toBe("assistant");
  });

  test("keeps search identity distinct across nullable local turn occurrences", () => {
    const conversation = buildConversation({
      turns: [
        buildTurn({
          turnId: null,
          items: [
            buildItem({
              turnId: null,
              itemId: "local_user",
              type: "user_message",
              kind: "userMessage",
              role: "user",
              markdownText: "First local turn",
            }),
          ],
        }),
        buildTurn({
          turnId: null,
          items: [
            buildItem({
              turnId: null,
              itemId: "local_user",
              type: "user_message",
              kind: "userMessage",
              role: "user",
              markdownText: "Second local turn",
            }),
          ],
        }),
      ],
    });

    const units = selectConversationSearchUnits(conversation);
    expect(units.map((unit) => unit.turnKey)).toEqual(["turn-index-0", "turn-index-1"]);
    expect(units.map((unit) => unit.key)).toEqual([
      "turn-index-0:local_user",
      "turn-index-1:local_user",
    ]);
  });

  test("keeps a drafting turn visible when only turn.diff has streamed", () => {
    const entries = selectVisibleConversationTurnEntries({
      conversation: buildConversation({
        turns: [
          buildTurn({
            status: "inProgress",
            items: [],
            itemIds: [],
            diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n",
          }),
        ],
      }),
    });

    expect(entries.length).toBe(1);
    expect(entries[0]?.turnId ?? "").toBe("turn_1");
  });
});

describe("inherited child history", () => {
  test.each(["resumed", "needs_resume"] as const)(
    "strips inherited IDs and content before %s",
    (resumeState) => {
      const parent = buildTurn({
        turnId: "parent",
        items: [
          buildItem({ rawItem: { id: "parent-item", type: "agentMessage", text: "Inherited" } }),
        ],
      });
      const child = buildTurn({
        turnId: "child",
        items: [
          buildItem({ rawItem: { id: "child-item", type: "agentMessage", text: "Inherited" } }),
        ],
      });
      const own = buildTurn({ turnId: "own", items: [buildItem({ markdownText: "Own work" })] });
      const entries = selectVisibleConversationTurnEntries({
        conversation: buildConversation({ resumeState, turns: [parent, child, own] }),
        parentTurns: [parent],
      });
      expect(entries.map((entry) => entry.turnId)).toEqual(["own"]);
    },
  );
  test("keeps a child continuation longer than its parent prefix", () => {
    const item = buildItem({ markdownText: "Inherited" });
    const parent = buildTurn({ turnId: "parent", items: [item] });
    const child = buildTurn({
      turnId: null,
      items: [item, buildItem({ markdownText: "New work" })],
    });
    expect(
      selectVisibleConversationTurnEntries({
        conversation: buildConversation({ turns: [child] }),
        parentTurns: [parent],
      }),
    ).toHaveLength(1);
  });
});
