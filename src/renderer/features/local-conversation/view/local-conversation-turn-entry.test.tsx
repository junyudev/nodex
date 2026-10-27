import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { createElement, useState, type ReactElement, type RefCallback } from "react";
import { NodexTooltipProvider as TooltipProvider } from "../../../components/ui/tooltip";
import { renderWithMaitai as renderDom } from "../../../test/thread-maitai";
import { settleAsyncRender } from "../../../test/dom";
import type { CodexConversationItem, CodexConversationTurn } from "../../../lib/types";
import type { VisibleConversationTurnEntry } from "../selectors";
import type { ThreadStageActions } from "../thread-stage-types";
import { createAsyncQuestionRuntime } from "../async-question-runtime";
import { ConversationRuntimeContext, type ConversationRuntime } from "../conversation-runtime";
import { LocalConversationTestQueryProvider } from "./local-conversation-test-query.test-fixtures";
import { formatThreadMessageTimestamp } from "./shared/thread-message-timestamp";

const renderCounts = new Map<string, number>();

function render(ui: ReactElement) {
  return renderDom(ui, {
    wrapper: LocalConversationTestQueryProvider,
  });
}

function buildUserEntry(
  turnId: string,
  itemId: string,
  markdownText: string,
  overrides: Partial<CodexConversationItem> = {},
): CodexConversationItem {
  return {
    threadId: "thread_1",
    turnId,
    itemId,
    type: "user_message",
    kind: "userMessage",
    semanticKind: "userMessage",
    role: "user",
    markdownText,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function buildAssistantEntry(
  turnId: string,
  itemId: string,
  markdownText: string,
  overrides: Partial<CodexConversationItem> = {},
): CodexConversationItem {
  return {
    threadId: "thread_1",
    turnId,
    itemId,
    type: "assistant_message",
    kind: "assistantMessage",
    semanticKind: "assistantMessage",
    role: "assistant",
    markdownText,
    createdAt: 2,
    updatedAt: 2,
    ...overrides,
  };
}

function buildSteeringEntry(
  turnId: string,
  itemId: string,
  markdownText: string,
  steeringStatus: "pending" | "accepted",
): CodexConversationItem {
  return {
    threadId: "thread_1",
    turnId,
    itemId,
    entryId: itemId,
    type: "steeringUserMessage",
    kind: "userMessage",
    semanticKind: "userMessage",
    status: "completed",
    role: "user",
    markdownText,
    steeringStatus,
    createdAt: 3,
    updatedAt: 3,
  };
}

function buildSteeredEntry(turnId: string, itemId: string): CodexConversationItem {
  return {
    threadId: "thread_1",
    turnId,
    itemId,
    entryId: itemId,
    type: "steered",
    kind: "systemEvent",
    semanticKind: "steered",
    status: "completed",
    markdownText: "Steered conversation",
    createdAt: 4,
    updatedAt: 4,
  };
}

function buildTurn(
  turnId: string,
  userText: string,
  assistantText: string,
  overrides: Partial<CodexConversationTurn> = {},
): CodexConversationTurn {
  const userId = `${turnId}_user`;
  const assistantId = `${turnId}_assistant`;
  return {
    threadId: "thread_1",
    turnId,
    status: "completed",
    itemIds: [userId, assistantId],
    items: [
      buildUserEntry(turnId, userId, userText),
      buildAssistantEntry(turnId, assistantId, assistantText),
    ],
    ...overrides,
  };
}

function buildVisibleTurnEntry(
  turn: CodexConversationTurn,
  requests: VisibleConversationTurnEntry["requests"],
  isMostRecentTurn: boolean,
): VisibleConversationTurnEntry {
  const turnKey = turn.turnId ?? "turn-index-0";
  return {
    turn,
    turnId: turn.turnId,
    turnKey,
    turnSearchKey: turnKey,
    requests,
    isMostRecentTurn,
  };
}

describe("LocalConversationTurnEntry", () => {
  beforeEach(() => {
    renderCounts.clear();
  });

  test("reveals the first denied action from its historical count without moving ordinary expansion", async () => {
    const { LocalConversationTurnEntry } = await import("./local-conversation-turn-entry");
    const turnId = "turn_denied_actions";
    const review = (id: string, status: "denied" | "approved"): CodexConversationItem => ({
      threadId: "thread_1",
      turnId,
      itemId: id,
      type: "automaticApprovalReview",
      kind: "systemEvent",
      semanticKind: "automaticApprovalReview",
      status: "completed",
      createdAt: 2,
      updatedAt: 2,
      rawItem: {
        targetItemId: null,
        review: { status, riskLevel: "high", userAuthorization: "low", rationale: id },
        action: {
          type: "command",
          source: "unifiedExec",
          command: `touch ${id}.txt`,
          cwd: "/tmp/project",
        },
      },
    });
    const items = [
      buildUserEntry(turnId, "user", "Check the protected files."),
      review("first-denial", "denied"),
      review("approved-retry", "approved"),
      review("second-denial", "denied"),
      buildAssistantEntry(turnId, "reply", "The checks are complete.", {
        assistantPhase: "final_answer",
      }),
    ];
    const entry = buildVisibleTurnEntry(
      buildTurn(turnId, "", "", { items, itemIds: items.map((item) => item.itemId) }),
      [],
      true,
    );
    function Harness() {
      const [collapsed, setCollapsed] = useState(true);
      return (
        <TooltipProvider>
          <LocalConversationTurnEntry
            conversationId="thread_1"
            entry={entry}
            cwd="/tmp/project"
            canEditTurnUserPrefix={false}
            canForkTurn={false}
            persistedCollapsed={collapsed}
            onSetCollapsed={setCollapsed}
          />
        </TooltipProvider>
      );
    }
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const view = render(<Harness />);
    try {
      const count = view.getByRole("button", { name: /^View 2 denied actions$/ });
      const toggle = view.container.querySelector<HTMLButtonElement>("[data-agent-body-toggle]")!;
      expect(toggle.contains(count)).toBe(false);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      await act(async () => {
        fireEvent.click(toggle);
      });
      await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"));
      await settleAsyncRender();
      expect(scrollIntoView).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.click(toggle);
      });
      await waitFor(() =>
        expect(view.queryByRole("button", { name: "touch first-denial.txt" })).toBeNull(),
      );
      await act(async () => {
        fireEvent.click(count);
      });
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
      expect(scrollIntoView.mock.contexts[0]).toBe(
        view.container.querySelector("[data-auto-review-denied]"),
      );
      expect(view.getByRole("button", { name: "touch first-denial.txt" })).toBeTruthy();
      scrollIntoView.mockClear();
      await act(async () => {
        fireEvent.click(count);
      });
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
      expect(toggle.getAttribute("aria-expanded")).toBe("true");

      await act(async () => {
        fireEvent.click(toggle);
      });
      await waitFor(() =>
        expect(view.queryByRole("button", { name: "touch first-denial.txt" })).toBeNull(),
      );
      scrollIntoView.mockClear();
      await act(async () => {
        fireEvent.click(count);
      });
      await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"));
      await act(async () => {
        fireEvent.click(toggle);
      });
      await settleAsyncRender();
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      scrollIntoView.mockRestore();
    }
  });

  test("observes response blocks independently as commentary moves between lanes", async () => {
    const { LocalConversationTurnEntry } = await import("./local-conversation-turn-entry");
    const observed = new Set<HTMLDivElement>();
    const observe: RefCallback<HTMLDivElement> = (element) => {
      if (!element) return;
      observed.add(element);
      return () => {
        observed.delete(element);
      };
    };
    const turnId = "turn_follow_content";
    const user = buildUserEntry(turnId, "user", "Investigate.");
    const commentary = buildAssistantEntry(turnId, "commentary", "Checking.", {
      assistantPhase: "commentary",
      status: "completed",
    });
    const steering = buildSteeringEntry(turnId, "steering", "Continue.", "accepted");
    const reply = buildAssistantEntry(turnId, "reply", "Ready.", {
      assistantPhase: "final_answer",
      status: "completed",
    });
    const content = (items: CodexConversationItem[], completed = false) => (
      <TooltipProvider>
        <LocalConversationTurnEntry
          conversationId="thread_1"
          entry={buildVisibleTurnEntry(
            buildTurn(turnId, "", "", {
              status: completed ? "completed" : "inProgress",
              items,
              itemIds: items.map((item) => item.itemId),
            }),
            [],
            true,
          )}
          cwd="/tmp/project"
          canEditTurnUserPrefix={false}
          canForkTurn={false}
          persistedCollapsed={completed}
          latestTurnFollowContentRef={observe}
        />
      </TooltipProvider>
    );
    const view = render(content([user, commentary]));
    const promotedCommentaryRoot = [...observed].find((element) =>
      element.contains(view.getByText("Checking.", { exact: true })),
    );
    expect(promotedCommentaryRoot).toBeTruthy();
    for (const element of observed) {
      expect(element.contains(view.getByText("Investigate.", { exact: true }))).toBe(false);
    }

    view.rerender(content([user, commentary, steering, reply]));
    await settleAsyncRender();
    expect(observed.size).toBe(2);
    expect(observed.has(promotedCommentaryRoot!)).toBe(false);
    const commentaryRoot = [...observed].find((element) =>
      element.contains(view.getByText("Checking.", { exact: true })),
    )!;
    const replyRoot = [...observed].find((element) =>
      element.contains(view.getByText("Ready.", { exact: true })),
    )!;
    expect(commentaryRoot).toBeTruthy();
    expect(replyRoot).toBeTruthy();
    expect(commentaryRoot.contains(replyRoot)).toBe(false);
    expect(replyRoot.contains(commentaryRoot)).toBe(false);
    for (const element of observed) {
      expect(element.contains(view.getByText("Investigate.", { exact: true }))).toBe(false);
      expect(element.contains(view.getByText("Continue.", { exact: true }))).toBe(false);
    }

    view.rerender(content([user, commentary, steering, reply], true));
    await waitFor(() => expect([...observed]).toEqual([replyRoot]));
    view.unmount();
    expect(observed.size).toBe(0);
  });

  test("keeps an answered question before its reply and subsequent streaming work", async () => {
    const { LocalConversationTurnEntry } = await import("./local-conversation-turn-entry");
    const { LocalConversationAboveComposerPortalHost } =
      await import("./local-conversation-above-composer-portal");
    const runtime = createAsyncQuestionRuntime();
    const turnId = "turn_question_history";
    const question = {
      id: "question:0",
      sourceItemId: "question",
      questionIndex: 0,
      title: "Which color should I use?",
      options: ["Blue", "Green"],
    };
    runtime.reconcileScope("thread_1", {
      generation: 1,
      entityKey: turnId,
      turnId,
      questions: [question],
      answers: new Map(),
    });
    const override: ConversationRuntime = {
      kind: "codex",
      hostId: "local",
      subscribe: () => () => {},
      read: () => null,
      attachment: () => ({ status: "idle" }),
      connection: () => ({ status: "disconnected", retries: 0 }),
      role: () => null,
      primaryRequest: () => null,
      children: () => [],
      retain: () => () => {},
      loadHistory: async () => {},
      resume: async () => {},
      markRead: async () => {},
      setPresented: async () => {},
      asyncQuestions: { runtime, deliver: async () => ({ turnId }) },
    };
    const prefix = buildUserEntry(turnId, "user", "Choose the presentation color");
    const source = buildAssistantEntry(turnId, "question", question.title, {
      asyncQuestion: question,
      assistantPhase: "commentary",
      status: "completed",
    });
    const replies = [{ questionItemId: question.id, question: question.title, answer: "Blue" }];
    const answer = buildUserEntry(turnId, "answer", "Blue", { questionReplies: replies });
    const commentary = buildAssistantEntry(turnId, "commentary", "I will update the palette.", {
      assistantPhase: "commentary",
      status: "completed",
    });
    const command: CodexConversationItem = {
      threadId: "thread_1",
      turnId,
      itemId: "command",
      type: "command_execution",
      kind: "commandExecution",
      semanticKind: "exec",
      status: "completed",
      createdAt: 2,
      updatedAt: 2,
      commandActions: [{ type: "read", command: "", name: "palette.ts", path: "palette.ts" }],
      toolCall: { subtype: "command", toolName: "exec_command", args: {} },
    };
    const turn = (items: CodexConversationItem[], status: CodexConversationTurn["status"]) =>
      buildTurn(turnId, "", "", { status, items, itemIds: items.map((item) => item.itemId) });
    const content = (value: CodexConversationTurn, collapsed = false) => (
      <ConversationRuntimeContext.Provider value={override}>
        <TooltipProvider>
          <LocalConversationAboveComposerPortalHost conversationId="thread_1" />
          <LocalConversationTurnEntry
            conversationId="thread_1"
            entry={buildVisibleTurnEntry(value, [], true)}
            cwd="/tmp/project"
            canEditTurnUserPrefix={false}
            canForkTurn={false}
            persistedCollapsed={collapsed}
          />
        </TooltipProvider>
      </ConversationRuntimeContext.Provider>
    );
    const view = render(content(turn([prefix, source], "inProgress")));
    const sourceDocument = view.getByText(question.title, { exact: true });
    expect(view.getByRole("button", { name: "Answer question" })).toBeTruthy();

    await act(async () => {
      runtime.acknowledge("thread_1", replies);
      await Promise.resolve();
    });
    const reply = buildAssistantEntry(turnId, "final", "The palette now uses blue.", {
      assistantPhase: "final_answer",
      status: "inProgress",
    });
    const continuedItems = [prefix, source, answer, commentary, command, reply];
    view.rerender(content(turn(continuedItems, "inProgress")));
    await settleAsyncRender();
    const answerBubble = view
      .getByText("Blue", { exact: true })
      .closest("[data-user-message-bubble]")!;
    const laterCommentary = view.getByText("I will update the palette.", { exact: true });
    const streamingReply = view
      .getByText("blue.", { exact: true })
      .closest("[data-message-copy-root]")!;
    const follows = (before: Node, after: Node) =>
      Boolean(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(sourceDocument.isConnected).toBe(true);
    expect(follows(sourceDocument, answerBubble)).toBe(true);
    expect(follows(answerBubble, laterCommentary)).toBe(true);
    expect(follows(laterCommentary, streamingReply)).toBe(true);
    expect(view.queryByRole("button", { name: "Answer question" })).toBeNull();
    expect(view.container.querySelector("[data-above-composer-portal]")?.childElementCount).toBe(0);

    view.rerender(content(turn(continuedItems, "completed"), true));
    await settleAsyncRender();
    expect(sourceDocument.isConnected).toBe(true);
    expect(answerBubble.isConnected).toBe(true);
    expect(follows(sourceDocument, answerBubble)).toBe(true);
    expect(follows(answerBubble, streamingReply)).toBe(true);
    expect(view.queryByText("I will update the palette.", { exact: true })).toBeNull();
    view.unmount();

    const restored = render(content(turn(continuedItems, "completed"), true));
    const restoredSource = restored
      .getAllByText(question.title, { exact: true })
      .find((element) => !element.closest("[data-user-message-bubble]"))!;
    const restoredAnswer = restored
      .getByText("Blue", { exact: true })
      .closest("[data-user-message-bubble]")!;
    expect(follows(restoredSource, restoredAnswer)).toBe(true);
    expect(
      follows(restoredAnswer, restored.getByText("The palette now uses blue.", { exact: true })),
    ).toBe(true);
    expect(restored.queryByRole("button", { name: "Answer question" })).toBeNull();
  });

  test("owns latest streaming fixed content from the same main-row projection", async () => {
    const stableRequests: [] = [];
    const { LocalConversationTurnEntry } = await import("./local-conversation-turn-entry");
    const { LocalConversationAboveComposerPortalHost } =
      await import("./local-conversation-above-composer-portal");
    const turn = buildTurn("turn_fixed_owner", "Edit the file", "", {
      status: "inProgress",
      diff: ["--- a/src/app.ts", "+++ b/src/app.ts", "@@ -1 +1 @@", "-old", "+new"].join("\n"),
      items: [buildUserEntry("turn_fixed_owner", "turn_fixed_owner_user", "Edit the file")],
      itemIds: ["turn_fixed_owner_user"],
    });
    const view = render(
      createElement(
        TooltipProvider,
        null,
        createElement(LocalConversationAboveComposerPortalHost, {
          conversationId: "thread_1",
        }),
        createElement(LocalConversationTurnEntry, {
          conversationId: "thread_1",
          entry: buildVisibleTurnEntry(turn, stableRequests, true),
          cwd: "/tmp/project",
          canEditTurnUserPrefix: false,
          canForkTurn: false,
          threadCwd: "/tmp/project",
        }),
      ),
    );

    await settleAsyncRender();

    const host = view.container.querySelector("[data-above-composer-portal]");
    expect(host?.querySelector("[data-above-composer-fixed-content]") !== null).toBe(true);
    expect(host?.textContent?.includes("1 file changed") ?? false).toBe(true);
  });

  test("refreshes inherited spawn models when only the parent model changes", async () => {
    const { LocalConversationTurnEntry } = await import("./local-conversation-turn-entry");
    const item: CodexConversationItem = {
      threadId: "thread_1",
      turnId: "turn_model",
      itemId: "spawn",
      entryId: "spawn",
      type: "collabAgentToolCall",
      kind: "toolCall",
      semanticKind: "multiAgentAction",
      status: "completed",
      createdAt: 1,
      updatedAt: 1,
      rawItem: {
        id: "spawn",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "thread_1",
        receiverThreads: [
          { threadId: "child", thread: { nickname: "Scout", model: "child-model" } },
        ],
        prompt: "Inspect the project",
        model: null,
        agentsStates: {},
      },
    };
    const entry = buildVisibleTurnEntry(
      buildTurn("turn_model", "Inspect", "Done", {
        items: [item],
        itemIds: ["spawn"],
      }),
      [],
      true,
    );
    const models: Array<string | null | undefined> = [];
    const onOpenThread: ThreadStageActions["onOpenThread"] = (_id, context) => {
      models.push(context?.subagent?.spawnModel);
    };
    const content = (parentModel: string) => (
      <TooltipProvider>
        <LocalConversationTurnEntry
          conversationId="thread_1"
          entry={entry}
          cwd="/tmp/project"
          canEditTurnUserPrefix={false}
          canForkTurn={false}
          persistedCollapsed={false}
          parentModel={parentModel}
          onOpenThread={onOpenThread}
        />
      </TooltipProvider>
    );
    const view = render(content("parent-model-a"));
    await act(async () => {
      fireEvent.click(view.getByTestId("multi-agent-action-header").querySelector("button")!);
    });
    await settleAsyncRender();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Open subagent Scout" }));
    });
    view.rerender(content("parent-model-b"));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Open subagent Scout" }));
    });
    expect(models).toEqual(["parent-model-a", "parent-model-b"]);
  });

  test("renders a resolved timestamp separator before the owning turn", async () => {
    const stableRequests: [] = [];
    const { LocalConversationTurnEntry } = await import("./local-conversation-turn-entry");
    const sentAtMs = Date.now() - 2 * 60 * 60 * 1_000;
    const entry = buildVisibleTurnEntry(
      buildTurn("turn_timestamp_separator", "Continue the audit", "Done"),
      stableRequests,
      true,
    );
    entry.timestampSeparatorAtMs = sentAtMs;
    const view = render(
      createElement(LocalConversationTurnEntry, {
        conversationId: "thread_1",
        entry,
        cwd: "/tmp/project",
        canEditTurnUserPrefix: false,
        canForkTurn: false,
      }),
    );

    const separator = view.getByRole("separator");
    const turnContent = view.container.querySelector("[data-virtualized-turn-content]");
    expect(separator.querySelector("time")?.dateTime).toBe(new Date(sentAtMs).toISOString());
    expect(
      separator.compareDocumentPosition(turnContent as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  test("renders user copy time and optional edit without a user fork action", async () => {
    const stableRequests: [] = [];
    const { LocalConversationTurnEntry } = await import("./local-conversation-turn-entry");
    const sentAtMs = 180_000;
    const staleStartedAtMs = 999_000;
    const turn = buildTurn("turn_actions", "Copy this request", "Done", {
      turnStartedAtMs: sentAtMs,
      startedAt: staleStartedAtMs,
      completedAt: 999_000,
    });
    const expectedTime = formatThreadMessageTimestamp(sentAtMs);
    const staleStartedTime = formatThreadMessageTimestamp(staleStartedAtMs);
    if (expectedTime === null || staleStartedTime === null) {
      throw new Error("expected finite user timestamps");
    }
    const view = render(
      createElement(
        TooltipProvider,
        null,
        createElement(LocalConversationTurnEntry, {
          conversationId: "thread_1",
          entry: buildVisibleTurnEntry(turn, stableRequests, true),
          cwd: "/tmp/project",
          canEditTurnUserPrefix: true,
          canForkTurn: true,
          onOpenSideChat: async () => {},
        }),
      ),
    );

    expect(view.getAllByLabelText("Copy message").length > 0).toBe(true);
    expect(Boolean(view.getByLabelText("Edit message"))).toBe(true);
    expect(view.queryByLabelText("Fork from this message") === null).toBe(true);
    expect(view.queryByLabelText("Ask in side chat") === null).toBe(true);
    expect(Boolean(view.container.textContent?.includes(expectedTime))).toBe(true);
    expect(Boolean(view.container.textContent?.includes(staleStartedTime))).toBe(false);
  });

  test("renders Codex goal status below goal user messages", async () => {
    const stableRequests: [] = [];
    const { LocalConversationTurnEntry } = await import("./local-conversation-turn-entry");
    const turn = buildTurn("turn_goal_user_status", "Keep working toward parity", "Done", {
      items: [
        buildUserEntry(
          "turn_goal_user_status",
          "turn_goal_user_status_user",
          "Keep working toward parity",
          {
            goal: true,
          },
        ),
        buildAssistantEntry("turn_goal_user_status", "turn_goal_user_status_assistant", "Done"),
      ],
    });
    const view = render(
      createElement(
        TooltipProvider,
        null,
        createElement(LocalConversationTurnEntry, {
          conversationId: "thread_1",
          entry: buildVisibleTurnEntry(turn, stableRequests, true),
          cwd: "/tmp/project",
          canEditTurnUserPrefix: true,
          canForkTurn: false,
        }),
      ),
    );

    expect(Boolean(view.getByText("Sent as goal"))).toBe(true);

    const emptyGoalTurn = buildTurn("turn_empty_goal_user_status", "", "Done", {
      items: [
        buildUserEntry("turn_empty_goal_user_status", "turn_empty_goal_user_status_user", "", {
          goal: true,
        }),
        buildAssistantEntry(
          "turn_empty_goal_user_status",
          "turn_empty_goal_user_status_assistant",
          "Done",
        ),
      ],
    });

    view.rerender(
      createElement(
        TooltipProvider,
        null,
        createElement(LocalConversationTurnEntry, {
          conversationId: "thread_1",
          entry: buildVisibleTurnEntry(emptyGoalTurn, stableRequests, true),
          cwd: "/tmp/project",
          canEditTurnUserPrefix: true,
          canForkTurn: false,
        }),
      ),
    );

    expect(Boolean(view.getByText("Sent as goal"))).toBe(true);
    expect(view.queryByLabelText("Copy message") === null).toBe(true);
  });

  test("renders pending and accepted steering bubbles without lifecycle labels", async () => {
    const stableRequests: [] = [];
    const { LocalConversationTurnEntry } = await import("./local-conversation-turn-entry");
    const turn: CodexConversationTurn = {
      ...buildTurn("turn_steer", "Initial request", "Working"),
      status: "inProgress",
      itemIds: [
        "turn_steer_user",
        "turn_steer_assistant",
        "steer_pending",
        "steer_accepted",
        "steered_accepted",
      ],
      items: [
        buildUserEntry("turn_steer", "turn_steer_user", "Initial request"),
        buildAssistantEntry("turn_steer", "turn_steer_assistant", "Working", {
          status: "inProgress",
        }),
        buildSteeringEntry("turn_steer", "steer_pending", "Try the compact path.", "pending"),
        buildSteeringEntry("turn_steer", "steer_accepted", "Tighten the layout.", "accepted"),
        buildSteeredEntry("turn_steer", "steered_accepted"),
      ],
    };

    const view = render(
      createElement(
        TooltipProvider,
        null,
        createElement(LocalConversationTurnEntry, {
          conversationId: "thread_1",
          entry: buildVisibleTurnEntry(turn, stableRequests, true),
          cwd: "/tmp/project",
          canEditTurnUserPrefix: false,
          canForkTurn: false,
        }),
      ),
    );

    expect(Boolean(view.container.textContent?.includes("Try the compact path."))).toBe(true);
    expect(Boolean(view.container.textContent?.includes("Tighten the layout."))).toBe(true);
    expect(view.queryByText("Steering conversation")).toBeNull();
    expect(view.queryByText("Steered conversation")).toBeNull();
  });

  test("renders copy before fork and forks with an empty composer draft", async () => {
    const stableRequests: [] = [];
    const forkInputs: Array<{
      threadId: string;
      turnId: string;
      message: string;
      isLatestTurn: boolean;
    }> = [];
    const { LocalConversationTurnEntry } = await import("./local-conversation-turn-entry");
    const sentAtMs = 180_000;
    const staleCompletedAtMs = 999_000;
    const turn = buildTurn("turn_assistant_actions", "Request", "Assistant reply", {
      turnStartedAtMs: 90_000,
      finalAssistantStartedAtMs: sentAtMs,
      completedAt: staleCompletedAtMs,
    });
    const expectedTime = formatThreadMessageTimestamp(sentAtMs);
    const staleCompletedTime = formatThreadMessageTimestamp(staleCompletedAtMs);
    if (expectedTime === null || staleCompletedTime === null) {
      throw new Error("expected finite assistant timestamps");
    }
    const view = render(
      createElement(
        TooltipProvider,
        null,
        createElement(LocalConversationTurnEntry, {
          conversationId: "thread_1",
          entry: buildVisibleTurnEntry(turn, stableRequests, false),
          cwd: "/tmp/project",
          canEditTurnUserPrefix: false,
          canForkTurn: true,
          onForkTurnMessage: (input) => {
            forkInputs.push(input);
          },
        }),
      ),
    );

    const labels = Array.from(view.container.querySelectorAll("button[aria-label]")).map(
      (button) => button.getAttribute("aria-label") ?? "",
    );
    const assistantCopyIndex = labels.lastIndexOf("Copy");
    const forkIndex = labels.indexOf("Fork chat from here");

    expect(assistantCopyIndex >= 0).toBe(true);
    expect(forkIndex > assistantCopyIndex).toBe(true);
    expect(labels.includes("Ask in side chat")).toBe(false);
    expect(Boolean(view.container.textContent?.includes(expectedTime))).toBe(true);
    expect(Boolean(view.container.textContent?.includes(staleCompletedTime))).toBe(false);

    const turnRoot = view.container.querySelector(
      '[data-content-search-turn-key="turn_assistant_actions"]',
    );
    if (turnRoot === null) {
      throw new Error("expected turn root");
    }

    await act(async () => {
      fireEvent.click(view.getByLabelText("Fork chat from here"));
      await Promise.resolve();
    });
    expect(forkInputs.length).toBe(1);
    expect(forkInputs[0]?.turnId).toBe("turn_assistant_actions");
    expect(forkInputs[0]?.message).toBe("");
    expect(forkInputs[0]?.isLatestTurn).toBe(false);
  });

  test("nests completed turn diff before assistant actions inside the final assistant DOM", async () => {
    const stableRequests: [] = [];
    const { LocalConversationTurnEntry } = await import("./local-conversation-turn-entry");
    const turn = buildTurn("turn_diff_after", "Request", "Assistant reply", {
      diff: ["--- a/src/one.ts", "+++ b/src/one.ts", "@@ -1 +1 @@", "-old", "+new"].join("\n"),
      finalAssistantStartedAtMs: 180_000,
    });
    const view = render(
      createElement(
        TooltipProvider,
        null,
        createElement(LocalConversationTurnEntry, {
          conversationId: "thread_1",
          entry: buildVisibleTurnEntry(turn, stableRequests, true),
          cwd: "/tmp/project",
          canEditTurnUserPrefix: false,
          canForkTurn: true,
        }),
      ),
    );

    const finalAssistant = view.container.querySelector(
      '[data-local-conversation-final-assistant="true"]',
    );
    const diffCard = finalAssistant?.querySelector(
      '[data-assistant-after-blocks="turn_diff_after_assistant"]',
    );
    const copyButton = finalAssistant?.querySelector('button[aria-label="Copy"]');
    if (
      !(finalAssistant instanceof HTMLElement) ||
      !(diffCard instanceof HTMLElement) ||
      !(copyButton instanceof HTMLElement)
    ) {
      throw new Error("expected final assistant wrapper, assistant-after diff, and copy button");
    }

    expect(Boolean(diffCard.textContent?.includes("Edited"))).toBe(true);
    expect(
      Boolean(diffCard.compareDocumentPosition(copyButton) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
  });

  test("hides streaming actions and permits forking an empty completed reply", async () => {
    const stableRequests: [] = [];
    const { LocalConversationTurnEntry } = await import("./local-conversation-turn-entry");
    const streamingTurn: CodexConversationTurn = {
      ...buildTurn("turn_streaming", "Request", "Streaming reply"),
      status: "inProgress",
      items: [
        buildUserEntry("turn_streaming", "turn_streaming_user", "Request"),
        buildAssistantEntry("turn_streaming", "turn_streaming_assistant", "Streaming reply", {
          status: "inProgress",
        }),
      ],
    };
    const emptyTurn = buildTurn("turn_empty", "Request", "");
    const view = render(
      createElement(
        TooltipProvider,
        null,
        createElement(LocalConversationTurnEntry, {
          conversationId: "thread_1",
          entry: buildVisibleTurnEntry(streamingTurn, stableRequests, true),
          cwd: "/tmp/project",
          canEditTurnUserPrefix: false,
          canForkTurn: true,
          onForkTurnMessage: () => {},
        }),
      ),
    );

    expect(view.queryByLabelText("Copy")).toBeNull();
    expect(view.queryByLabelText("Fork chat from here") === null).toBe(true);

    view.rerender(
      createElement(
        TooltipProvider,
        null,
        createElement(LocalConversationTurnEntry, {
          conversationId: "thread_1",
          entry: buildVisibleTurnEntry(emptyTurn, stableRequests, true),
          cwd: "/tmp/project",
          canEditTurnUserPrefix: false,
          canForkTurn: true,
          onForkTurnMessage: () => {},
        }),
      ),
    );

    expect(view.queryByLabelText("Copy")).toBeNull();
    expect(Boolean(view.getByLabelText("Fork chat from here"))).toBe(true);
  });

  test("renders historical collapsed agent body as worked duration instead of previous messages", async () => {
    const stableRequests: [] = [];
    const { LocalConversationTurnEntry } = await import("./local-conversation-turn-entry");
    const turn: CodexConversationTurn = {
      ...buildTurn("turn_worked_for", "Request", "Done"),
      durationMs: 125_000,
      itemIds: ["turn_worked_for_user", "exec_1", "turn_worked_for_assistant"],
      items: [
        buildUserEntry("turn_worked_for", "turn_worked_for_user", "Request"),
        {
          threadId: "thread_1",
          turnId: "turn_worked_for",
          itemId: "exec_1",
          type: "command_execution",
          kind: "commandExecution",
          semanticKind: "exec",
          createdAt: 2,
          updatedAt: 2,
          status: "completed",
          commandActions: [{ type: "read", command: "", name: "src/app.ts", path: "src/app.ts" }],
          toolCall: {
            subtype: "command",
            toolName: "exec_command",
            args: {},
          },
        },
        buildAssistantEntry("turn_worked_for", "turn_worked_for_assistant", "Done", {
          assistantPhase: "final_answer",
          status: "completed",
        }),
      ],
    };
    const view = render(
      createElement(
        TooltipProvider,
        null,
        createElement(LocalConversationTurnEntry, {
          conversationId: "thread_1",
          entry: buildVisibleTurnEntry(turn, stableRequests, false),
          cwd: "/tmp/project",
          canEditTurnUserPrefix: false,
          canForkTurn: true,
        }),
      ),
    );

    expect(Boolean(view.container.textContent?.includes("Worked for 2m 5s"))).toBe(true);
    expect(Boolean(view.container.textContent?.includes("previous messages"))).toBe(false);

    const workedForButton = view.getByRole("button", { name: /Worked for 2m 5s/ });
    expect(workedForButton.getAttribute("aria-expanded")).toBe("false");

    const workedForTextOuter = workedForButton.firstElementChild;
    const workedForTextInner = workedForTextOuter?.firstElementChild;
    expect(workedForTextOuter?.tagName).toBe("SPAN");
    expect(workedForTextInner?.tagName).toBe("SPAN");

    const workedForShell = workedForButton.parentElement?.parentElement;
    expect(workedForShell?.contains(workedForButton)).toBe(true);
  });

  test("keeps the reply visible when settled delegated work after it collapses", async () => {
    const { LocalConversationTurnEntry } = await import("./local-conversation-turn-entry");
    const turnId = "turn_reply_before_delegated_work";
    const turn: CodexConversationTurn = {
      ...buildTurn(turnId, "Run the workflow", "Workflow complete"),
      durationMs: 4_000,
      itemIds: [`${turnId}_user`, "exec_workspace", `${turnId}_assistant`, "task_inspect"],
      items: [
        buildUserEntry(turnId, `${turnId}_user`, "Run the workflow"),
        {
          threadId: "thread_1",
          turnId,
          itemId: "exec_workspace",
          type: "command_execution",
          kind: "commandExecution",
          semanticKind: "exec",
          createdAt: 2,
          updatedAt: 2,
          status: "completed",
          commandActions: [{ type: "read", command: "", name: "src/app.ts", path: "src/app.ts" }],
          toolCall: { subtype: "command", toolName: "exec_command", args: {} },
        },
        buildAssistantEntry(turnId, `${turnId}_assistant`, "Workflow complete", {
          status: "completed",
        }),
        {
          threadId: "thread_1",
          turnId,
          itemId: "task_inspect",
          type: "delegatedTask",
          kind: "systemEvent",
          semanticKind: "delegatedTask",
          status: "completed",
          createdAt: 4,
          updatedAt: 4,
          delegatedTask: {
            taskId: "task_inspect",
            ownerRunId: turnId,
            childThreadId: "child_inspect",
            title: "Inspect workspace",
            providerInstanceId: "claude",
            status: "completed",
            prompt: "Inspect the workspace",
            summary: null,
          },
        },
      ],
    };
    let requestedCollapsed: boolean | null = null;
    const renderTurn = (persistedCollapsed?: boolean) =>
      createElement(
        TooltipProvider,
        null,
        createElement(LocalConversationTurnEntry, {
          conversationId: "thread_1",
          entry: buildVisibleTurnEntry(turn, [], true),
          cwd: "/tmp/project",
          canEditTurnUserPrefix: false,
          canForkTurn: true,
          persistedCollapsed,
          onSetCollapsed: (collapsed) => {
            requestedCollapsed = collapsed;
          },
        }),
      );
    const view = render(renderTurn());
    await act(async () => {
      await settleAsyncRender();
    });

    const workedForButton = view.getByRole("button", { name: /Worked for 4s/ });
    expect(workedForButton.getAttribute("aria-expanded")).toBe("false");
    expect(view.container.textContent?.includes("src/app.ts") ?? false).toBe(false);
    expect(view.getAllByText("Workflow complete")).toHaveLength(1);
    const reply = view.getByText("Workflow complete");
    expect(
      workedForButton.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await act(async () => {
      fireEvent.click(workedForButton);
      view.rerender(renderTurn(false));
      await settleAsyncRender();
    });

    // Expanding restores the work around the reply in canonical order without remounting it.
    expect(requestedCollapsed).toBe(false);
    expect(workedForButton.getAttribute("aria-expanded")).toBe("true");
    expect(view.getAllByText("Workflow complete")).toHaveLength(1);
    expect(view.getByText("Workflow complete")).toBe(reply);
    expect(
      view.getByText("src/app.ts").compareDocumentPosition(reply) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await act(async () => {
      view.rerender(renderTurn(true));
      await Promise.resolve();
    });

    // While the work folds away, the reply is still the one mounted copy.
    expect(workedForButton.getAttribute("aria-expanded")).toBe("false");
    expect(view.getAllByText("Workflow complete")).toHaveLength(1);
    expect(view.getByText("Workflow complete")).toBe(reply);
  });

  test("keeps steering messages visible when historical agent activity is collapsed", async () => {
    const stableRequests: [] = [];
    const { LocalConversationTurnEntry } = await import("./local-conversation-turn-entry");
    const turnId = "turn_collapsed_steering";
    const turn: CodexConversationTurn = {
      ...buildTurn(turnId, "Initial request", "All set."),
      durationMs: 125_000,
      itemIds: [
        `${turnId}_user`,
        "exec_before_steer",
        "steer_first",
        "steered_first",
        "exec_after_steer",
        "steer_second",
        "steered_second",
        `${turnId}_assistant`,
      ],
      items: [
        buildUserEntry(turnId, `${turnId}_user`, "Initial request"),
        {
          threadId: "thread_1",
          turnId,
          itemId: "exec_before_steer",
          type: "command_execution",
          kind: "commandExecution",
          semanticKind: "exec",
          createdAt: 2,
          updatedAt: 2,
          status: "completed",
          commandActions: [{ type: "read", command: "", name: "src/app.ts", path: "src/app.ts" }],
          toolCall: {
            subtype: "command",
            toolName: "exec_command",
            args: {},
          },
        },
        buildSteeringEntry(turnId, "steer_first", "Keep the existing API.", "accepted"),
        buildSteeredEntry(turnId, "steered_first"),
        {
          threadId: "thread_1",
          turnId,
          itemId: "exec_after_steer",
          type: "command_execution",
          kind: "commandExecution",
          semanticKind: "exec",
          createdAt: 5,
          updatedAt: 5,
          status: "completed",
          commandActions: [
            { type: "read", command: "", name: "src/view.tsx", path: "src/view.tsx" },
          ],
          toolCall: {
            subtype: "command",
            toolName: "exec_command",
            args: {},
          },
        },
        buildSteeringEntry(turnId, "steer_second", "Also preserve the ordering.", "accepted"),
        buildSteeredEntry(turnId, "steered_second"),
        buildAssistantEntry(turnId, `${turnId}_assistant`, "All set.", {
          assistantPhase: "final_answer",
          status: "completed",
        }),
      ],
    };
    let requestedCollapsed: boolean | null = null;
    const renderTurn = (persistedCollapsed: boolean) =>
      createElement(
        TooltipProvider,
        null,
        createElement(LocalConversationTurnEntry, {
          conversationId: "thread_1",
          entry: buildVisibleTurnEntry(turn, stableRequests, false),
          cwd: "/tmp/project",
          canEditTurnUserPrefix: false,
          canForkTurn: true,
          persistedCollapsed,
          onSetCollapsed: (collapsed) => {
            requestedCollapsed = collapsed;
          },
        }),
      );
    const view = render(renderTurn(true));

    const workedForButton = view.getByRole("button", { name: /Worked for 2m 5s/ });
    const firstSteeringMessage = view.getByText("Keep the existing API.");
    const secondSteeringMessage = view.getByText("Also preserve the ordering.");
    const finalAssistantMessage = view.getByText("All set.");
    const firstCollapsedBubble = firstSteeringMessage.closest<HTMLElement>(
      '[data-user-message-bubble="true"]',
    );
    const firstCompactRow = firstCollapsedBubble?.parentElement;
    const firstCompactGroup = firstCompactRow?.parentElement;

    expect(workedForButton.getAttribute("aria-expanded")).toBe("false");
    expect(view.queryByText("Steered conversation")).toBeNull();
    expect(view.container.textContent?.includes("src/app.ts") ?? false).toBe(false);
    expect(view.container.textContent?.includes("src/view.tsx") ?? false).toBe(false);
    expect(
      workedForButton.compareDocumentPosition(firstSteeringMessage) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      firstSteeringMessage.compareDocumentPosition(secondSteeringMessage) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      secondSteeringMessage.compareDocumentPosition(finalAssistantMessage) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(firstCompactRow?.querySelector('button[aria-label="Copy message"]')).not.toBeNull();
    expect(firstCompactRow?.lastElementChild).toBe(firstCollapsedBubble);
    expect(firstCompactGroup?.children).toHaveLength(1);

    await act(async () => {
      fireEvent.click(workedForButton);
      view.rerender(renderTurn(false));
      await settleAsyncRender();
    });

    expect(requestedCollapsed).toBe(false);
    expect(workedForButton.getAttribute("aria-expanded")).toBe("true");
    expect(view.getAllByText("Worked for 2m 5s")).toHaveLength(1);
    expect(view.queryByText("Steered conversation")).toBeNull();
    expect(view.container.textContent?.includes("src/app.ts") ?? false).toBe(true);
    expect(view.container.textContent?.includes("src/view.tsx") ?? false).toBe(true);
    expect(view.getAllByText("Keep the existing API.")).toHaveLength(1);
    expect(view.getAllByText("Also preserve the ordering.")).toHaveLength(1);
    const firstExpandedBubble = view
      .getByText("Keep the existing API.")
      .closest<HTMLElement>('[data-user-message-bubble="true"]');
    const firstExpandedGroup = firstExpandedBubble?.parentElement;
    expect(firstExpandedGroup?.children).toHaveLength(2);
    expect(
      firstExpandedBubble?.nextElementSibling?.querySelector('button[aria-label="Copy message"]'),
    ).not.toBeNull();

    await act(async () => {
      fireEvent.click(workedForButton);
      view.rerender(renderTurn(true));
    });

    expect(requestedCollapsed).toBe(true);
    expect(workedForButton.getAttribute("aria-expanded")).toBe("false");
    expect(view.container.textContent?.includes("src/app.ts") ?? false).toBe(false);
    expect(view.container.textContent?.includes("src/view.tsx") ?? false).toBe(false);
    expect(view.getAllByText("Keep the existing API.")).toHaveLength(1);
    expect(view.getAllByText("Also preserve the ordering.")).toHaveLength(1);
  });

  test("renders first-turn worktree initialization beneath worked time and before the assistant", async () => {
    const stableRequests: [] = [];
    const { LocalConversationTurnEntry } = await import("./local-conversation-turn-entry");
    const turnId = "turn_worktree_init";
    const worktreeItem: CodexConversationItem = {
      threadId: "thread_1",
      turnId,
      itemId: "worktree_init",
      type: "worktreeInit",
      kind: "systemEvent",
      semanticKind: "worktreeInit",
      status: "completed",
      rawItem: {
        id: "worktree_init",
        type: "worktreeInit",
        worktreeOutputText: [
          "[info] Starting worktree creation",
          "Worktree created at /tmp/worktrees/task",
          "No local environment selected",
        ].join("\n"),
        setup: null,
      },
      createdAt: 1,
      updatedAt: 1,
    };
    const userItem = buildUserEntry(turnId, "worktree_user", "hi");
    const assistantItem = buildAssistantEntry(
      turnId,
      "worktree_assistant",
      "Hi! What would you like to work on?",
      { assistantPhase: "final_answer", status: "completed" },
    );
    const turn: CodexConversationTurn = {
      threadId: "thread_1",
      turnId,
      status: "completed",
      durationMs: 10_000,
      itemIds: [worktreeItem.itemId, userItem.itemId, assistantItem.itemId],
      items: [worktreeItem, userItem, assistantItem],
    };
    const renderWorktreeTurn = (persistedCollapsed?: boolean) =>
      createElement(
        TooltipProvider,
        null,
        createElement(LocalConversationTurnEntry, {
          conversationId: "thread_1",
          entry: buildVisibleTurnEntry(turn, stableRequests, true),
          cwd: "/tmp/worktrees/task",
          canEditTurnUserPrefix: false,
          canForkTurn: false,
          persistedCollapsed,
        }),
      );
    const view = render(renderWorktreeTurn());

    const userMessage = view.getByText("hi");
    const workedForButton = view.getByRole("button", { name: "Worked for 10s" });
    expect(workedForButton.getAttribute("aria-expanded")).toBe("false");
    expect(view.queryByRole("button", { name: "Worktree created" })).toBe(null);

    view.rerender(renderWorktreeTurn(false));

    const worktreeButton = view.getByRole("button", { name: "Worktree created" });
    const assistantMessage = view.getByText("Hi! What would you like to work on?");
    expect(
      userMessage.compareDocumentPosition(worktreeButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      worktreeButton.compareDocumentPosition(assistantMessage) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(worktreeButton.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      fireEvent.click(worktreeButton);
      await settleAsyncRender();
    });
    expect(worktreeButton.getAttribute("aria-expanded")).toBe("true");
    expect(view.getByText(/No local environment selected/)).toBeTruthy();
  });

  test("renders active working-for as a plain divider without a toggle button", async () => {
    const stableRequests: [] = [];
    const { LocalConversationTurnEntry } = await import("./local-conversation-turn-entry");
    const startedAtMs = Date.now() - 65_000;
    const turn: CodexConversationTurn = {
      ...buildTurn("turn_working_for", "Request", ""),
      status: "inProgress",
      firstTurnWorkItemStartedAtMs: startedAtMs,
      itemIds: ["turn_working_for_user", "exec_1"],
      items: [
        buildUserEntry("turn_working_for", "turn_working_for_user", "Request"),
        {
          threadId: "thread_1",
          turnId: "turn_working_for",
          itemId: "exec_1",
          type: "command_execution",
          kind: "commandExecution",
          semanticKind: "exec",
          createdAt: startedAtMs,
          updatedAt: startedAtMs,
          status: "inProgress",
          commandActions: [{ type: "unknown", command: "bun test" }],
          toolCall: {
            subtype: "command",
            toolName: "exec_command",
            args: {},
          },
        },
      ],
    };
    const view = render(
      createElement(
        TooltipProvider,
        null,
        createElement(LocalConversationTurnEntry, {
          conversationId: "thread_1",
          entry: buildVisibleTurnEntry(turn, stableRequests, true),
          cwd: "/tmp/project",
          canEditTurnUserPrefix: false,
          canForkTurn: true,
        }),
      ),
    );

    expect(Boolean(view.container.textContent?.includes("Working for 1m 5s"))).toBe(true);
    expect(view.queryByRole("button", { name: /Working/ }) === null).toBe(true);

    const workingText = view.getByText("Working for 1m 5s");
    expect(Boolean(workingText.parentElement?.textContent?.includes("previous messages"))).toBe(
      false,
    );
  });

  test("does not rerender unchanged older turns when a different turn updates", async () => {
    const stableRequests: [] = [];
    const recordRender = (turnId: string) => {
      renderCounts.set(turnId, (renderCounts.get(turnId) ?? 0) + 1);
    };
    const olderTurn = buildTurn("turn_older", "Older request", "Older reply");
    const latestTurn = buildTurn("turn_latest", "Latest request", "Latest reply");
    const nextLatestTurn = buildTurn(
      "turn_latest",
      "Latest request",
      "Latest reply with streamed delta",
    );
    const { LocalConversationTurnEntry } = await import("./local-conversation-turn-entry");

    function Probe({
      older,
      latest,
    }: {
      older: CodexConversationTurn;
      latest: CodexConversationTurn;
    }) {
      return createElement(
        "div",
        null,
        createElement(LocalConversationTurnEntry, {
          conversationId: "thread_1",
          entry: buildVisibleTurnEntry(older, stableRequests, false),
          cwd: "/tmp/project",
          canEditTurnUserPrefix: false,
          canForkTurn: true,
          onRendered: recordRender,
        }),
        createElement(LocalConversationTurnEntry, {
          conversationId: "thread_1",
          entry: buildVisibleTurnEntry(latest, stableRequests, true),
          cwd: "/tmp/project",
          canEditTurnUserPrefix: true,
          canForkTurn: true,
          onRendered: recordRender,
        }),
      );
    }

    const view = render(
      createElement(
        TooltipProvider,
        null,
        createElement(Probe, { older: olderTurn, latest: latestTurn }),
      ),
    );
    expect(renderCounts.get("turn_older")).toBe(1);
    expect(renderCounts.get("turn_latest")).toBe(1);

    view.rerender(
      createElement(
        TooltipProvider,
        null,
        createElement(Probe, { older: olderTurn, latest: nextLatestTurn }),
      ),
    );

    expect(renderCounts.get("turn_older")).toBe(1);
    expect(renderCounts.get("turn_latest")).toBe(2);
  });

  test("renders user image attachments in a strip before the message bubble", async () => {
    const stableRequests: [] = [];
    const { LocalConversationTurnEntry } = await import("./local-conversation-turn-entry");
    const turn: CodexConversationTurn = {
      threadId: "thread_1",
      turnId: "turn_images",
      status: "completed",
      itemIds: ["user_images", "assistant_images"],
      items: [
        {
          ...buildUserEntry("turn_images", "user_images", "Inspect these images"),
          userAttachments: [
            {
              type: "file",
              id: "user_images:file:0",
              label: "notes.md",
              path: "/tmp/notes.md",
              sourceKind: "mention",
            },
            {
              type: "image",
              id: "user_images:image:0",
              source: "data:image/png;base64,aW1hZ2U=",
              sourceKind: "inline-image",
              caption: "diagram",
            },
          ],
        },
        buildAssistantEntry("turn_images", "assistant_images", "Done"),
      ],
    };

    const view = render(
      createElement(
        TooltipProvider,
        null,
        createElement(LocalConversationTurnEntry, {
          conversationId: "thread_1",
          entry: buildVisibleTurnEntry(turn, stableRequests, true),
          cwd: "/tmp/project",
          canEditTurnUserPrefix: true,
          canForkTurn: true,
        }),
      ),
    );

    const strip = view.container.querySelector("[data-user-attachment-strip]");
    const bubble = view.getByText("Inspect these images").closest("[data-user-message-bubble]");
    if (!(strip instanceof HTMLElement) || !(bubble instanceof HTMLElement)) {
      throw new Error("expected attachment strip and user bubble");
    }

    expect(view.getByText("notes.md")).toBeTruthy();
    expect(Boolean(strip.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
      true,
    );
    expect(strip.querySelector("img") !== null).toBe(true);

    const previewTrigger = view.getByLabelText("Open image preview");
    await act(async () => {
      fireEvent.click(previewTrigger);
      await settleAsyncRender();
    });
    const preview = document.body.querySelector('[data-slot="codex-dialog-content"] img');
    if (!(preview instanceof HTMLImageElement)) {
      throw new Error("expected image preview dialog");
    }
    expect(preview.src.startsWith("data:image/png;base64")).toBe(true);
  });

  test.each([
    { source: "native pending", steeringStatus: "pending" as const },
    { source: "native accepted", steeringStatus: "accepted" as const },
    { source: "Runtime steer", userInputIntent: "steer" as const },
    { source: "promoted queue", userInputIntent: "promotedToSteer" as const },
  ])(
    "keeps $source image messages visible through completion and activity collapse",
    async (delivery) => {
      const { LocalConversationTurnEntry } = await import("./local-conversation-turn-entry");
      const turnId = "turn_steering_images";
      const imageSource = "data:image/png;base64,aW1hZ2U=";
      const imageMessage = buildUserEntry(turnId, "image-steer", "", {
        ...("steeringStatus" in delivery
          ? { type: "steeringUserMessage", steeringStatus: delivery.steeringStatus }
          : { userInputIntent: delivery.userInputIntent }),
        userAttachments: [
          {
            type: "image",
            id: "image-steer:image",
            source: imageSource,
            sourceKind: "inline-image",
            caption: "Steering diagram",
          },
        ],
      });
      const activity: CodexConversationItem = {
        threadId: "thread_1",
        turnId,
        itemId: "image-work",
        type: "command_execution",
        kind: "commandExecution",
        semanticKind: "exec",
        createdAt: 2,
        updatedAt: 2,
        status: "completed",
        commandActions: [{ type: "read", command: "", name: "diagram.ts", path: "diagram.ts" }],
        toolCall: { subtype: "command", toolName: "exec_command", args: {} },
      };
      const turn: CodexConversationTurn = {
        ...buildTurn(turnId, "Inspect the diagram", "Reviewed"),
        durationMs: 125_000,
        itemIds: [`${turnId}_user`, "image-work", "image-steer", `${turnId}_assistant`],
        items: [
          buildUserEntry(turnId, `${turnId}_user`, "Inspect the diagram"),
          activity,
          imageMessage,
          buildAssistantEntry(turnId, `${turnId}_assistant`, "Reviewed", {
            assistantPhase: "final_answer",
            status: "completed",
          }),
        ],
      };
      const renderTurn = (running: boolean, collapsed: boolean) =>
        createElement(
          TooltipProvider,
          null,
          createElement(LocalConversationTurnEntry, {
            conversationId: "thread_1",
            entry: buildVisibleTurnEntry(
              { ...turn, status: running ? "inProgress" : "completed" },
              [],
              running,
            ),
            cwd: "/tmp/project",
            canEditTurnUserPrefix: false,
            canForkTurn: true,
            persistedCollapsed: collapsed,
          }),
        );
      const view = render(renderTurn(true, false));
      expect((await view.findByRole("img", { name: "User attachment" })).getAttribute("src")).toBe(
        imageSource,
      );
      expect(view.getAllByRole("button", { name: "Open image preview" })).toHaveLength(1);

      await act(async () => {
        view.rerender(renderTurn(false, true));
        await settleAsyncRender();
      });
      expect(
        view.getByRole("button", { name: /Worked for 2m 5s/ }).getAttribute("aria-expanded"),
      ).toBe("false");
      expect(view.getByRole("img", { name: "User attachment" }).getAttribute("src")).toBe(
        imageSource,
      );
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Open image preview" }));
        await settleAsyncRender();
      });
      expect(
        document.body.querySelector('[data-slot="codex-dialog-content"] img')?.getAttribute("src"),
      ).toBe(imageSource);
    },
  );

  test("renders assistant before later exec rows inside the agent body when exec arrives after it", async () => {
    const stableRequests: [] = [];
    const { LocalConversationTurnEntry } = await import("./local-conversation-turn-entry");
    const assistantOnlyTurn: CodexConversationTurn = {
      threadId: "thread_1",
      turnId: "turn_latest",
      status: "inProgress",
      itemIds: ["assistant_1"],
      items: [
        buildAssistantEntry("turn_latest", "assistant_1", "Done", {
          assistantPhase: "final_answer",
          status: "inProgress",
        }),
      ],
    };
    const assistantThenExecTurn: CodexConversationTurn = {
      ...assistantOnlyTurn,
      itemIds: ["assistant_1", "exec_1"],
      items: [
        ...assistantOnlyTurn.items,
        {
          threadId: "thread_1",
          turnId: "turn_latest",
          itemId: "exec_1",
          type: "command_execution",
          kind: "commandExecution",
          semanticKind: "exec",
          createdAt: 3,
          updatedAt: 3,
          status: "inProgress",
          toolCall: {
            subtype: "command",
            toolName: "exec_command",
          },
        },
      ],
    };

    const view = render(
      createElement(
        TooltipProvider,
        null,
        createElement(LocalConversationTurnEntry, {
          conversationId: "thread_1",
          entry: buildVisibleTurnEntry(assistantOnlyTurn, stableRequests, true),
          cwd: "/tmp/project",
          canEditTurnUserPrefix: true,
          canForkTurn: true,
        }),
      ),
    );

    view.rerender(
      createElement(
        TooltipProvider,
        null,
        createElement(LocalConversationTurnEntry, {
          conversationId: "thread_1",
          entry: buildVisibleTurnEntry(assistantThenExecTurn, stableRequests, true),
          cwd: "/tmp/project",
          canEditTurnUserPrefix: true,
          canForkTurn: true,
        }),
      ),
    );

    const assistantAfter = view.container.querySelector(
      '[data-content-search-unit-key="turn_latest:assistant:assistant_1"]',
    );
    if (!(assistantAfter instanceof HTMLElement)) {
      throw new Error("expected assistant body after exec");
    }
    const activityToggle = view.container.querySelector<HTMLButtonElement>("button[aria-expanded]");
    if (!(activityToggle instanceof HTMLElement)) {
      throw new Error("expected activity summary toggle");
    }
    await act(async () => {
      fireEvent.click(activityToggle);
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
    });
    const execToggle = view.container.querySelector(
      "[data-testid='command-tool-summary-toggle'] > button",
    );
    if (!(execToggle instanceof HTMLElement)) {
      throw new Error("expected exec summary toggle");
    }

    expect(Boolean(view.container.textContent?.includes("Done"))).toBe(true);
    expect(Boolean(view.container.textContent?.includes("Final message"))).toBe(false);
    expect(
      Boolean(
        assistantAfter.compareDocumentPosition(execToggle) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
  });

  test("keeps the latest-assistant search unit when later exploration rows are grouped inline", async () => {
    const stableRequests: [] = [];
    const { LocalConversationTurnEntry } = await import("./local-conversation-turn-entry");
    const assistantOnlyTurn: CodexConversationTurn = {
      threadId: "thread_1",
      turnId: "turn_latest",
      status: "inProgress",
      itemIds: ["assistant_1"],
      items: [
        buildAssistantEntry("turn_latest", "assistant_1", "Done", {
          assistantPhase: "final_answer",
          status: "inProgress",
        }),
      ],
    };
    const assistantThenExploreTurn: CodexConversationTurn = {
      ...assistantOnlyTurn,
      itemIds: ["assistant_1", "exec_1", "reasoning_1"],
      items: [
        ...assistantOnlyTurn.items,
        {
          threadId: "thread_1",
          turnId: "turn_latest",
          itemId: "exec_1",
          type: "command_execution",
          kind: "commandExecution",
          semanticKind: "exec",
          createdAt: 3,
          updatedAt: 3,
          status: "completed",
          commandActions: [{ type: "read", command: "", name: "src/app.ts", path: "src/app.ts" }],
          toolCall: {
            subtype: "command",
            toolName: "exec_command",
            args: {},
          },
        },
        {
          threadId: "thread_1",
          turnId: "turn_latest",
          itemId: "reasoning_1",
          type: "reasoning",
          kind: "reasoning",
          semanticKind: "reasoning",
          createdAt: 4,
          updatedAt: 4,
          status: "inProgress",
          markdownText: "**Checking the file.**",
        },
      ],
    };

    const view = render(
      createElement(
        TooltipProvider,
        null,
        createElement(LocalConversationTurnEntry, {
          conversationId: "thread_1",
          entry: buildVisibleTurnEntry(assistantOnlyTurn, stableRequests, true),
          cwd: "/tmp/project",
          canEditTurnUserPrefix: true,
          canForkTurn: true,
        }),
      ),
    );

    view.rerender(
      createElement(
        TooltipProvider,
        null,
        createElement(LocalConversationTurnEntry, {
          conversationId: "thread_1",
          entry: buildVisibleTurnEntry(assistantThenExploreTurn, stableRequests, true),
          cwd: "/tmp/project",
          canEditTurnUserPrefix: true,
          canForkTurn: true,
        }),
      ),
    );

    const assistantAfter = view.container.querySelector(
      '[data-content-search-unit-key="turn_latest:assistant:assistant_1"]',
    );
    if (!(assistantAfter instanceof HTMLElement)) {
      throw new Error("expected assistant body after exploration rows");
    }
    const activityButton = view.getByRole("button", { name: "Checking the file." });
    await act(async () => {
      fireEvent.click(activityButton);
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(Boolean(view.container.textContent?.includes("Done"))).toBe(true);
    expect(Boolean(view.container.textContent?.includes("Read src/app.ts"))).toBe(true);
    expect(Boolean(view.container.textContent?.includes("Final message"))).toBe(false);
  });

  test("renders stopped-turn tool activity before deferred assistant actions", async () => {
    const stableRequests: [] = [];
    const { LocalConversationTurnEntry } = await import("./local-conversation-turn-entry");
    const turn: CodexConversationTurn = {
      threadId: "thread_1",
      turnId: "turn_stopped_order",
      status: "completed",
      itemIds: ["assistant_1", "exec_1"],
      finalAssistantStartedAtMs: 180_000,
      items: [
        buildAssistantEntry("turn_stopped_order", "assistant_1", "Done", {
          assistantPhase: "final_answer",
          status: "completed",
          createdAt: 1,
          updatedAt: 1,
        }),
        {
          threadId: "thread_1",
          turnId: "turn_stopped_order",
          itemId: "exec_1",
          type: "command_execution",
          kind: "commandExecution",
          semanticKind: "exec",
          createdAt: 2,
          updatedAt: 2,
          status: "completed",
          commandActions: [{ type: "read", command: "", name: "read", path: "src/app.ts" }],
          toolCall: {
            subtype: "command",
            toolName: "exec_command",
            args: {},
          },
        },
      ],
    };

    const view = render(
      createElement(
        TooltipProvider,
        null,
        createElement(LocalConversationTurnEntry, {
          conversationId: "thread_1",
          entry: buildVisibleTurnEntry(turn, stableRequests, true),
          cwd: "/tmp/project",
          canEditTurnUserPrefix: false,
          canForkTurn: true,
          onForkTurnMessage: () => {},
        }),
      ),
    );

    const assistantBlock = view.container.querySelector(
      '[data-content-search-unit-key="turn_stopped_order:assistant:assistant_1"]',
    );
    const explorationLink = view.getByRole("link", { name: "read" });
    const copyButton = view.getByLabelText("Copy");
    const actionAnchor = view.container.querySelector(
      '[data-assistant-actions-anchor="assistant_1"]',
    );
    if (
      !(assistantBlock instanceof HTMLElement) ||
      !(explorationLink instanceof HTMLElement) ||
      !(copyButton instanceof HTMLElement) ||
      !(actionAnchor instanceof HTMLElement)
    ) {
      throw new Error("expected stopped assistant, exploration group, and deferred action anchor");
    }

    expect(assistantBlock.querySelector('[aria-label="Copy"]') === null).toBe(true);
    expect(
      Boolean(
        assistantBlock.compareDocumentPosition(explorationLink) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    expect(
      Boolean(
        explorationLink.compareDocumentPosition(actionAnchor) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    expect(
      Boolean(
        explorationLink.compareDocumentPosition(copyButton) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    expect(Boolean(view.getByLabelText("Fork chat from here"))).toBe(true);
  });
});

describe("Thoughts in a Turn", () => {
  const prose =
    "I need to check whether the status label stays on one line. The group header renders the " +
    "summary inside an inline span, so a long paragraph could wrap across the Thread.";

  function buildThoughtEntry(
    turnId: string,
    itemId: string,
    markdownText: string,
    overrides: Partial<CodexConversationItem> = {},
  ): CodexConversationItem {
    return {
      threadId: "thread_1",
      turnId,
      itemId,
      type: "reasoning",
      kind: "reasoning",
      semanticKind: "reasoning",
      markdownText,
      status: "completed",
      createdAt: 3,
      updatedAt: 3,
      ...overrides,
    };
  }

  function buildReadEntry(turnId: string, itemId: string, path: string): CodexConversationItem {
    return {
      threadId: "thread_1",
      turnId,
      itemId,
      type: "command_execution",
      kind: "commandExecution",
      semanticKind: "exec",
      createdAt: 3,
      updatedAt: 3,
      status: "completed",
      commandActions: [{ type: "read", command: "", name: path, path }],
      toolCall: { subtype: "command", toolName: "exec_command", args: {} },
    };
  }

  async function click(element: HTMLElement) {
    await act(async () => {
      fireEvent.click(element);
      await Promise.resolve();
    });
    await settleAsyncRender();
  }

  /** Work before a reply starts folded; an opened Turn shows it. */
  async function renderTurn(turn: CodexConversationTurn) {
    const { LocalConversationTurnEntry } = await import("./local-conversation-turn-entry");
    const view = render(
      createElement(
        TooltipProvider,
        null,
        createElement(LocalConversationTurnEntry, {
          conversationId: "thread_1",
          entry: buildVisibleTurnEntry(turn, [], true),
          cwd: "/tmp/project",
          canEditTurnUserPrefix: false,
          canForkTurn: false,
          persistedCollapsed: false,
        }),
      ),
    );
    await settleAsyncRender();
    return view;
  }

  test("reads a streaming prose Thought under a one-line Thinking status", async () => {
    const turnId = "turn_prose";
    const view = await renderTurn({
      threadId: "thread_1",
      turnId,
      status: "inProgress",
      itemIds: ["user", "read", "thought"],
      items: [
        buildUserEntry(turnId, "user", "Fix the label"),
        buildReadEntry(turnId, "read", "src/app.ts"),
        buildThoughtEntry(turnId, "thought", prose, { status: "inProgress" }),
      ],
    });

    view.getByRole("button", { name: "Thinking" });
    expect(view.queryByRole("button", { name: /status label/u })).toBeNull();
    const preview = view.getByTestId("thought-live-preview");
    expect(preview.getAttribute("aria-hidden")).toBe("false");
    expect(preview.textContent).toContain("The group header renders the summary");
  });

  test("names a streaming headed Thought by its heading, without a prose preview", async () => {
    const turnId = "turn_headed";
    const view = await renderTurn({
      threadId: "thread_1",
      turnId,
      status: "inProgress",
      itemIds: ["user", "thought"],
      items: [
        buildUserEntry(turnId, "user", "Fix the label"),
        buildThoughtEntry(turnId, "thought", "**Checking the label**\n\nReading the header.", {
          status: "inProgress",
        }),
      ],
    });

    view.getByRole("button", { name: "Checking the label" });
    const preview = view.getByTestId("thought-live-preview");
    expect(preview.getAttribute("aria-hidden")).toBe("true");
    expect(preview.textContent).toBe("");
  });

  test("settles a lone Thought before the reply into a timed disclosure", async () => {
    const turnId = "turn_settled";
    const view = await renderTurn({
      threadId: "thread_1",
      turnId,
      status: "inProgress",
      itemIds: ["user", "thought", "reply"],
      items: [
        buildUserEntry(turnId, "user", "Fix the label"),
        buildThoughtEntry(turnId, "thought", prose, {
          thought: { startedAtMs: 0, durationMs: 12_000 },
        }),
        buildAssistantEntry(turnId, "reply", "Fixed.", {
          assistantPhase: "final_answer",
          status: "inProgress",
        }),
      ],
    });

    const disclosure = view.getByRole("button", { name: "Thought for 12s" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    await click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(view.getByTestId("thought-disclosure").textContent).toContain(
      "The group header renders the summary",
    );
  });

  test("lists settled Thoughts in order among the work they belong to", async () => {
    const turnId = "turn_work";
    const view = await renderTurn({
      threadId: "thread_1",
      turnId,
      status: "inProgress",
      itemIds: ["user", "read_a", "thought", "read_b", "reply"],
      items: [
        buildUserEntry(turnId, "user", "Fix the label"),
        buildReadEntry(turnId, "read_a", "src/a.ts"),
        buildThoughtEntry(turnId, "thought", prose),
        buildReadEntry(turnId, "read_b", "src/b.ts"),
        buildAssistantEntry(turnId, "reply", "Fixed.", {
          assistantPhase: "final_answer",
          status: "inProgress",
        }),
      ],
    });

    // A Thought adds nothing to the summary of the work it sits in.
    await click(view.getByRole("button", { name: "Read files" }));

    const row = view.getByTestId("thought-row");
    const [first, second] = view.getAllByRole("link", { name: /src\/[ab]\.ts|[ab]\.ts/u });
    expect(first && second).toBeTruthy();
    expect(Boolean(first!.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
      true,
    );
    expect(Boolean(row.compareDocumentPosition(second!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
      true,
    );
    const excerpt = view.getByRole("button", {
      name: /^I need to check whether the status label/u,
    });
    expect(excerpt.getAttribute("aria-expanded")).toBe("false");
    // Opened, the row names the Thought instead of repeating its opening above the full text.
    await click(excerpt);
    expect(excerpt.getAttribute("aria-expanded")).toBe("true");
    expect(excerpt.textContent).toBe("Thought");
    expect(row.textContent).toContain("so a long paragraph could wrap across the Thread.");
  });
});
