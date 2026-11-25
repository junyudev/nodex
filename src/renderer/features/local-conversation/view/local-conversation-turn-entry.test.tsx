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
      // The cancel boundary is before the queued reveal frame, regardless of wall-clock delay.
      vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
      await act(async () => {
        fireEvent.click(count);
      });
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      await act(async () => {
        fireEvent.click(toggle);
      });
      await act(async () => {
        vi.advanceTimersToNextFrame();
      });
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
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
            agentKind: "codex",
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
});
