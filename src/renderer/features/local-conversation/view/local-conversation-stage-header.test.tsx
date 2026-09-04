import { act, fireEvent } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
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
    onPermissionModeChange: () => {},
    onQueueingEnabledChange: () => {},
    onSendPrompt: async () => {},
    onSteerPrompt: async () => {},
    onInterruptTurn: async () => {},
    onRespondApproval: async () => {},
    onRespondUserInput: async () => {},
    onRespondMcpElicitation: async () => {},
    onResolvePlanImplementationRequest: async () => {},
    onEnqueueQueuedFollowUp: async () => {},
    onRemoveQueuedFollowUp: async () => {},
    onReorderQueuedFollowUps: async () => {},
    onSendQueuedFollowUpNow: async () => {},
    onEditQueuedFollowUp: async () => {},
    onEditLastUserTurn: async () => {},
    onForkFromTurn: async () => {},
    onUnarchiveThread: async () => {},
    onOpenTurnDiffReview: () => {},
    onConsumeComposerIntent: () => {},
    onOpenThread: () => {},
    onCleanBackgroundTerminals: async () => {},
  };
}

describe("ThreadStageHeader", () => {
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
    const header = container.firstElementChild;
    expect(title?.textContent).toBe("Review shell header parity");
    expect(header?.className.includes("draggable")).toBe(true);
  });

  test("keeps thread actions left-aligned immediately after the title", async () => {
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
    const threadActions = container.querySelector('button[aria-label="Task actions"]');
    const actionGroup = threadActions?.parentElement;
    expect(Boolean(title)).toBe(true);
    expect(Boolean(actionGroup)).toBe(true);
    expect(actionGroup?.previousElementSibling === title).toBe(true);
  });

  test("renders the Codex task action ordering before the Copy flyout", async () => {
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

    const trigger = screen.getByRole("button", { name: "Task actions" });
    await openNodexMenu(trigger);

    const bodyText = textContent(document.body);
    expect(bodyText.indexOf("Rename") >= 0).toBe(true);
    expect(bodyText.indexOf("Rename") < bodyText.indexOf("Open side task")).toBe(true);
    expect(bodyText.indexOf("Open side task") < bodyText.indexOf("Copy")).toBe(true);

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

    const trigger = screen.getByRole("button", { name: "Task actions" });
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
