import { act, fireEvent, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { render, openNodexMenu, settleAsyncRender, textContent } from "../../../test/dom";
import { ThreadStageHeaderSlotContext } from "./thread-stage-header-slot";
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

  test("offers Clear context with the chat's new-work actions and reports its refusal", async () => {
    const { ThreadStageHeader } = await import("./local-conversation-stage-header");
    const onClearContext = vi.fn(async () => {
      throw new Error("Wait for the reply and queued messages to finish, then clear the context.");
    });
    const onErrorMessage = vi.fn();
    const screen = render(
      <ThreadStageHeader
        model={buildModel({ showSideChatAction: true })}
        actions={{ ...buildActions(), onOpenSideChat: async () => {}, onClearContext }}
        onErrorMessage={onErrorMessage}
      />,
    );

    await openNodexMenu(screen.getByRole("button", { name: "Chat actions" }));
    const bodyText = textContent(document.body);
    expect(bodyText.indexOf("New side chat") < bodyText.indexOf("Clear context")).toBe(true);
    expect(bodyText.indexOf("Clear context") < bodyText.indexOf("Copy")).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByText("Clear context"));
      await Promise.resolve();
    });
    expect(onClearContext).toHaveBeenCalledOnce();
    expect(onErrorMessage).toHaveBeenLastCalledWith(
      "Wait for the reply and queued messages to finish, then clear the context.",
    );
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

describe("ThreadStageHeader workspace slot", () => {
  test.each(["right", "left"] as const)(
    "offers Move to %s pane after Copy and before runtime and Archive",
    async (side) => {
      const { ThreadStageHeader } = await import("./local-conversation-stage-header");
      const onSelect = vi.fn();
      const view = render(
        <ThreadStageHeaderSlotContext value={{ variant: "titlebar", paneMove: { side, onSelect } }}>
          <ThreadStageHeader
            model={buildModel()}
            actions={{
              ...buildActions(),
              onArchiveThread: async () => {},
              onOpenSubagentsPanel: async () => {},
            }}
            onErrorMessage={() => {}}
            provider={{
              kind: "claude",
              label: "Claude",
              selection: "claude:work",
              commands: [],
              error: null,
              controls: { subagents: true },
            }}
          />
        </ThreadStageHeaderSlotContext>,
      );
      await openNodexMenu(view.getByRole("button", { name: "Chat actions" }));
      const menu = view.getByRole("menu");
      const items = within(menu).getAllByRole("menuitem");
      const copy = within(menu).getByRole("menuitem", { name: "Copy" });
      const move = within(menu).getByRole("menuitem", { name: `Move to ${side} pane` });
      expect(items.indexOf(move)).toBe(items.indexOf(copy) + 1);
      expect(items.indexOf(move)).toBeLessThan(
        items.indexOf(within(menu).getByRole("menuitem", { name: "Subagents" })),
      );
      expect(items.indexOf(move)).toBeLessThan(
        items.indexOf(within(menu).getByRole("menuitem", { name: "Archive" })),
      );
      await act(async () => {
        fireEvent.click(move);
        await Promise.resolve();
      });
      expect(onSelect).toHaveBeenCalledOnce();
    },
  );

  test("the default header has no pane move action", async () => {
    const { ThreadStageHeader } = await import("./local-conversation-stage-header");
    const view = render(
      <ThreadStageHeader model={buildModel()} actions={buildActions()} onErrorMessage={() => {}} />,
    );
    await openNodexMenu(view.getByRole("button", { name: "Chat actions" }));
    expect(view.queryByRole("menuitem", { name: /^Move to .* pane$/ })).toBeNull();
  });

  test("the Chat tab slot renders only its working Chat actions trigger", async () => {
    const { ThreadStageHeader } = await import("./local-conversation-stage-header");
    const view = render(
      <ThreadStageHeaderSlotContext value={{ variant: "chat-tab", paneMove: null }}>
        <ThreadStageHeader
          model={buildModel()}
          actions={buildActions()}
          onErrorMessage={() => {}}
        />
      </ThreadStageHeaderSlotContext>,
    );
    expect(view.queryByText("Thread title")).toBeNull();
    expect(view.getAllByRole("button")).toEqual([
      view.getByRole("button", { name: "Chat actions" }),
    ]);
    await openNodexMenu(view.getByRole("button", { name: "Chat actions" }));
    expect(view.getByRole("menuitem", { name: "Copy" })).toBeTruthy();
    expect(view.queryByRole("menuitem", { name: /^Move to .* pane$/ })).toBeNull();
  });
});
