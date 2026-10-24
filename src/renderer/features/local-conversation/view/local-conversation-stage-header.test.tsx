import { act, fireEvent } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { render, openNodexMenu, settleAsyncRender, textContent } from "../../../test/dom";
import type { ThreadStageActions, ThreadStageHeaderModel } from "../thread-stage-types";

function buildModel(overrides?: Partial<ThreadStageHeaderModel>): ThreadStageHeaderModel {
  return {
    projectId: "project_1",
    sessionId: "session_1",
    threadId: "thread_1",
    title: "Thread title",
    cwd: "/Users/test/project",
    ...overrides,
  };
}

function buildActions(): ThreadStageActions {
  return {
    onCollaborationModeChange: () => {},
    onModelChange: () => {},
    onReasoningEffortChange: () => {},

    onQueueingEnabledChange: () => {},
    onSendPrompt: async () => {},
    onSendCapturedFollowUp: async () => {},
    onSteerPrompt: async () => {},
    onInterruptTurn: async () => {},
    onRespondUserInput: async () => {},
    onRespondMcpElicitation: async () => {},
    onResolvePlanImplementationRequest: async () => {},
    onEnqueueQueuedFollowUp: async () => {},
    onRemoveQueuedFollowUp: async () => {},
    onReorderQueuedFollowUps: async () => {},
    onSendQueuedFollowUpNow: async () => {},
    onEditQueuedFollowUp: async () => {},
    onEditUserTurn: async () => {},
    onForkFromTurn: async () => {},
    onUnarchiveThread: async () => {},
    onOpenTurnDiffReview: () => {},
    onConsumeComposerIntent: () => {},
    onOpenThread: () => {},
    onCleanBackgroundTerminals: async () => {},
  };
}

describe("ThreadStageHeader", () => {
  test("keeps a named child Thread's avatar through title and nickname changes", async () => {
    const { ThreadStageHeader } = await import("./local-conversation-stage-header");
    const actions = buildActions();
    const onErrorMessage = () => {};
    const header = (model: ThreadStageHeaderModel) => (
      <ThreadStageHeader model={model} actions={actions} onErrorMessage={onErrorMessage} />
    );
    const view = render(header(buildModel({ subagentName: "Scout" })));
    const avatar = view.container.querySelector<HTMLImageElement>(
      '[data-subagent-avatar-seed="thread_1"]',
    );
    expect(avatar).not.toBeNull();
    const src = avatar?.getAttribute("src");
    expect(view.getByText("Scout")).toBeTruthy();

    view.rerender(header(buildModel({ title: "Updated task", subagentName: "Researcher" })));
    expect(view.getByText("Researcher")).toBeTruthy();
    expect(view.queryByText("Scout")).toBeNull();
    expect(avatar?.getAttribute("src")).toBe(src);

    view.rerender(header(buildModel()));
    expect(view.container.querySelector("[data-subagent-avatar-seed]")).toBeNull();
  });

  test.each(["claude", "opencode"] as const)(
    "offers a working Fork chat action for a %s Runtime conversation",
    async (kind) => {
      const { ThreadStageHeader } = await import("./local-conversation-stage-header");
      const onForkThread = vi.fn(async (_target: "local" | "newWorktree") => {});
      const actions = { ...buildActions(), onForkThread };
      const view = render(
        <ThreadStageHeader
          model={buildModel()}
          actions={actions}
          onErrorMessage={() => {}}
          provider={{
            kind,
            label: kind === "claude" ? "Claude Code" : "OpenCode",
            selection: `${kind}:work`,
            options: [],
            select: () => {},
            commands: [],
            error: null,
          }}
        />,
      );

      await openNodexMenu(view.getByRole("button", { name: "Chat actions" }));
      await act(async () => {
        fireEvent.keyDown(view.getByRole("menuitem", { name: /^Fork$/u }), {
          key: "ArrowRight",
        });
        await Promise.resolve();
      });
      await settleAsyncRender();
      const fork = view.getByRole("menuitem", { name: "Fork chat" });
      expect(fork.getAttribute("aria-disabled")).not.toBe("true");
      await act(async () => {
        fireEvent.click(fork);
        await Promise.resolve();
      });
      expect(onForkThread).toHaveBeenCalledExactlyOnceWith("local");
    },
  );

  test("requests a native generated title only after its explicit menu action", async () => {
    const { ThreadStageHeader } = await import("./local-conversation-stage-header");
    const generateTitle = vi.fn(async () => "Generated task title");
    const view = render(
      <ThreadStageHeader
        model={buildModel()}
        actions={buildActions()}
        onErrorMessage={() => {}}
        provider={{
          kind: "claude",
          label: "Claude",
          selection: "claude:work",
          options: [],
          select: () => {},
          commands: [],
          error: null,
          generateTitle,
        }}
      />,
    );
    expect(generateTitle).not.toHaveBeenCalled();
    await openNodexMenu(view.getByRole("button", { name: "Chat actions" }));
    expect(generateTitle).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Generate title" }));
    });
    expect(generateTitle).toHaveBeenCalledTimes(1);
  });
  test("renders the global thread title", async () => {
    const { ThreadStageHeader } = await import("./local-conversation-stage-header");
    const { container } = render(
      <ThreadStageHeader
        model={buildModel({ title: "Review shell header parity" })}
        actions={buildActions()}
        onErrorMessage={() => {}}
      />,
    );

    const title = container.querySelector('[data-testid="thread-stage-title"]');
    expect(title?.textContent).toBe("Review shell header parity");
  });

  test("places chat actions at the trailing edge after the growing title", async () => {
    const { ThreadStageHeader } = await import("./local-conversation-stage-header");
    const actions = {
      ...buildActions(),
      onOpenSideChat: async () => {},
    };
    const { container } = render(
      <ThreadStageHeader
        model={buildModel({ showSideChatAction: true })}
        actions={actions}
        onErrorMessage={() => {}}
      />,
    );

    const title = container.querySelector('[data-testid="thread-stage-title"]');
    const threadActions = container.querySelector('button[aria-label="Chat actions"]');
    if (!title || !threadActions) throw new Error("Expected the title and chat actions");
    expect(
      title.compareDocumentPosition(threadActions) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(title.parentElement?.lastElementChild?.contains(threadActions)).toBe(true);
  });

  test("renders the chat action ordering before the Copy flyout", async () => {
    const { ThreadStageHeader } = await import("./local-conversation-stage-header");
    let renameCalls = 0;
    const actions = {
      ...buildActions(),
      onRequestRenameThread: () => {
        renameCalls += 1;
      },
      onOpenSideChat: async () => {},
    };
    const screen = render(
      <ThreadStageHeader
        model={buildModel({ showSideChatAction: true })}
        actions={actions}
        onErrorMessage={() => {}}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Chat actions" });
    await openNodexMenu(trigger);

    const bodyText = textContent(document.body);
    expect(bodyText.indexOf("Rename") >= 0).toBe(true);
    expect(bodyText.indexOf("Rename") < bodyText.indexOf("New side chat")).toBe(true);
    expect(bodyText.indexOf("New side chat") < bodyText.indexOf("Copy")).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByText("Rename"));
      await Promise.resolve();
    });
    expect(renameCalls).toBe(1);
  });

  test("opens Copy as a separate submenu with Codex item ordering", async () => {
    const { ThreadStageHeader } = await import("./local-conversation-stage-header");
    const screen = render(
      <ThreadStageHeader
        model={buildModel()}
        actions={{
          ...buildActions(),
          onRequestRenameThread: () => {},
          onCopyConversationMarkdown: async () => {},
        }}
        onErrorMessage={() => {}}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Chat actions" });
    await openNodexMenu(trigger);
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("menuitem", { name: "Copy" }), { key: "ArrowRight" });
      await Promise.resolve();
    });
    await settleAsyncRender();

    const bodyText = textContent(document.body);
    const cwdIndex = bodyText.indexOf("Copy working directory");
    const sessionIndex = bodyText.indexOf("Copy session ID");
    const deeplinkIndex = bodyText.indexOf("Copy deeplink");
    const markdownIndex = bodyText.indexOf("Copy as Markdown");
    expect(cwdIndex >= 0).toBe(true);
    expect(cwdIndex < sessionIndex).toBe(true);
    expect(sessionIndex < deeplinkIndex).toBe(true);
    expect(deeplinkIndex < markdownIndex).toBe(true);
  });
});
