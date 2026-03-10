import { describe, expect, test } from "bun:test";
import { codexStoreReducer, createInitialCodexStoreState } from "./codex-store";

describe("codex-store", () => {
  test("reduces thread summary and detail updates", () => {
    const initial = createInitialCodexStoreState();

    const withThread = codexStoreReducer(initial, {
      type: "event",
      event: {
        type: "threadSummary",
        thread: {
          threadId: "thr_1",
          projectId: "default",
          cardId: "card_1",
          threadName: "Thread 1",
          threadPreview: "Preview",
          modelProvider: "openai",
          cwd: "/tmp/project",
          statusType: "idle",
          statusActiveFlags: [],
          archived: false,
          createdAt: 1,
          updatedAt: 2,
          linkedAt: "2026-02-21T00:00:00.000Z",
        },
      },
    });

    expect(withThread.threadsByProject.default?.length).toBe(1);

    const withDetail = codexStoreReducer(withThread, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_1",
        projectId: "default",
        cardId: "card_1",
        threadName: "Thread 1",
        threadPreview: "Preview",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "idle",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 2,
        linkedAt: "2026-02-21T00:00:00.000Z",
        turns: [],
        items: [],
      },
    });

    expect(withDetail.threadDetailsById.thr_1?.threadId).toBe("thr_1");
  });

  test("preserves turn token usage when later turn events omit it", () => {
    const initial = createInitialCodexStoreState();

    const withDetail = codexStoreReducer(initial, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_tokens",
        projectId: "default",
        cardId: "card_tokens",
        threadName: "Thread Tokens",
        threadPreview: "Preview",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "active",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 2,
        linkedAt: "2026-02-21T00:00:00.000Z",
        turns: [
          {
            threadId: "thr_tokens",
            turnId: "turn_tokens",
            status: "inProgress",
            itemIds: [],
            tokenUsage: {
              total: {
                totalTokens: 209_000,
                inputTokens: 180_000,
                cachedInputTokens: 12_000,
                outputTokens: 17_000,
                reasoningOutputTokens: 3_000,
              },
              last: {
                totalTokens: 209_000,
                inputTokens: 180_000,
                cachedInputTokens: 12_000,
                outputTokens: 17_000,
                reasoningOutputTokens: 3_000,
              },
              modelContextWindow: 258_000,
            },
          },
        ],
        items: [],
      },
    });

    const withTurnStatus = codexStoreReducer(withDetail, {
      type: "event",
      event: {
        type: "turn",
        turn: {
          threadId: "thr_tokens",
          turnId: "turn_tokens",
          status: "completed",
          itemIds: [],
        },
      },
    });

    const turn = withTurnStatus.threadDetailsById.thr_tokens?.turns[0];
    expect(turn?.status).toBe("completed");
    expect(turn?.tokenUsage?.modelContextWindow).toBe(258_000);
    expect(turn?.tokenUsage?.last.totalTokens).toBe(209_000);
  });

  test("queues and resolves approval + user input events", () => {
    const initial = createInitialCodexStoreState();

    const withApproval = codexStoreReducer(initial, {
      type: "event",
      event: {
        type: "approvalRequested",
        request: {
          requestId: "approval_1",
          kind: "command",
          projectId: "default",
          cardId: "card_1",
          threadId: "thr_1",
          turnId: "turn_1",
          itemId: "item_1",
          createdAt: Date.now(),
        },
      },
    });

    expect(withApproval.approvalQueue.length).toBe(1);

    const withApprovalResolved = codexStoreReducer(withApproval, {
      type: "event",
      event: {
        type: "approvalResolved",
        requestId: "approval_1",
        decision: "accept",
      },
    });

    expect(withApprovalResolved.approvalQueue.length).toBe(0);

    const withUserInput = codexStoreReducer(withApprovalResolved, {
      type: "event",
      event: {
        type: "userInputRequested",
        request: {
          requestId: "input_1",
          projectId: "default",
          cardId: "card_1",
          threadId: "thr_1",
          turnId: "turn_1",
          itemId: "item_1",
          questions: [
            {
              id: "q_1",
              header: "Header",
              question: "Question",
              isOther: false,
              isSecret: false,
              options: [{ label: "Yes", description: "Approve" }],
            },
          ],
          createdAt: Date.now(),
        },
      },
    });

    expect(withUserInput.userInputQueue.length).toBe(1);

    const withUserInputResolved = codexStoreReducer(withUserInput, {
      type: "event",
      event: {
        type: "userInputResolved",
        requestId: "input_1",
      },
    });

    expect(withUserInputResolved.userInputQueue.length).toBe(0);
  });

  test("synthesizes plan implementation requests for the latest completed plan turn and clears them when resolved", () => {
    const initial = createInitialCodexStoreState();

    const withDetail = codexStoreReducer(initial, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_plan_request",
        projectId: "default",
        cardId: "card_plan_request",
        threadName: "Plan thread",
        threadPreview: "Preview",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "idle",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 2,
        linkedAt: "2026-02-21T00:00:00.000Z",
        turns: [
          {
            threadId: "thr_plan_request",
            turnId: "turn_plan_request",
            status: "completed",
            itemIds: ["plan_item"],
          },
        ],
        items: [
          {
            threadId: "thr_plan_request",
            turnId: "turn_plan_request",
            itemId: "plan_item",
            type: "plan",
            normalizedKind: "plan",
            markdownText: "1. Review the thread\n2. Implement the chosen path",
            createdAt: 10,
            updatedAt: 11,
          },
        ],
      },
    });

    expect(withDetail.planImplementationQueue.length).toBe(1);
    expect(withDetail.planImplementationQueue[0]?.requestId).toBe("implement-plan:turn_plan_request");
    expect(withDetail.planImplementationQueue[0]?.planContent).toBe("1. Review the thread\n2. Implement the chosen path");

    const withResolution = codexStoreReducer(withDetail, {
      type: "resolvePlanImplementation",
      threadId: "thr_plan_request",
      turnId: "turn_plan_request",
    });

    expect(withResolution.planImplementationQueue.length).toBe(0);

    const withSameDetailReloaded = codexStoreReducer(withResolution, {
      type: "setThreadDetail",
      detail: withDetail.threadDetailsById.thr_plan_request!,
    });

    expect(withSameDetailReloaded.planImplementationQueue.length).toBe(0);
  });

  test("clears plan implementation requests once a new turn starts", () => {
    const initial = createInitialCodexStoreState();

    const withDetail = codexStoreReducer(initial, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_plan_cleared",
        projectId: "default",
        cardId: "card_plan_cleared",
        threadName: "Plan thread",
        threadPreview: "Preview",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "idle",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 2,
        linkedAt: "2026-02-21T00:00:00.000Z",
        turns: [
          {
            threadId: "thr_plan_cleared",
            turnId: "turn_plan_old",
            status: "completed",
            itemIds: ["plan_item"],
          },
        ],
        items: [
          {
            threadId: "thr_plan_cleared",
            turnId: "turn_plan_old",
            itemId: "plan_item",
            type: "plan",
            normalizedKind: "plan",
            markdownText: "Ship it",
            createdAt: 10,
            updatedAt: 11,
          },
        ],
      },
    });

    expect(withDetail.planImplementationQueue.length).toBe(1);

    const withStartedTurn = codexStoreReducer(withDetail, {
      type: "event",
      event: {
        type: "turn",
        turn: {
          threadId: "thr_plan_cleared",
          turnId: "turn_plan_new",
          status: "inProgress",
          itemIds: [],
        },
      },
    });

    expect(withStartedTurn.planImplementationQueue.length).toBe(0);
  });

  test("applies itemDelta to both text and markdownText for markdown-capable items", () => {
    const initial = createInitialCodexStoreState();

    const withDetail = codexStoreReducer(initial, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_delta_markdown",
        projectId: "default",
        cardId: "card_delta_markdown",
        threadName: "Delta markdown thread",
        threadPreview: "Preview",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "active",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 2,
        linkedAt: "2026-02-21T00:00:00.000Z",
        turns: [],
        items: [
          {
            threadId: "thr_delta_markdown",
            turnId: "turn_1",
            itemId: "item_1",
            type: "agentMessage",
            normalizedKind: "assistantMessage",
            markdownText: "Hello",
            createdAt: 10,
            updatedAt: 11,
          },
        ],
      },
    });

    const withDelta = codexStoreReducer(withDetail, {
      type: "event",
      event: {
        type: "itemDelta",
        threadId: "thr_delta_markdown",
        turnId: "turn_1",
        itemId: "item_1",
        delta: " world",
      },
    });

    const item = withDelta.threadDetailsById.thr_delta_markdown?.items[0];
    expect(item?.markdownText).toBe("Hello world");
  });

  test("applies plan item deltas incrementally", () => {
    const initial = createInitialCodexStoreState();

    const withDetail = codexStoreReducer(initial, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_delta_plan",
        projectId: "default",
        cardId: "card_delta_plan",
        threadName: "Delta plan thread",
        threadPreview: "Preview",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "active",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 2,
        linkedAt: "2026-02-21T00:00:00.000Z",
        turns: [],
        items: [
          {
            threadId: "thr_delta_plan",
            turnId: "turn_plan",
            itemId: "plan_1",
            type: "plan",
            normalizedKind: "plan",
            markdownText: "1. Research",
            createdAt: 10,
            updatedAt: 11,
          },
        ],
      },
    });

    const withFirstDelta = codexStoreReducer(withDetail, {
      type: "event",
      event: {
        type: "itemDelta",
        threadId: "thr_delta_plan",
        turnId: "turn_plan",
        itemId: "plan_1",
        delta: "\n2. Implement",
      },
    });
    const withSecondDelta = codexStoreReducer(withFirstDelta, {
      type: "event",
      event: {
        type: "itemDelta",
        threadId: "thr_delta_plan",
        turnId: "turn_plan",
        itemId: "plan_1",
        delta: "\n3. Verify",
      },
    });

    const item = withSecondDelta.threadDetailsById.thr_delta_plan?.items[0];
    expect(item?.markdownText).toBe("1. Research\n2. Implement\n3. Verify");
  });

  test("preserves richer existing item fields when thread detail rehydrates with sparse items", () => {
    const initial = createInitialCodexStoreState();

    const firstDetail = codexStoreReducer(initial, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_2",
        projectId: "default",
        cardId: "card_2",
        threadName: "Thread 2",
        threadPreview: "Preview",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "active",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 2,
        linkedAt: "2026-02-21T00:00:00.000Z",
        turns: [],
        items: [
          {
            threadId: "thr_2",
            turnId: "turn_1",
            itemId: "item_1",
            type: "commandExecution",
            normalizedKind: "commandExecution",
            toolCall: {
              subtype: "command",
              toolName: "bash",
              args: {
                command: "bun test",
              },
              result: "1 pass",
            },
            createdAt: 10,
            updatedAt: 11,
          },
        ],
      },
    });

    const refreshedDetail = codexStoreReducer(firstDetail, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_2",
        projectId: "default",
        cardId: "card_2",
        threadName: "Thread 2",
        threadPreview: "Preview",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "active",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 3,
        linkedAt: "2026-02-21T00:00:00.000Z",
        turns: [],
        items: [
          {
            threadId: "thr_2",
            turnId: "turn_1",
            itemId: "item_1",
            type: "commandExecution",
            normalizedKind: "commandExecution",
            createdAt: 20,
            updatedAt: 21,
          },
        ],
      },
    });

    const merged = refreshedDetail.threadDetailsById.thr_2?.items[0];
    expect(((merged?.toolCall?.args as { command?: string } | undefined)?.command) ?? "").toBe("bun test");
    expect(merged?.toolCall?.result).toBe("1 pass");
    expect(merged?.createdAt).toBe(10);
    expect(merged?.updatedAt).toBe(21);
  });

  test("keeps existing turns and items when rehydrate returns empty arrays", () => {
    const initial = createInitialCodexStoreState();

    const withDetail = codexStoreReducer(initial, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_empty",
        projectId: "default",
        cardId: "card_empty",
        threadName: "Thread Empty",
        threadPreview: "Preview",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "active",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 2,
        linkedAt: "2026-02-21T00:00:00.000Z",
        turns: [
          {
            threadId: "thr_empty",
            turnId: "turn_1",
            status: "completed",
            itemIds: ["item_1"],
          },
        ],
        items: [
          {
            threadId: "thr_empty",
            turnId: "turn_1",
            itemId: "item_1",
            type: "mcpToolCall",
            normalizedKind: "toolCall",
            toolCall: {
              subtype: "mcp",
              toolName: "search",
              server: "docs",
            },
            createdAt: 10,
            updatedAt: 11,
          },
        ],
      },
    });

    const withEmptyRehydrate = codexStoreReducer(withDetail, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_empty",
        projectId: "default",
        cardId: "card_empty",
        threadName: "Thread Empty",
        threadPreview: "Preview",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "active",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 3,
        linkedAt: "2026-02-21T00:00:00.000Z",
        turns: [],
        items: [],
      },
    });

    expect(withEmptyRehydrate.threadDetailsById.thr_empty?.turns.length).toBe(1);
    expect(withEmptyRehydrate.threadDetailsById.thr_empty?.items.length).toBe(1);
    expect(withEmptyRehydrate.threadDetailsById.thr_empty?.items[0]?.toolCall?.toolName).toBe("search");
  });

  test("preserves existing tool-call items when refresh payload is missing them", () => {
    const initial = createInitialCodexStoreState();

    const withDetail = codexStoreReducer(initial, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_sparse",
        projectId: "default",
        cardId: "card_sparse",
        threadName: "Sparse thread",
        threadPreview: "Preview",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "active",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 2,
        linkedAt: "2026-02-21T00:00:00.000Z",
        turns: [],
        items: [
          {
            threadId: "thr_sparse",
            turnId: "turn_1",
            itemId: "item_tool",
            type: "mcpToolCall",
            normalizedKind: "toolCall",
            toolCall: {
              subtype: "mcp",
              toolName: "search_web",
              args: { q: "hello" },
            },
            createdAt: 10,
            updatedAt: 11,
          },
          {
            threadId: "thr_sparse",
            turnId: "turn_1",
            itemId: "item_text",
            type: "agentMessage",
            normalizedKind: "assistantMessage",
            markdownText: "Working...",
            createdAt: 12,
            updatedAt: 13,
          },
        ],
      },
    });

    const withSparseRefresh = codexStoreReducer(withDetail, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_sparse",
        projectId: "default",
        cardId: "card_sparse",
        threadName: "Sparse thread",
        threadPreview: "Preview",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "active",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 3,
        linkedAt: "2026-02-21T00:00:00.000Z",
        turns: [],
        items: [
          {
            threadId: "thr_sparse",
            turnId: "turn_1",
            itemId: "item_text",
            type: "agentMessage",
            normalizedKind: "assistantMessage",
            markdownText: "Working... still",
            createdAt: 20,
            updatedAt: 21,
          },
        ],
      },
    });

    const mergedItems = withSparseRefresh.threadDetailsById.thr_sparse?.items ?? [];
    expect(mergedItems.length).toBe(2);
    expect(mergedItems.some((item) => item.itemId === "item_tool" && item.normalizedKind === "toolCall")).toBeTrue();
    expect(mergedItems.find((item) => item.itemId === "item_text")?.markdownText).toBe("Working... still");
  });

  test("keeps in-progress turns during sparse thread rehydrates", () => {
    const initial = createInitialCodexStoreState();

    const withDetail = codexStoreReducer(initial, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_running",
        projectId: "default",
        cardId: "card_running",
        threadName: "Running thread",
        threadPreview: "Preview",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "active",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 2,
        linkedAt: "2026-02-21T00:00:00.000Z",
        turns: [
          {
            threadId: "thr_running",
            turnId: "turn_running",
            status: "inProgress",
            itemIds: [],
          },
        ],
        items: [],
      },
    });

    const withSparseRefresh = codexStoreReducer(withDetail, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_running",
        projectId: "default",
        cardId: "card_running",
        threadName: "Running thread",
        threadPreview: "Preview",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "idle",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 3,
        linkedAt: "2026-02-21T00:00:00.000Z",
        turns: [],
        items: [],
      },
    });

    const detail = withSparseRefresh.threadDetailsById.thr_running;
    const hasInProgressTurn = detail?.turns.some((turn) => turn.status === "inProgress") ?? false;
    expect(hasInProgressTurn).toBeTrue();
    expect(detail?.turns.find((turn) => turn.turnId === "turn_running")?.status).toBe("inProgress");
  });

  test("does not downgrade active thread status from stale detail refresh", () => {
    const initial = createInitialCodexStoreState();

    const withThreadSummary = codexStoreReducer(initial, {
      type: "event",
      event: {
        type: "threadSummary",
        thread: {
          threadId: "thr_stale",
          projectId: "default",
          cardId: "card_stale",
          threadName: "Stale thread",
          threadPreview: "Preview",
          modelProvider: "openai",
          cwd: "/tmp/project",
          statusType: "active",
          statusActiveFlags: [],
          archived: false,
          createdAt: 1,
          updatedAt: 2,
          linkedAt: "2026-02-21T00:00:00.000Z",
        },
      },
    });

    const withExistingDetail = codexStoreReducer(withThreadSummary, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_stale",
        projectId: "default",
        cardId: "card_stale",
        threadName: "Stale thread",
        threadPreview: "Preview",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "active",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 2,
        linkedAt: "2026-02-21T00:00:00.000Z",
        turns: [],
        items: [],
      },
    });

    const withStaleRefresh = codexStoreReducer(withExistingDetail, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_stale",
        projectId: "default",
        cardId: "card_stale",
        threadName: "Stale thread",
        threadPreview: "Preview",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "idle",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 3,
        linkedAt: "2026-02-21T00:00:00.000Z",
        turns: [],
        items: [],
      },
    });

    const summary = withStaleRefresh.threadsByProject.default?.find((thread) => thread.threadId === "thr_stale");
    const detail = withStaleRefresh.threadDetailsById.thr_stale;
    expect(summary?.statusType).toBe("active");
    expect(detail?.statusType).toBe("active");

    const withExplicitIdle = codexStoreReducer(withStaleRefresh, {
      type: "event",
      event: {
        type: "threadStatus",
        threadId: "thr_stale",
        statusType: "idle",
        statusActiveFlags: [],
      },
    });

    const idleSummary = withExplicitIdle.threadsByProject.default?.find((thread) => thread.threadId === "thr_stale");
    const idleDetail = withExplicitIdle.threadDetailsById.thr_stale;
    expect(idleSummary?.statusType).toBe("idle");
    expect(idleDetail?.statusType).toBe("idle");
  });

  test("does not downgrade active thread status from stale non-sparse detail refresh", () => {
    const initial = createInitialCodexStoreState();

    const withThreadSummary = codexStoreReducer(initial, {
      type: "event",
      event: {
        type: "threadSummary",
        thread: {
          threadId: "thr_stale_non_sparse",
          projectId: "default",
          cardId: "card_stale_non_sparse",
          threadName: "Stale non-sparse thread",
          threadPreview: "Preview",
          modelProvider: "openai",
          cwd: "/tmp/project",
          statusType: "active",
          statusActiveFlags: [],
          archived: false,
          createdAt: 1,
          updatedAt: 2,
          linkedAt: "2026-02-21T00:00:00.000Z",
        },
      },
    });

    const withExistingDetail = codexStoreReducer(withThreadSummary, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_stale_non_sparse",
        projectId: "default",
        cardId: "card_stale_non_sparse",
        threadName: "Stale non-sparse thread",
        threadPreview: "Preview",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "active",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 2,
        linkedAt: "2026-02-21T00:00:00.000Z",
        turns: [
          {
            threadId: "thr_stale_non_sparse",
            turnId: "turn_1",
            status: "completed",
            itemIds: ["item_1"],
          },
        ],
        items: [
          {
            threadId: "thr_stale_non_sparse",
            turnId: "turn_1",
            itemId: "item_1",
            type: "agentMessage",
            normalizedKind: "assistantMessage",
            markdownText: "Completed",
            createdAt: 10,
            updatedAt: 11,
          },
        ],
      },
    });

    const withStaleRefresh = codexStoreReducer(withExistingDetail, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_stale_non_sparse",
        projectId: "default",
        cardId: "card_stale_non_sparse",
        threadName: "Stale non-sparse thread",
        threadPreview: "Preview",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "idle",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 3,
        linkedAt: "2026-02-21T00:00:00.000Z",
        turns: [
          {
            threadId: "thr_stale_non_sparse",
            turnId: "turn_1",
            status: "completed",
            itemIds: ["item_1"],
          },
        ],
        items: [
          {
            threadId: "thr_stale_non_sparse",
            turnId: "turn_1",
            itemId: "item_1",
            type: "agentMessage",
            normalizedKind: "assistantMessage",
            markdownText: "Completed",
            createdAt: 10,
            updatedAt: 12,
          },
        ],
      },
    });

    const summary = withStaleRefresh.threadsByProject.default?.find((thread) => thread.threadId === "thr_stale_non_sparse");
    const detail = withStaleRefresh.threadDetailsById.thr_stale_non_sparse;
    expect(summary?.statusType).toBe("active");
    expect(detail?.statusType).toBe("active");
  });

  test("trusts authoritative idle detail once a known in-progress turn settles", () => {
    const initial = createInitialCodexStoreState();

    const withThreadSummary = codexStoreReducer(initial, {
      type: "event",
      event: {
        type: "threadSummary",
        thread: {
          threadId: "thr_steer_complete",
          projectId: "default",
          cardId: "card_steer_complete",
          threadName: "Steered thread",
          threadPreview: "Preview",
          modelProvider: "openai",
          cwd: "/tmp/project",
          statusType: "active",
          statusActiveFlags: [],
          archived: false,
          createdAt: 1,
          updatedAt: 2,
          linkedAt: "2026-02-21T00:00:00.000Z",
        },
      },
    });

    const withExistingDetail = codexStoreReducer(withThreadSummary, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_steer_complete",
        projectId: "default",
        cardId: "card_steer_complete",
        threadName: "Steered thread",
        threadPreview: "Preview",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "active",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 2,
        linkedAt: "2026-02-21T00:00:00.000Z",
        turns: [
          {
            threadId: "thr_steer_complete",
            turnId: "turn_active",
            status: "inProgress",
            itemIds: ["item_reasoning"],
          },
        ],
        items: [
          {
            threadId: "thr_steer_complete",
            turnId: "turn_active",
            itemId: "item_reasoning",
            type: "reasoning",
            normalizedKind: "reasoning",
            status: "inProgress",
            markdownText: "Thinking...",
            createdAt: 10,
            updatedAt: 10,
          },
        ],
      },
    });

    const withSettledRefresh = codexStoreReducer(withExistingDetail, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_steer_complete",
        projectId: "default",
        cardId: "card_steer_complete",
        threadName: "Steered thread",
        threadPreview: "Preview",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "idle",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 3,
        linkedAt: "2026-02-21T00:00:00.000Z",
        turns: [
          {
            threadId: "thr_steer_complete",
            turnId: "turn_active",
            status: "completed",
            itemIds: ["item_reasoning", "item_reply"],
          },
        ],
        items: [
          {
            threadId: "thr_steer_complete",
            turnId: "turn_active",
            itemId: "item_reasoning",
            type: "reasoning",
            normalizedKind: "reasoning",
            status: "completed",
            markdownText: "Thinking...",
            createdAt: 10,
            updatedAt: 11,
          },
          {
            threadId: "thr_steer_complete",
            turnId: "turn_active",
            itemId: "item_reply",
            type: "agentMessage",
            normalizedKind: "assistantMessage",
            markdownText: "Applied the steering update.",
            createdAt: 12,
            updatedAt: 12,
          },
        ],
      },
    });

    const summary = withSettledRefresh.threadsByProject.default?.find((thread) => thread.threadId === "thr_steer_complete");
    const detail = withSettledRefresh.threadDetailsById.thr_steer_complete;
    expect(summary?.statusType).toBe("idle");
    expect(detail?.statusType).toBe("idle");
    expect(detail?.turns[0]?.status).toBe("completed");
  });

  test("dedupes synthetic and live user-message ids when thread detail rehydrates", () => {
    const initial = createInitialCodexStoreState();

    const withDetail = codexStoreReducer(initial, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_dedupe",
        projectId: "default",
        cardId: "card_dedupe",
        threadName: "Dedupe thread",
        threadPreview: "Preview",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "idle",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 2,
        linkedAt: "2026-02-21T00:00:00.000Z",
        turns: [],
        items: [
          {
            threadId: "thr_dedupe",
            turnId: "turn_1",
            itemId: "7b39d8f6-a4bd-440f-919a-c95d2a5090f1",
            type: "userMessage",
            normalizedKind: "userMessage",
            role: "user",
            markdownText: "say \"hi\"",
            createdAt: 10,
            updatedAt: 10,
          },
        ],
      },
    });

    const withRehydratedDetail = codexStoreReducer(withDetail, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_dedupe",
        projectId: "default",
        cardId: "card_dedupe",
        threadName: "Dedupe thread",
        threadPreview: "Preview",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "idle",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 3,
        linkedAt: "2026-02-21T00:00:00.000Z",
        turns: [],
        items: [
          {
            threadId: "thr_dedupe",
            turnId: "turn_1",
            itemId: "item-16",
            type: "userMessage",
            normalizedKind: "userMessage",
            role: "user",
            markdownText: "say \"hi\"",
            createdAt: 20,
            updatedAt: 20,
          },
        ],
      },
    });

    const items = withRehydratedDetail.threadDetailsById.thr_dedupe?.items ?? [];
    expect(items.length).toBe(1);
    expect(items[0]?.markdownText).toBe("say \"hi\"");
  });

  test("adds and rolls back a client-side optimistic steering item", () => {
    const initial = createInitialCodexStoreState();

    const withDetail = codexStoreReducer(initial, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_optimistic_steer",
        projectId: "default",
        cardId: "card_optimistic_steer",
        threadName: "Optimistic steer",
        threadPreview: "Preview",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "active",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 2,
        linkedAt: "2026-02-21T00:00:00.000Z",
        turns: [
          {
            threadId: "thr_optimistic_steer",
            turnId: "turn_active",
            status: "inProgress",
            itemIds: [],
          },
        ],
        items: [],
      },
    });

    const withOptimisticItem = codexStoreReducer(withDetail, {
      type: "optimisticItemUpsert",
      item: {
        threadId: "thr_optimistic_steer",
        turnId: "turn_active",
        itemId: "item-5001",
        type: "userMessage",
        normalizedKind: "userMessage",
        role: "user",
        status: "completed",
        markdownText: "Please adjust spacing",
        createdAt: 10,
        updatedAt: 10,
      },
    });

    expect(withOptimisticItem.threadDetailsById.thr_optimistic_steer?.items.length).toBe(1);
    expect(withOptimisticItem.threadDetailsById.thr_optimistic_steer?.turns[0]?.itemIds.length).toBe(1);
    expect(withOptimisticItem.threadDetailsById.thr_optimistic_steer?.turns[0]?.itemIds[0]).toBe("item-5001");

    const withRollback = codexStoreReducer(withOptimisticItem, {
      type: "removeThreadItem",
      threadId: "thr_optimistic_steer",
      turnId: "turn_active",
      itemId: "item-5001",
    });

    expect(withRollback.threadDetailsById.thr_optimistic_steer?.items.length).toBe(0);
    expect(withRollback.threadDetailsById.thr_optimistic_steer?.turns[0]?.itemIds.length).toBe(0);
  });

  test("dedupes synthetic and live assistant-message ids when thread detail rehydrates", () => {
    const initial = createInitialCodexStoreState();

    const withDetail = codexStoreReducer(initial, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_dedupe_assistant",
        projectId: "default",
        cardId: "card_dedupe_assistant",
        threadName: "Dedupe assistant thread",
        threadPreview: "Preview",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "idle",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 2,
        linkedAt: "2026-02-21T00:00:00.000Z",
        turns: [],
        items: [
          {
            threadId: "thr_dedupe_assistant",
            turnId: "turn_1",
            itemId: "msg_0001",
            type: "agentMessage",
            normalizedKind: "assistantMessage",
            role: "assistant",
            markdownText: "I added the shared module. Next I’m rewiring project-switcher.tsx.",
            createdAt: 10,
            updatedAt: 10,
          },
        ],
      },
    });

    const withRehydratedDetail = codexStoreReducer(withDetail, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_dedupe_assistant",
        projectId: "default",
        cardId: "card_dedupe_assistant",
        threadName: "Dedupe assistant thread",
        threadPreview: "Preview",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "idle",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 3,
        linkedAt: "2026-02-21T00:00:00.000Z",
        turns: [],
        items: [
          {
            threadId: "thr_dedupe_assistant",
            turnId: "turn_1",
            itemId: "item-15",
            type: "agentMessage",
            normalizedKind: "assistantMessage",
            role: "assistant",
            markdownText: "I added the shared module. Next I’m rewiring project-switcher.tsx.",
            createdAt: 20,
            updatedAt: 20,
          },
        ],
      },
    });

    const items = withRehydratedDetail.threadDetailsById.thr_dedupe_assistant?.items ?? [];
    expect(items.length).toBe(1);
    expect(items[0]?.normalizedKind).toBe("assistantMessage");
    expect(items[0]?.markdownText).toBe("I added the shared module. Next I’m rewiring project-switcher.tsx.");
  });

  test("keeps two live assistant-message ids even when their text is identical", () => {
    const initial = createInitialCodexStoreState();

    const withDetail = codexStoreReducer(initial, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_live_guard",
        projectId: "default",
        cardId: "card_live_guard",
        threadName: "Live guard thread",
        threadPreview: "Preview",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "idle",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 2,
        linkedAt: "2026-02-21T00:00:00.000Z",
        turns: [],
        items: [
          {
            threadId: "thr_live_guard",
            turnId: "turn_1",
            itemId: "msg_0001",
            type: "agentMessage",
            normalizedKind: "assistantMessage",
            role: "assistant",
            markdownText: "Working...",
            createdAt: 10,
            updatedAt: 10,
          },
        ],
      },
    });

    const withRehydratedDetail = codexStoreReducer(withDetail, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_live_guard",
        projectId: "default",
        cardId: "card_live_guard",
        threadName: "Live guard thread",
        threadPreview: "Preview",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "idle",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 3,
        linkedAt: "2026-02-21T00:00:00.000Z",
        turns: [],
        items: [
          {
            threadId: "thr_live_guard",
            turnId: "turn_1",
            itemId: "msg_0002",
            type: "agentMessage",
            normalizedKind: "assistantMessage",
            role: "assistant",
            markdownText: "Working...",
            createdAt: 20,
            updatedAt: 20,
          },
        ],
      },
    });

    const items = withRehydratedDetail.threadDetailsById.thr_live_guard?.items ?? [];
    expect(items.length).toBe(2);
    expect(items.map((item) => item.itemId).sort().join(",")).toBe("msg_0001,msg_0002");
  });

  test("merges thread-start progress output with terminal control characters", () => {
    const initial = createInitialCodexStoreState();
    const baseTimestamp = Date.now();

    const withStart = codexStoreReducer(initial, {
      type: "event",
      event: {
        type: "threadStartProgress",
        projectId: "default",
        cardId: "card_1",
        phase: "creatingWorktree",
        message: "Creating a worktree and running setup.",
        clearOutput: true,
        outputDelta: "[info] Starting worktree creation\n",
        stream: "info",
        updatedAt: baseTimestamp,
      },
    });

    const withCarriageReturn = codexStoreReducer(withStart, {
      type: "event",
      event: {
        type: "threadStartProgress",
        projectId: "default",
        cardId: "card_1",
        phase: "runningSetup",
        message: "Creating a worktree and running setup.",
        outputDelta: "progress 10%\rprogress 40%\n",
        stream: "stdout",
        updatedAt: baseTimestamp + 1,
      },
    });

    const withBackspace = codexStoreReducer(withCarriageReturn, {
      type: "event",
      event: {
        type: "threadStartProgress",
        projectId: "default",
        cardId: "card_1",
        phase: "runningSetup",
        message: "Creating a worktree and running setup.",
        outputDelta: "helloo\b\n",
        stream: "stdout",
        updatedAt: baseTimestamp + 2,
      },
    });

    const progress = withBackspace.threadStartProgressByTarget["default:card_1"];
    expect(progress?.outputText).toBe("[info] Starting worktree creation\nprogress 40%\nhello\n");
  });

  test("clears thread-start progress when thread detail arrives for the same card", () => {
    const initial = createInitialCodexStoreState();
    const withProgress = codexStoreReducer(initial, {
      type: "event",
      event: {
        type: "threadStartProgress",
        projectId: "default",
        cardId: "card_ready",
        phase: "ready",
        message: "Worktree ready.",
        outputDelta: "[info] Worktree ready.\n",
        stream: "info",
        updatedAt: Date.now(),
      },
    });

    const withDetail = codexStoreReducer(withProgress, {
      type: "setThreadDetail",
      detail: {
        threadId: "thr_ready",
        projectId: "default",
        cardId: "card_ready",
        threadName: "Ready thread",
        threadPreview: "",
        modelProvider: "openai",
        cwd: "/tmp/project",
        statusType: "active",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 2,
        linkedAt: "2026-03-04T00:00:00.000Z",
        turns: [],
        items: [],
      },
    });

    expect(withDetail.threadStartProgressByTarget["default:card_ready"]).toBe(undefined);
  });
});
