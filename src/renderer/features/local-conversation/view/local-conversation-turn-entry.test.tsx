import { beforeEach, describe, expect, test } from "vite-plus/test";
import { act, fireEvent } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { NodexTooltipProvider as TooltipProvider } from "../../../components/ui/tooltip";
import { renderWithMaitai as renderDom, settleAsyncRender } from "../../../test/dom";
import type { CodexConversationItem, CodexConversationTurn } from "../../../lib/types";
import type { VisibleConversationTurnEntry } from "../selectors";
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

  test("renders assistant actions in Codex order and forks with an empty composer draft", async () => {
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
    const thumbsUpIndex = labels.indexOf("Good response");
    const thumbsDownIndex = labels.indexOf("Bad response");
    const forkIndex = labels.indexOf("Fork from this point");

    expect(assistantCopyIndex >= 0).toBe(true);
    expect(thumbsUpIndex > assistantCopyIndex).toBe(true);
    expect(thumbsDownIndex > thumbsUpIndex).toBe(true);
    expect(forkIndex > thumbsDownIndex).toBe(true);
    expect(labels.includes("Ask in side chat")).toBe(false);
    expect(Boolean(view.container.textContent?.includes(expectedTime))).toBe(true);
    expect(Boolean(view.container.textContent?.includes(staleCompletedTime))).toBe(false);

    const turnRoot = view.container.querySelector(
      '[data-content-search-turn-key="turn_assistant_actions"]',
    );
    if (turnRoot === null) {
      throw new Error("expected Codex-style turn root");
    }

    fireEvent.click(view.getByLabelText("Fork from this point"));
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

  test("suppresses assistant copy and rating while streaming or empty", async () => {
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
        }),
      ),
    );

    expect(view.queryByLabelText("Good response") === null).toBe(true);
    expect(view.queryByLabelText("Bad response") === null).toBe(true);
    expect(view.queryByLabelText("Fork from this point") === null).toBe(true);

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
        }),
      ),
    );

    expect(view.queryByLabelText("Good response") === null).toBe(true);
    expect(view.queryByLabelText("Bad response") === null).toBe(true);
    expect(Boolean(view.getByLabelText("Fork from this point"))).toBe(true);
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
    const bubble = view.container.querySelector(
      '[data-content-search-unit-key="turn_images:user:0"]',
    );
    if (!(strip instanceof HTMLElement) || !(bubble instanceof HTMLElement)) {
      throw new Error("expected attachment strip and user bubble");
    }

    expect(Boolean(strip.textContent?.includes("notes.md"))).toBe(true);
    expect(Boolean(bubble.textContent?.includes("Inspect these images"))).toBe(true);
    expect(Boolean(strip.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
      true,
    );
    expect(strip.querySelector("img") !== null).toBe(true);

    const previewTrigger = view.getByLabelText("Open image preview");
    fireEvent.click(previewTrigger);
    const preview = document.body.querySelector('[data-slot="codex-dialog-content"] img');
    if (!(preview instanceof HTMLImageElement)) {
      throw new Error("expected image preview dialog");
    }
    expect(preview.src.startsWith("data:image/png;base64")).toBe(true);
  });

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
      '[data-content-search-unit-key="turn_latest:assistant"]',
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
          markdownText: "Checking the file.",
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
      '[data-content-search-unit-key="turn_latest:assistant"]',
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
        }),
      ),
    );

    const assistantBlock = view.container.querySelector(
      '[data-content-search-unit-key="turn_stopped_order:assistant"]',
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
    expect(Boolean(view.getByLabelText("Fork from this point"))).toBe(true);
  });
});
