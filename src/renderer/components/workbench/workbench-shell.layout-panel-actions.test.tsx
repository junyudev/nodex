import "./workbench-testkit/workbench-shell-harness";
import { describe, test, expect } from "vite-plus/test";
import { settleAsyncRender, textContent } from "../../test/dom";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { TOGGLE_BOTTOM_PANEL_COMMAND_ID } from "../../../shared/workbench-commands";
import {
  APP_SHELL_GLOBAL_HEADER_LAYER_CLASS,
  APP_SHELL_RIGHT_PANEL_LAYER_CLASS,
  APP_SHELL_FLOATING_LEFT_PANEL_LAYER_CLASS,
} from "@/lib/app-shell-layers";
import { type Project } from "@/lib/types";
import { __getNodexToastSnapshotForTests } from "@/components/ui/toast";
import { THREAD_QUEUE_FOLLOW_UPS_STORAGE_KEY } from "@/lib/thread-composer-follow-up-mode";
import { COMPOSER_ENTER_BEHAVIOR_STORAGE_KEY } from "@/lib/composer-enter-behavior";
import {
  makeAttachedSession,
  makeBottomPanelTerminalSession,
  makePanelLayout,
  makePanels,
  makeProject,
  makeSession,
  makeSessionTab,
} from "./workbench-testkit/workbench-shell-fixtures";
import {
  BOTTOM_PANEL_HIDDEN_ICON_PREFIX,
  EXPAND_PANEL_ICON_PREFIX,
  PANEL_VISIBLE_ICON_PREFIX,
  RESTORE_PANEL_ICON_PREFIX,
  clickMenuItem,
  discardSideChatCalls,
  executeCommandPaletteCommand,
  getBottomPanelContentSizer,
  getConnectedThreadStagePropsByThreadId,
  getFilesPreviewInteractionTarget,
  getHeaderShellSlot,
  getLastTerminalPanelProps,
  getLastThreadStageActions,
  getPanelTabById,
  getThreadRow,
  getWorkbenchTabProjectionDeleteTabIds,
  hydrateBackgroundSubagentThreadsCalls,
  hydrateSubagentPanelCalls,
  installReducedMotionMatchMediaForTest,
  installTerminalEventApiMock,
  invokeCalls,
  moveSidebarPointer,
  openBottomPanel,
  openPanelMenu,
  pointerActivate,
  pointerDownAndSettle,
  releasePointerDrag,
  renderWorkbench,
  requestPageCreateFromContextMock,
  requestThreadStreamSnapshotCalls,
  setComposerIntentCalls,
  setWindowInnerWidthForTest,
  sideChatConversations,
  startSideChatCalls,
  setInvokeCalls,
  setRequestThreadStreamSnapshotImpl,
  setSideChatConversationProjectId,
  setStartSideChatError,
} from "./workbench-testkit/workbench-shell-harness";

describe("workbench session shell / layout-panel-actions", () => {
  test("settles a failed side chat open into a closable retry surface", async () => {
    setStartSideChatError(new Error("Side chat fork timed out"));
    const session = makeAttachedSession({
      id: "session:alpha:side-chat-failure",
      projectId: "alpha",
      title: "Side chat failure",
      threadId: "thread-alpha",
      tabs: [],
      rightCollapsed: false,
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
      initialSelectedSessionId: session.id,
    });
    await settleAsyncRender();

    const menu = await openPanelMenu(screen, "Open side panel tab");
    await clickMenuItem(menu, "Side chat");

    expect(textContent(await screen.findByRole("alert"))).toContain(
      "Side chat could not be opened",
    );
    expect(screen.getByText("Side chat fork timed out")).toBeTruthy();
    setStartSideChatError(null);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(startSideChatCalls).toHaveLength(2));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Close Side chat tab" })).toBeTruthy();
  });

  test("collapsed right panel opens from the global side-panel toggle", async () => {
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeSession({ rightCollapsed: true })] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(screen.queryAllByRole("tablist").length).toBe(0);
    const globalHeader = screen.container.querySelector('[data-testid="workbench-global-header"]');
    const toggleButton = screen.getByRole("button", { name: "Toggle side panel" });
    const toggleIconPath = toggleButton.querySelector("path")?.getAttribute("d") ?? "";
    expect(globalHeader?.contains(toggleButton)).toBe(true);
    expect(toggleButton.getAttribute("aria-pressed")).toBe("false");
    expect(toggleButton.className.includes("no-drag")).toBe(true);
    expect(toggleIconPath.startsWith(PANEL_VISIBLE_ICON_PREFIX)).toBe(true);
    expect(screen.queryByRole("button", { name: "Attach thread" })).toBe(null);
    expect(screen.queryByRole("button", { name: "Detach thread" })).toBe(null);

    await act(async () => {
      fireEvent.click(toggleButton);
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:panel-patch" &&
          call[1] === "session:alpha:database-view" &&
          call[2] === "right" &&
          JSON.stringify(call[3]) === JSON.stringify({ collapsed: false }),
      ),
    ).toBe(true);
    expect(screen.queryAllByRole("tablist").length > 0).toBe(true);
  });

  test("empty collapsed bottom panel opens a Terminal from the global toggle", async () => {
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeAttachedSession({ rightCollapsed: true })] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const globalHeader = screen.container.querySelector('[data-testid="workbench-global-header"]');
    const bottomPanelToggle = screen.getByRole("button", { name: "Toggle bottom panel" });
    const sidePanelToggle = screen.getByRole("button", { name: "Toggle side panel" });
    const toggleIconPath = bottomPanelToggle.querySelector("path")?.getAttribute("d") ?? "";
    expect(globalHeader?.contains(bottomPanelToggle)).toBe(true);
    expect(
      (bottomPanelToggle.compareDocumentPosition(sidePanelToggle) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
        0,
    ).toBe(true);
    expect(bottomPanelToggle.getAttribute("aria-pressed")).toBe("false");
    expect(bottomPanelToggle.className.includes("no-drag")).toBe(true);
    expect(toggleIconPath.startsWith(BOTTOM_PANEL_HIDDEN_ICON_PREFIX)).toBe(true);
    expect(screen.queryByTestId("session-bottom-panel")).toBe(null);

    await act(async () => {
      fireEvent.click(bottomPanelToggle);
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:panel-patch" &&
          call[1] === "session:alpha:database-view" &&
          call[2] === "bottom" &&
          JSON.stringify(call[3]) === JSON.stringify({ collapsed: false }),
      ),
    ).toBe(true);
    expect(screen.queryByTestId("session-bottom-panel") !== null).toBe(true);
    expect(screen.getByRole("tab", { name: /^Terminal \d+$/, selected: true }) !== null).toBe(true);
    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:tab-create" &&
          (call[1] as { kind?: string; panelId?: string } | undefined)?.kind === "terminal" &&
          (call[1] as { kind?: string; panelId?: string } | undefined)?.panelId === "bottom",
      ),
    ).toBe(true);
  });

  test("reopening a non-empty bottom panel preserves its active tab", async () => {
    const session = makeAttachedSession({
      id: "session:alpha:bottom-browser",
      rightCollapsed: true,
      tabs: [
        {
          id: "bottom-browser-tab",
          kind: "browser",
          title: "Browser",
          panelId: "bottom",
          config: { projectId: "alpha" },
        },
      ],
      panels: makePanels({
        rightCollapsed: true,
        bottomTabIds: ["bottom-browser-tab"],
        bottomActiveTabId: "bottom-browser-tab",
        bottomCollapsed: true,
      }),
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Toggle bottom panel" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(screen.getByRole("tab", { name: "Browser", selected: true }) !== null).toBe(true);
    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:tab-create" &&
          (call[1] as { kind?: string } | undefined)?.kind === "terminal",
      ),
    ).toBe(false);
  });

  test("native and command-palette bottom-panel commands share the shell action", async () => {
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeSession({ rightCollapsed: true })] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      screen.requestWorkbenchCommand("menu");
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(screen.queryByTestId("session-bottom-panel") !== null).toBe(true);

    await executeCommandPaletteCommand(screen, "bottom panel", "Toggle bottom panel");

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Toggle bottom panel" }).getAttribute("aria-pressed"),
      ).toBe("false");
    });
    const bottomPanelMutations = invokeCalls.filter(
      (call) => call[0] === "window-session-view:panel-patch" && call[2] === "bottom",
    );
    expect(bottomPanelMutations.map((call) => call[3])).toEqual([
      { collapsed: false },
      { collapsed: true },
    ]);
  });

  test("consumes a bottom-panel command queued before the shell mounts", async () => {
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeSession({ rightCollapsed: true })] },
      workbenchCommandRequest: {
        tick: 1,
        commandId: TOGGLE_BOTTOM_PANEL_COMMAND_ID,
        source: "menu",
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(screen.queryByTestId("session-bottom-panel") !== null).toBe(true);
    expect(
      invokeCalls
        .filter((call) => call[0] === "window-session-view:panel-patch" && call[2] === "bottom")
        .map((call) => call[3]),
    ).toEqual([{ collapsed: false }]);
  });

  test("delegates the Page-create command to the registered workflow", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();

    await act(async () => {
      screen.requestPageCreateCommand("keyboard_shortcut");
      await Promise.resolve();
    });

    expect(requestPageCreateFromContextMock).toHaveBeenCalledTimes(1);
    expect(requestPageCreateFromContextMock).toHaveBeenCalledWith(expect.any(Object), {
      activeProjectId: "alpha",
      captureSelection: true,
      expanded: false,
      unavailableFeedback: "silent",
    });
  });

  test("bottom-panel commands safely no-op without an active session", async () => {
    const screen = renderWorkbench({ sessionsByProject: { alpha: [] } });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      screen.requestWorkbenchCommand("menu");
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(
      invokeCalls.some(
        (call) => call[0] === "window-session-view:panel-patch" && call[2] === "bottom",
      ),
    ).toBe(false);
  });

  test("thread summary toggle defaults to pinned open and persists collapsed state", async () => {
    setWindowInnerWidthForTest(1400);
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [
          makeAttachedSession({
            id: "session:alpha:thread",
            title: "Thread",
            rightCollapsed: true,
            tabs: [],
          }),
        ],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const summaryToggle = screen.getByRole("button", { name: "Toggle pinned summary" });
    const globalHeader = screen.getByTestId("workbench-global-header");
    const summaryRail = screen.getByTestId("thread-stage-header-summary-actions");
    let stageProps = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(
      within(globalHeader).queryByRole("button", { name: "Toggle pinned summary" }) !== null,
    ).toBe(true);
    expect(globalHeader.contains(summaryRail)).toBe(true);
    expect(
      summaryRail.querySelector('[data-workbench-header-action-rail="visible"]') !== null,
    ).toBe(true);
    expect(
      within(summaryRail).queryByRole("button", { name: "Toggle pinned summary" }) !== null,
    ).toBe(true);
    expect(summaryToggle.getAttribute("aria-pressed")).toBe("true");
    expect(stageProps?.summaryPanelMounted).toBe(true);
    expect(stageProps?.summaryPanelOpen).toBe(true);
    expect(stageProps?.summaryPanelContentShift).toBe(-158);

    await act(async () => {
      fireEvent.click(summaryToggle);
      await Promise.resolve();
    });
    await settleAsyncRender();

    stageProps = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(summaryToggle.getAttribute("aria-pressed")).toBe("false");
    expect(stageProps?.summaryPanelMounted).toBe(true);
    expect(stageProps?.summaryPanelOpen).toBe(false);
    expect(stageProps?.summaryPanelContentShift).toBe(0);
    expect(localStorage.getItem("nodex:thread-summary-panel:pinned-open")).toBe("false");
  });

  test("large thread widths use edge-scroll header and gutter summary mode", async () => {
    setWindowInnerWidthForTest(1902);
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [
          makeAttachedSession({
            id: "session:alpha:thread",
            title: "Thread",
            rightCollapsed: true,
          }),
        ],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const globalHeader = screen.getByTestId("workbench-global-header");
    const threadFrame = screen.container.querySelector(".app-shell-main-content-frame");
    const stageProps = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(globalHeader.getAttribute("data-app-shell-header-edge-scroll")).toBe("true");
    expect(threadFrame !== null).toBe(true);
    expect(
      screen.container.querySelector("[data-app-shell-main-content-header-divider]") === null,
    ).toBe(true);
    expect(stageProps?.summaryPanelMounted).toBe(true);
    expect(stageProps?.summaryPanelOpen).toBe(true);
    expect(stageProps?.summaryPanelContentShift).toBe(0);
  });

  test("medium thread widths keep guarded header chrome and shift pinned summary", async () => {
    setWindowInnerWidthForTest(1801);
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [
          makeAttachedSession({
            id: "session:alpha:thread",
            title: "Thread",
            rightCollapsed: true,
          }),
        ],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const globalHeader = screen.getByTestId("workbench-global-header");
    const threadFrame = screen.container.querySelector(".app-shell-main-content-frame");
    const stageProps = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(globalHeader.getAttribute("data-app-shell-header-edge-scroll")).toBe("false");
    expect(threadFrame !== null).toBe(true);
    expect(
      screen.container.querySelector("[data-app-shell-main-content-header-divider]") === null,
    ).toBe(true);
    expect(stageProps?.summaryPanelMounted).toBe(true);
    expect(stageProps?.summaryPanelOpen).toBe(true);
    expect(stageProps?.summaryPanelContentShift).toBe(-158);
  });

  test("narrow effective thread widths switch summary to overlay popover", async () => {
    setWindowInnerWidthForTest(1350);
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [
          makeAttachedSession({
            id: "session:alpha:thread",
            title: "Thread",
            rightCollapsed: true,
          }),
        ],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const stageProps = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    const summaryToggle = screen.getByRole("button", { name: "Toggle summary" });
    expect(summaryToggle.getAttribute("aria-pressed")).toBe("false");
    expect(stageProps?.summaryPanelMounted).toBe(true);
    expect(stageProps?.summaryPanelOpen).toBe(false);
    expect(stageProps?.summaryPanelHideImmediately).toBe(false);
    expect(stageProps?.summaryPanelContentShift).toBe(0);
  });

  test("resize-driven overlay mode keeps the summary mounted so it can animate out", async () => {
    setWindowInnerWidthForTest(1801);
    localStorage.setItem("nodex:thread-summary-panel:pinned-open", "true");
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [
          makeAttachedSession({
            id: "session:alpha:thread",
            title: "Thread",
            rightCollapsed: true,
          }),
        ],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    let stageProps = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(stageProps?.summaryPanelMounted).toBe(true);
    expect(stageProps?.summaryPanelOpen).toBe(true);
    expect(stageProps?.summaryPanelContentShift).toBe(-158);

    setWindowInnerWidthForTest(1350);
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await Promise.resolve();
    });
    await settleAsyncRender();

    stageProps = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    await waitFor(() => {
      expect(
        screen.container
          .querySelector("[data-app-shell-summary-layout]")
          ?.getAttribute("data-app-shell-summary-layout"),
      ).toBe("overlay");
    });
    stageProps = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(
      screen.getByRole("button", { name: "Toggle summary" }).getAttribute("aria-pressed"),
    ).toBe("false");
    expect(stageProps?.summaryPanelMounted).toBe(true);
    expect(stageProps?.summaryPanelOpen).toBe(false);
    expect(stageProps?.summaryPanelHideImmediately).toBe(false);
    expect(stageProps?.summaryPanelContentShift).toBe(0);
    expect(localStorage.getItem("nodex:thread-summary-panel:pinned-open")).toBe("true");
  });

  test("responsive shell guards close competing right panel and sidebar at Codex thresholds", async () => {
    setWindowInnerWidthForTest(1000);
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [
          makeAttachedSession({
            id: "session:alpha:thread",
            title: "Thread",
            rightCollapsed: false,
          }),
        ],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    setWindowInnerWidthForTest(959);
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await Promise.resolve();
    });
    await settleAsyncRender();

    await waitFor(() => {
      expect(
        screen.container
          .querySelector("[data-app-shell-width-class]")
          ?.getAttribute("data-app-shell-width-class"),
      ).toBe("medium");
      expect(
        invokeCalls.some((call) => {
          const input = call[3] as
            | { collapsed?: boolean; size?: { fullWidth?: boolean } }
            | undefined;
          return (
            call[0] === "window-session-view:panel-patch" &&
            call[1] === "session:alpha:thread" &&
            call[2] === "right" &&
            input?.collapsed === true
          );
        }),
      ).toBe(true);
    });

    setWindowInnerWidthForTest(719);
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await Promise.resolve();
    });
    await settleAsyncRender();

    await waitFor(() => {
      expect(screen.queryByTestId("project-session-sidebar") === null).toBe(true);
    });
  });

  test("thread summary toggle stays visible while the right panel is open and keeps the pinned overlay hidden", async () => {
    setWindowInnerWidthForTest(1400);
    localStorage.setItem("nodex:thread-summary-panel:pinned-open", "true");
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [
          makeAttachedSession({
            id: "session:alpha:thread",
            title: "Thread",
            rightCollapsed: false,
          }),
        ],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    let stageProps = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    const rightOpenSummaryToggle = screen.getByRole("button", { name: "Toggle summary" });
    const globalHeader = screen.getByTestId("workbench-global-header");
    const summaryRail = screen.getByTestId("thread-stage-header-summary-actions");
    expect(rightOpenSummaryToggle.getAttribute("aria-pressed")).toBe("false");
    expect(within(globalHeader).queryByRole("button", { name: "Toggle summary" }) !== null).toBe(
      true,
    );
    expect(globalHeader.contains(summaryRail)).toBe(true);
    expect(within(summaryRail).queryByRole("button", { name: "Toggle summary" }) !== null).toBe(
      true,
    );
    expect(stageProps?.summaryPanelMounted).toBe(true);
    expect(stageProps?.summaryPanelOpen).toBe(false);
    expect(stageProps?.summaryPanelHideImmediately).toBe(false);
    expect(stageProps?.summaryPanelContentShift).toBe(0);
    expect(localStorage.getItem("nodex:thread-summary-panel:pinned-open")).toBe("true");

    await act(async () => {
      fireEvent.click(rightOpenSummaryToggle);
      await Promise.resolve();
    });
    await settleAsyncRender();

    stageProps = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(
      screen.getByRole("button", { name: "Toggle summary" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(stageProps?.summaryPanelMounted).toBe(true);
    expect(stageProps?.summaryPanelOpen).toBe(false);
    expect(stageProps?.summaryPanelHideImmediately).toBe(true);
    expect(stageProps?.summaryPanelContentShift).toBe(0);
    expect(localStorage.getItem("nodex:thread-summary-panel:pinned-open")).toBe("true");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Toggle side panel" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    const summaryToggle = screen.getByRole("button", { name: "Toggle pinned summary" });
    stageProps = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(summaryToggle.getAttribute("aria-pressed")).toBe("true");
    expect(stageProps?.summaryPanelMounted).toBe(true);
    expect(stageProps?.summaryPanelOpen).toBe(true);
    expect(stageProps?.summaryPanelHideImmediately).toBe(false);
    expect(stageProps?.summaryPanelContentShift).toBe(-158);
    expect(localStorage.getItem("nodex:thread-summary-panel:pinned-open")).toBe("true");
  });

  test("overview sessions default to open full-width right panels", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();
    await settleAsyncRender();

    const rightPanel = screen.getByTestId("session-right-panel");
    const threadPage = screen.container.querySelector('[data-testid="session-thread-page"]');
    const globalHeader = screen.getByTestId("workbench-global-header");
    const headerCenterSurface = screen.getByTestId("app-shell-header-context-menu-surface");
    const restoreButton = screen.getByRole("button", { name: "Restore panel width" });
    expect(globalHeader.className.includes(APP_SHELL_GLOBAL_HEADER_LAYER_CLASS)).toBe(true);
    expect(headerCenterSurface.getAttribute("aria-hidden")).toBe("true");
    expect(headerCenterSurface.className.includes("invisible")).toBe(true);
    expect(rightPanel.getAttribute("data-right-panel-width-mode")).toBe("full");
    expect(rightPanel.getAttribute("data-app-shell-focus-area")).toBe("right-panel");
    expect(rightPanel.className.includes(APP_SHELL_RIGHT_PANEL_LAYER_CLASS)).toBe(true);
    expect(threadPage?.getAttribute("data-session-thread-page-hidden")).toBe("true");
    expect(restoreButton.getAttribute("aria-pressed")).toBe("true");
  });

  test("collapsed sidebar full-width right panel reserves the left titlebar width before tabs", async () => {
    const restoreMatchMedia = installReducedMotionMatchMediaForTest();
    const originalPlatform = navigator.platform;
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    try {
      const screen = renderWorkbench({ sidebar: { collapsed: true, width: 300 } });
      await settleAsyncRender();
      await settleAsyncRender();

      const leftSlot = getHeaderShellSlot(screen, "left");
      const rightSlot = getHeaderShellSlot(screen, "right");
      const rightPanel = screen.getByTestId("session-right-panel");
      const tabHeader = rightPanel.querySelector('[role="tablist"]')?.parentElement?.parentElement;
      if (!tabHeader) throw new Error("Expected right-panel tab header");
      const leadingSpacer = tabHeader.firstElementChild?.firstElementChild;
      const tabRow = tabHeader.children.item(1);
      const trailingSpacer = screen.container.querySelector(
        '[data-testid="right-panel-tab-bar-header-spacer"]',
      );
      const restoreButton = screen.getByRole("button", { name: "Restore panel width" });

      expect(leftSlot.getAttribute("style")?.includes("width: 0px")).toBe(true);
      expect(leftSlot.getAttribute("style")?.includes("min-width: 208px")).toBe(true);
      expect(leftSlot.className.includes("no-drag")).toBe(true);
      expect(tabHeader.className.includes("draggable")).toBe(false);
      expect(within(leftSlot).getByRole("button", { name: "New chat" }) !== null).toBe(true);
      expect(rightSlot.getAttribute("style")?.includes("width: 0px")).toBe(true);
      expect(rightSlot.getAttribute("style")?.includes("min-width: 70px")).toBe(true);
      expect(rightSlot.className.includes("no-drag")).toBe(true);
      expect(leadingSpacer?.getAttribute("style")?.includes("width: 208px")).toBe(true);
      expect(leadingSpacer?.className.includes("pointer-events-none")).toBe(true);
      expect(leadingSpacer?.className.includes("no-drag")).toBe(true);
      expect(tabRow?.querySelector('[role="tablist"]') !== null).toBe(true);
      expect(tabHeader.contains(restoreButton)).toBe(true);
      expect(trailingSpacer?.getAttribute("style")?.includes("width: calc(70px)")).toBe(true);
      expect(trailingSpacer?.className.includes("no-drag")).toBe(true);
      expect(
        screen.container.querySelector('[data-testid="right-panel-global-header-actions"]') ===
          null,
      ).toBe(true);

      await moveSidebarPointer(900);
      expect(
        screen.container.querySelector('[data-testid="floating-project-session-sidebar-shell"]'),
      ).toBe(null);

      await act(async () => {
        restoreButton.focus();
        await Promise.resolve();
      });
      await settleAsyncRender();
      expect(
        screen.container.querySelector('[data-testid="floating-project-session-sidebar-shell"]'),
      ).toBe(null);

      await moveSidebarPointer(12);
      const floatingShell = screen.container.querySelector(
        '[data-testid="floating-project-session-sidebar-shell"]',
      ) as HTMLElement | null;
      expect(floatingShell !== null).toBe(true);
      expect(floatingShell?.className.includes(APP_SHELL_FLOATING_LEFT_PANEL_LAYER_CLASS)).toBe(
        true,
      );

      await moveSidebarPointer(301);
      await act(async () => {
        await Promise.resolve();
      });
      await settleAsyncRender();
      expect(
        screen.container.querySelector('[data-testid="floating-project-session-sidebar-shell"]'),
      ).toBe(null);

      await act(async () => {
        fireEvent.click(restoreButton);
        await Promise.resolve();
      });
      await settleAsyncRender();

      expect(
        screen.getByRole("button", { name: "Expand panel" }).getAttribute("aria-pressed"),
      ).toBe("false");
      expect(
        screen.container.querySelector('[data-testid="floating-project-session-sidebar-shell"]'),
      ).toBe(null);
    } finally {
      restoreMatchMedia();
      Object.defineProperty(navigator, "platform", { configurable: true, value: originalPlatform });
    }
  });

  test("full-width eligible attached right-panel tabs pass the composer overlay host to the root thread", async () => {
    const attachedSession = makeAttachedSession({
      rightFullWidth: true,
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [attachedSession] },
    });
    await settleAsyncRender();
    await settleAsyncRender();
    await settleAsyncRender();

    const rightPanel = screen.getByTestId("session-right-panel");
    const host = rightPanel.querySelector('[data-right-panel-composer-overlay-host="true"]');
    const props = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(host !== null).toBe(true);
    expect(props?.rightPanelComposerOverlayEnabled).toBe(true);
    expect(props?.rightPanelComposerOverlayCompact).toBe(false);
    expect(props?.rightPanelComposerOverlayTarget).toBe(host);
    const visibility = props?.rightPanelComposerOverlayVisibility as
      | {
          kind?: string;
          visible?: boolean;
          onVisibleChange?: (visible: boolean) => void;
        }
      | undefined;
    expect(visibility?.kind).toBe("controlled");
    expect(visibility?.visible).toBe(true);

    await act(async () => {
      visibility?.onVisibleChange?.(false);
      await Promise.resolve();
    });
    await settleAsyncRender();

    const hiddenProps = (
      globalThis as {
        __lastConnectedThreadStageProps?: Record<string, unknown>;
      }
    ).__lastConnectedThreadStageProps;
    const hiddenVisibility = hiddenProps?.rightPanelComposerOverlayVisibility as
      | {
          kind?: string;
          visible?: boolean;
        }
      | undefined;
    expect(hiddenVisibility).toMatchObject({
      kind: "controlled",
      visible: false,
    });
  });

  test("limits compact composer presentation to a full-width Browser tab", async () => {
    const browserTab = makeSessionTab({
      id: "browser-tab",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "browser",
      title: "Browser",
      order: 0,
      config: { projectId: "alpha" },
    });
    const attachedSession = makeAttachedSession({
      tabs: [browserTab],
      panels: makePanels({
        rightTabIds: [browserTab.id],
        rightActiveTabId: browserTab.id,
        rightFullWidth: true,
      }),
    });
    renderWorkbench({
      sessionsByProject: { alpha: [attachedSession] },
    });
    await settleAsyncRender();
    await settleAsyncRender();
    await settleAsyncRender();

    const props = (
      globalThis as {
        __lastConnectedThreadStageProps?: Record<string, unknown>;
      }
    ).__lastConnectedThreadStageProps;
    expect(props?.rightPanelComposerOverlayEnabled).toBe(true);
    expect(props?.rightPanelComposerOverlayCompact).toBe(true);
    expect(props?.rightPanelComposerOverlayVisibility).toMatchObject({
      kind: "controlled-browser-auto",
      visible: true,
      isAtDocumentBottom: false,
      documentBottomKey: expect.stringContaining("browser-tab"),
    });
  });

  test("full-width overlay state keeps the bottom-panel toggle clickable after pointerdown", async () => {
    const session = makeAttachedSession({
      id: "session:alpha:overlay-bottom-toggle",
      tabs: [
        {
          id: "db-tab",
          kind: "db_view",
          title: "DB View",
          config: { projectId: "alpha" },
        },
        {
          id: "terminal-tab",
          kind: "terminal",
          title: "Terminal",
          panelId: "bottom",
          config: { terminalSessionId: "terminal" },
        },
      ],
      panels: makePanels({
        rightTabIds: ["db-tab"],
        rightActiveTabId: "db-tab",
        rightFullWidth: true,
        bottomTabIds: ["terminal-tab"],
        bottomActiveTabId: "terminal-tab",
        bottomCollapsed: true,
      }),
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();
    await settleAsyncRender();

    const props = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(props?.rightPanelComposerOverlayEnabled).toBe(true);
    expect(screen.queryByTestId("session-bottom-panel")).toBe(null);

    await pointerActivate(screen.getByRole("button", { name: "Toggle bottom panel" }));

    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:panel-patch" &&
          call[1] === "session:alpha:overlay-bottom-toggle" &&
          call[2] === "bottom" &&
          JSON.stringify(call[3]) === JSON.stringify({ collapsed: false }),
      ),
    ).toBe(true);
    expect(screen.queryByTestId("session-bottom-panel") !== null).toBe(true);
  });

  test("full-width overlay state keeps the side-panel toggle clickable after pointerdown", async () => {
    const session = makeAttachedSession({
      id: "session:alpha:overlay-side-toggle",
      rightFullWidth: true,
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();
    await settleAsyncRender();

    const props = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(props?.rightPanelComposerOverlayEnabled).toBe(true);

    await pointerActivate(screen.getByRole("button", { name: "Toggle side panel" }));
    await settleAsyncRender();

    await waitFor(() => {
      expect(screen.queryByTestId("session-right-panel")).toBe(null);
    });
  });

  test("full-width overlay state keeps restore-panel-width clickable after pointerdown", async () => {
    const session = makeAttachedSession({
      id: "session:alpha:overlay-restore",
      rightFullWidth: true,
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();
    await settleAsyncRender();

    const props = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(props?.rightPanelComposerOverlayEnabled).toBe(true);

    await pointerActivate(screen.getByRole("button", { name: "Restore panel width" }));

    expect(
      invokeCalls.some((call) => {
        const input = call[3] as { size?: { fullWidth?: boolean } } | undefined;
        return (
          call[0] === "window-session-view:panel-patch" &&
          call[1] === "session:alpha:overlay-restore" &&
          call[2] === "right" &&
          input?.size?.fullWidth === false
        );
      }),
    ).toBe(true);
  });

  test("full-width page-stage overlay state keeps card toolbar actions clickable after pointerdown", async () => {
    const session = makeAttachedSession({
      id: "session:alpha:overlay-page-stage",
      tabs: [
        {
          id: "page-stage-tab",
          kind: "page_stage",
          title: "Card One",
          config: { projectId: "alpha", pageId: "card-1", titleSnapshot: "Card One" },
        },
      ],
      panels: makePanels({
        rightTabIds: ["page-stage-tab"],
        rightActiveTabId: "page-stage-tab",
        rightFullWidth: true,
      }),
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();
    await settleAsyncRender();

    const props = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(props?.rightPanelComposerOverlayEnabled).toBe(true);
    expect(
      screen.getByTestId("session-right-panel").getAttribute("data-right-panel-width-mode"),
    ).toBe("full");
    expect(
      screen.getByRole("tab", { name: "Card One" }).querySelector("[data-file-page-icon]"),
    ).not.toBeNull();

    await pointerActivate(screen.getByRole("button", { name: "History" }));
    await pointerActivate(screen.getByRole("button", { name: "Delete" }));

    expect(
      (globalThis as { __mockPageStageHistoryClicks?: number }).__mockPageStageHistoryClicks,
    ).toBe(1);
    expect(
      (globalThis as { __mockPageStageDeleteClicks?: number }).__mockPageStageDeleteClicks,
    ).toBe(1);
  });

  test("toggles the active page-stage history overlay from the toolbar", async () => {
    const session = makeAttachedSession({
      id: "session:alpha:history-toggle",
      tabs: [
        {
          id: "page-stage-tab",
          kind: "page_stage",
          title: "Card One",
          config: { projectId: "alpha", pageId: "card-1", titleSnapshot: "Card One" },
        },
      ],
      panels: makePanels({
        rightTabIds: ["page-stage-tab"],
        rightActiveTabId: "page-stage-tab",
      }),
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();
    await settleAsyncRender();

    expect(screen.queryByTestId("page-history-panel")).toBe(null);
    let pageStageProps = (globalThis as { __lastPageStageProps?: Record<string, unknown> })
      .__lastPageStageProps;
    expect(pageStageProps?.historyPanelActive).toBe(false);

    await pointerActivate(screen.getByRole("button", { name: "History" }));
    await settleAsyncRender();

    const openedPanel = screen.getByTestId("page-history-panel");
    expect(openedPanel.getAttribute("data-project-id")).toBe("alpha");
    expect(openedPanel.getAttribute("data-uuid-v7")).toBe("card-1");
    pageStageProps = (globalThis as { __lastPageStageProps?: Record<string, unknown> })
      .__lastPageStageProps;
    expect(pageStageProps?.historyPanelActive).toBe(true);
    const historyPanelProps = (globalThis as { __lastHistoryPanelProps?: Record<string, unknown> })
      .__lastHistoryPanelProps;
    expect(typeof historyPanelProps?.onPageMutated).toBe("function");

    await pointerActivate(screen.getByRole("button", { name: "History" }));
    await settleAsyncRender();

    expect(screen.queryByTestId("page-history-panel")).toBe(null);
    pageStageProps = (globalThis as { __lastPageStageProps?: Record<string, unknown> })
      .__lastPageStageProps;
    expect(pageStageProps?.historyPanelActive).toBe(false);

    await pointerActivate(screen.getByRole("button", { name: "History" }));
    await settleAsyncRender();
    await pointerActivate(screen.getByRole("button", { name: "Close history panel" }));
    await settleAsyncRender();

    expect(screen.queryByTestId("page-history-panel")).toBe(null);
    pageStageProps = (globalThis as { __lastPageStageProps?: Record<string, unknown> })
      .__lastPageStageProps;
    expect(pageStageProps?.historyPanelActive).toBe(false);
  });

  test("closes the page-stage history modal when the owning tab closes", async () => {
    const session = makeAttachedSession({
      id: "session:alpha:history-close-owner",
      tabs: [
        {
          id: "db-tab",
          kind: "db_view",
          title: "DB View",
          config: { projectId: "alpha" },
        },
        {
          id: "page-stage-tab",
          kind: "page_stage",
          title: "Card One",
          config: { projectId: "alpha", pageId: "card-1", titleSnapshot: "Card One" },
        },
      ],
      panels: makePanels({
        rightTabIds: ["db-tab", "page-stage-tab"],
        rightActiveTabId: "page-stage-tab",
      }),
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();
    await settleAsyncRender();

    await pointerActivate(screen.getByRole("button", { name: "History" }));
    await settleAsyncRender();
    expect(screen.queryByTestId("page-history-panel") !== null).toBe(true);

    await pointerActivate(screen.getByRole("button", { name: "Close Card One tab" }));
    await settleAsyncRender();
    await settleAsyncRender();

    expect(screen.queryByTestId("page-history-panel")).toBe(null);
    const historyPanelProps = (globalThis as { __lastHistoryPanelProps?: Record<string, unknown> })
      .__lastHistoryPanelProps;
    expect(historyPanelProps?.open).toBe(false);
  });

  test("regular width and terminal right-panel tabs do not enable the root composer overlay", async () => {
    const regularSession = makeAttachedSession({
      id: "session:alpha:regular",
      rightCollapsed: false,
    });
    const regularScreen = renderWorkbench({
      sessionsByProject: { alpha: [regularSession] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    let props = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(props?.rightPanelComposerOverlayEnabled).toBe(false);
    regularScreen.unmount();

    const terminalSession = makeAttachedSession({
      id: "session:alpha:terminal-right",
      tabs: [
        {
          id: "terminal-tab",
          kind: "terminal",
          title: "Terminal",
          panelId: "right",
          config: { terminalSessionId: "terminal" },
        },
      ],
      rightLayout: makePanelLayout(["terminal-tab"], "terminal-tab"),
      rightFullWidth: true,
    });
    const terminalScreen = renderWorkbench({
      sessionsByProject: { alpha: [terminalSession] },
    });
    await settleAsyncRender();
    await settleAsyncRender();
    await settleAsyncRender();

    props = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(
      terminalScreen.getByTestId("session-right-panel").getAttribute("data-right-panel-width-mode"),
    ).toBe("full");
    expect(props?.rightPanelComposerOverlayEnabled).toBe(false);
  });

  test("open session right panel keeps side toggle global and expands from the tab header", async () => {
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [
          makeSession({
            id: "session:alpha:build",
            title: "Build",
            rightCollapsed: false,
          }),
        ],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const globalHeader = screen.container.querySelector('[data-testid="workbench-global-header"]');
    const rightPanel = screen.container.querySelector('[data-testid="session-right-panel"]');
    const headerCenterSurface = screen.getByTestId("app-shell-header-context-menu-surface");
    const tabHeader = rightPanel?.querySelector('[role="tablist"]')?.parentElement?.parentElement;
    const headerShellSlot = getHeaderShellSlot(screen, "right");
    if (!tabHeader) throw new Error("Expected right-panel tab header");

    const sidePanelToggle = screen.getByRole("button", { name: "Toggle side panel" });
    const expandButton = screen.getByRole("button", { name: "Expand panel" });
    const rightPanelHeaderSpacer = screen.container.querySelector(
      '[data-testid="right-panel-tab-bar-header-spacer"]',
    );
    const expandIconPath = expandButton.querySelector("path")?.getAttribute("d") ?? "";
    const visibleGlobalHeaderButtons = Array.from(
      headerShellSlot?.querySelectorAll("button") ?? [],
    );
    expect(globalHeader?.contains(sidePanelToggle)).toBe(true);
    expect(headerShellSlot?.contains(sidePanelToggle)).toBe(true);
    expect(
      visibleGlobalHeaderButtons.map((button) => button.getAttribute("aria-label")).join(","),
    ).toBe("Toggle bottom panel,Toggle side panel");
    expect(rightPanel?.className.includes(APP_SHELL_RIGHT_PANEL_LAYER_CLASS)).toBe(true);
    expect(globalHeader?.className.includes(APP_SHELL_GLOBAL_HEADER_LAYER_CLASS)).toBe(true);
    expect(headerCenterSurface.getAttribute("aria-hidden")).toBe(null);
    expect(headerCenterSurface.className.includes("invisible")).toBe(false);
    expect(headerShellSlot?.className.includes("no-drag")).toBe(true);
    await waitFor(() => {
      expect(headerShellSlot?.getAttribute("style")?.includes("width: 372px")).toBe(true);
    });
    expect(headerShellSlot?.getAttribute("style")?.includes("min-width: 70px")).toBe(true);
    expect(sidePanelToggle.getAttribute("aria-pressed")).toBe("true");
    expect(globalHeader?.contains(expandButton)).toBe(false);
    expect(tabHeader.contains(expandButton)).toBe(true);
    expect(tabHeader.className.includes("draggable")).toBe(false);
    expect(expandButton.parentElement?.className.includes("pointer-events-auto")).toBe(true);
    expect(rightPanelHeaderSpacer?.className.includes("pointer-events-none")).toBe(true);
    expect(rightPanelHeaderSpacer?.className.includes("no-drag")).toBe(true);
    expect(rightPanelHeaderSpacer?.parentElement?.className.includes("pointer-events-auto")).toBe(
      false,
    );
    expect(rightPanelHeaderSpacer?.parentElement?.className.includes("no-drag")).toBe(true);
    expect(rightPanelHeaderSpacer?.parentElement?.getAttribute("role")).toBe("presentation");
    expect(expandButton.className.includes("no-drag")).toBe(true);
    expect(expandIconPath.startsWith(EXPAND_PANEL_ICON_PREFIX)).toBe(true);
    expect(rightPanelHeaderSpacer?.getAttribute("style")?.includes("width: calc(70px)")).toBe(true);
    expect(
      screen.container.querySelector('[data-testid="right-panel-global-header-actions"]') === null,
    ).toBe(true);

    await act(async () => {
      fireEvent.click(expandButton);
      await Promise.resolve();
    });

    const threadPage = screen.container.querySelector('[data-testid="session-thread-page"]');
    expect(rightPanel?.getAttribute("data-right-panel-width-mode")).toBe("full");
    expect(rightPanel?.getAttribute("data-app-shell-focus-area")).toBe("right-panel");
    expect(rightPanel?.className.includes(APP_SHELL_RIGHT_PANEL_LAYER_CLASS)).toBe(true);
    expect(globalHeader?.className.includes(APP_SHELL_GLOBAL_HEADER_LAYER_CLASS)).toBe(true);
    expect(headerCenterSurface.getAttribute("aria-hidden")).toBe("true");
    expect(headerCenterSurface.className.includes("invisible")).toBe(true);
    expect(rightPanel?.className.includes("shadow-xl")).toBe(false);
    expect(threadPage?.getAttribute("data-session-thread-page-hidden")).toBe("true");
    expect(threadPage?.className.includes("w-0")).toBe(true);
    expect(threadPage?.className.includes("flex-none")).toBe(true);
    expect(headerShellSlot?.getAttribute("style")?.includes("width: 0px")).toBe(true);
    expect(screen.queryByRole("separator", { name: "Resize right panel" })).toBe(null);
    const fullWidthTabHeader =
      rightPanel?.querySelector('[role="tablist"]')?.parentElement?.parentElement;
    expect(fullWidthTabHeader?.firstElementChild?.querySelector('[role="tablist"]') !== null).toBe(
      true,
    );
    const restoreButton = screen.getByRole("button", { name: "Restore panel width" });
    expect(globalHeader?.contains(restoreButton)).toBe(false);
    expect(fullWidthTabHeader?.contains(restoreButton)).toBe(true);
    expect(restoreButton.getAttribute("aria-pressed")).toBe("true");
    expect(
      restoreButton.querySelector("path")?.getAttribute("d")?.startsWith(RESTORE_PANEL_ICON_PREFIX),
    ).toBe(true);
  });

  test("right panel resize previews the dragged width before persistence", async () => {
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [
          makeSession({
            id: "session:alpha:build",
            title: "Build",
            rightCollapsed: false,
          }),
        ],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const rightPanel = screen.getByTestId("session-right-panel");
    const separator = screen.getByRole("separator", { name: "Resize right panel" });
    let capturedPointerId: number | null = null;
    separator.setPointerCapture = (pointerId: number) => {
      capturedPointerId = pointerId;
    };
    await waitFor(() => {
      expect(rightPanel.getAttribute("style")?.includes("width: 372px")).toBe(true);
    });

    try {
      await act(async () => {
        fireEvent.pointerDown(separator, { button: 0, pointerId: 7, clientX: 700 });
        fireEvent.pointerMove(window, { pointerId: 7, clientX: 750 });
        await Promise.resolve();
      });

      expect(capturedPointerId).toBe(7);
      await waitFor(() => {
        expect(rightPanel.getAttribute("style")?.includes("width: 322px")).toBe(true);
      });
      expect(
        invokeCalls.some(
          (call) =>
            call[0] === "window-session-view:panel-patch" &&
            call[1] === "session:alpha:build" &&
            call[2] === "right" &&
            ((call[3] as { size?: { widthPx?: number } })?.size?.widthPx ?? null) === 322,
        ),
      ).toBe(false);
    } finally {
      await releasePointerDrag(7);
    }

    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:panel-patch" &&
          call[1] === "session:alpha:build" &&
          call[2] === "right" &&
          ((call[3] as { size?: { widthPx?: number } })?.size?.widthPx ?? null) === 322,
      ),
    ).toBe(true);
  });

  test("right panel content canvas shrinks with the sash after collapse and reopen", async () => {
    const restoreMatchMedia = installReducedMotionMatchMediaForTest();
    try {
      const screen = renderWorkbench({
        sessionsByProject: {
          alpha: [
            makeSession({
              id: "session:alpha:reopen-resize",
              title: "Reopen resize",
              rightCollapsed: false,
            }),
          ],
        },
      });
      await settleAsyncRender();
      await settleAsyncRender();

      const toggleButton = screen.getByRole("button", { name: "Toggle side panel" });
      await act(async () => {
        fireEvent.click(toggleButton);
        await Promise.resolve();
      });
      await settleAsyncRender();
      expect(screen.queryByTestId("session-right-panel")).toBe(null);

      await act(async () => {
        fireEvent.click(toggleButton);
        await Promise.resolve();
      });
      await settleAsyncRender();

      const rightPanel = screen.getByTestId("session-right-panel");
      const contentCanvas = rightPanel.querySelector<HTMLElement>(
        '[data-right-panel-composer-overlay-host="true"]',
      );
      if (!contentCanvas) throw new Error("Expected right-panel content canvas");
      const separator = screen.getByRole("separator", { name: "Resize right panel" });
      await waitFor(() => {
        expect(rightPanel.style.width).toBe("372px");
        expect(contentCanvas.style.width).toBe("372px");
      });

      try {
        await act(async () => {
          fireEvent.pointerDown(separator, { button: 0, pointerId: 9, clientX: 700 });
          fireEvent.pointerMove(window, { pointerId: 9, clientX: 750 });
          await Promise.resolve();
        });

        await waitFor(() => {
          const panelWidth = Number.parseFloat(rightPanel.style.width);
          const canvasWidth = Number.parseFloat(contentCanvas.style.width);
          const canvasMinimumWidth = Number.parseFloat(contentCanvas.style.minWidth || "0");
          expect(panelWidth).toBe(322);
          expect(canvasWidth).toBe(panelWidth);
          expect(canvasMinimumWidth).toBeLessThanOrEqual(panelWidth);
        });
      } finally {
        await releasePointerDrag(9);
      }
    } finally {
      restoreMatchMedia();
    }
  });

  test("right panel resize can grow well beyond the default width on wide shells", async () => {
    setWindowInnerWidthForTest(1800);
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [
          makeSession({
            id: "session:alpha:build",
            title: "Build",
            rightCollapsed: false,
          }),
        ],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const rightPanel = screen.getByTestId("session-right-panel");
    const separator = screen.getByRole("separator", { name: "Resize right panel" });

    try {
      await act(async () => {
        fireEvent.pointerDown(separator, { button: 0, pointerId: 1, clientX: 1_200 });
        fireEvent.pointerMove(window, { pointerId: 1, clientX: 400 });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(rightPanel.getAttribute("style")?.includes("width: 1148px")).toBe(true);
      });
    } finally {
      await releasePointerDrag();
    }

    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:panel-patch" &&
          call[1] === "session:alpha:build" &&
          call[2] === "right" &&
          ((call[3] as { size?: { widthPx?: number } })?.size?.widthPx ?? null) === 1148,
      ),
    ).toBe(true);
  });

  test("right panel resize closes the side panel when dragged below Codex minimum width", async () => {
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [
          makeSession({
            id: "session:alpha:build",
            title: "Build",
            rightCollapsed: false,
          }),
        ],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const separator = screen.getByRole("separator", { name: "Resize right panel" });
    await act(async () => {
      fireEvent.pointerDown(separator, { button: 0, pointerId: 1, clientX: 700 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 1_020 });
      await Promise.resolve();
    });
    await releasePointerDrag();

    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:panel-patch" &&
          call[1] === "session:alpha:build" &&
          call[2] === "right" &&
          JSON.stringify(call[3]) === JSON.stringify({ collapsed: true }),
      ),
    ).toBe(true);
    expect(screen.queryByRole("separator", { name: "Resize right panel" })).toBe(null);
  });

  test("right panel resize normalizes drag deltas by the Codex window zoom", async () => {
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [
          makeSession({
            id: "session:alpha:build",
            title: "Build",
            rightCollapsed: false,
          }),
        ],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const workbenchRoot = screen.getByTestId("workbench-global-header")
      .parentElement as HTMLElement | null;
    workbenchRoot?.style.setProperty("--codex-window-zoom", "2");
    const rightPanel = screen.getByTestId("session-right-panel");
    const separator = screen.getByRole("separator", { name: "Resize right panel" });

    try {
      await act(async () => {
        fireEvent.pointerDown(separator, { button: 0, pointerId: 1, clientX: 1_400 });
        fireEvent.pointerMove(window, { pointerId: 1, clientX: 1_500 });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(rightPanel.getAttribute("style")?.includes("width: 322px")).toBe(true);
      });
    } finally {
      await releasePointerDrag();
    }

    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:panel-patch" &&
          call[1] === "session:alpha:build" &&
          call[2] === "right" &&
          ((call[3] as { size?: { widthPx?: number } })?.size?.widthPx ?? null) === 322,
      ),
    ).toBe(true);
  });

  test("bottom panel resize previews the dragged height before persistence", async () => {
    const terminalSession = makeBottomPanelTerminalSession();
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [terminalSession] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const bottomPanel = screen.getByTestId("session-bottom-panel");
    const bottomPanelSizer = getBottomPanelContentSizer(bottomPanel);
    const separator = screen.getByRole("separator", { name: "Resize bottom panel" });
    expect(bottomPanelSizer.getAttribute("style")?.includes("height: 280px")).toBe(true);

    try {
      await act(async () => {
        fireEvent.pointerDown(separator, { button: 0, pointerId: 1, clientY: 700 });
        fireEvent.pointerMove(window, { pointerId: 1, clientY: 740 });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(bottomPanelSizer.getAttribute("style")?.includes("height: 240px")).toBe(true);
      });
      expect(
        invokeCalls.some(
          (call) =>
            call[0] === "window-session-view:panel-patch" &&
            call[1] === "session:alpha:terminal" &&
            call[2] === "bottom" &&
            ((call[3] as { size?: { heightPx?: number } })?.size?.heightPx ?? null) === 240,
        ),
      ).toBe(false);
    } finally {
      await releasePointerDrag();
    }

    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:panel-patch" &&
          call[1] === "session:alpha:terminal" &&
          call[2] === "bottom" &&
          ((call[3] as { size?: { heightPx?: number } })?.size?.heightPx ?? null) === 240,
      ),
    ).toBe(true);
  });

  test("bottom panel resize closes the bottom panel when dragged below Codex minimum height", async () => {
    const terminalSession = makeBottomPanelTerminalSession();
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [terminalSession] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const separator = screen.getByRole("separator", { name: "Resize bottom panel" });
    await act(async () => {
      fireEvent.pointerDown(separator, { button: 0, pointerId: 1, clientY: 700 });
      fireEvent.pointerMove(window, { pointerId: 1, clientY: 900 });
      await Promise.resolve();
    });
    await releasePointerDrag();

    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:panel-patch" &&
          call[1] === "session:alpha:terminal" &&
          call[2] === "bottom" &&
          JSON.stringify(call[3]) === JSON.stringify({ collapsed: true }),
      ),
    ).toBe(true);
    expect(screen.queryByRole("separator", { name: "Resize bottom panel" })).toBe(null);
  });

  test("terminal backend exit closes the owning terminal tab", async () => {
    const terminalEventListeners = installTerminalEventApiMock();
    const terminalSession = makeBottomPanelTerminalSession();
    renderWorkbench({
      sessionsByProject: { alpha: [terminalSession] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(typeof terminalEventListeners["terminal-exit"]).toBe("function");

    await act(async () => {
      terminalEventListeners["terminal-exit"]?.({
        sessionId: "terminal",
        exitCode: 0,
      });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(JSON.stringify(getWorkbenchTabProjectionDeleteTabIds())).toBe(
      JSON.stringify(["terminal-tab"]),
    );
  });

  test("overview regular-width override survives hiding and showing the side panel", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restore panel width" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    const regularRightPanel = screen.getByTestId("session-right-panel");
    const regularThreadPage = screen.container.querySelector('[data-testid="session-thread-page"]');
    const expandButton = screen.getByRole("button", { name: "Expand panel" });
    expect(regularRightPanel.getAttribute("data-right-panel-width-mode")).toBe("regular");
    expect(regularThreadPage?.getAttribute("data-session-thread-page-hidden")).toBe("false");
    expect(regularThreadPage?.className.split(/\s+/).includes("w-0")).toBe(false);
    expect(expandButton.getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Toggle side panel" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(screen.queryByRole("button", { name: "Restore panel width" })).toBe(null);
    expect(screen.queryByRole("separator", { name: "Resize right panel" })).toBe(null);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Toggle side panel" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    const restoredRightPanel = screen.getByTestId("session-right-panel");
    const restoredThreadPage = screen.container.querySelector(
      '[data-testid="session-thread-page"]',
    );
    const restoredExpandButton = screen.getByRole("button", { name: "Expand panel" });
    expect(restoredRightPanel.getAttribute("data-right-panel-width-mode")).toBe("regular");
    expect(restoredThreadPage?.getAttribute("data-session-thread-page-hidden")).toBe("false");
    expect(restoredThreadPage?.className.split(/\s+/).includes("w-0")).toBe(false);
    expect(restoredExpandButton.getAttribute("aria-pressed")).toBe("false");
  });

  test("right-panel Files action creates a durable empty tab and exempts navigation from pinning", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();
    await settleAsyncRender();

    const globalHeader = screen.container.querySelector('[data-testid="workbench-global-header"]');
    const addTabButton = screen.getByRole("button", { name: "Open side panel tab" });
    expect(globalHeader?.contains(addTabButton)).toBe(false);
    expect(screen.queryByRole("button", { name: "Add DB view" })).toBe(null);

    const menu = await openPanelMenu(screen, "Open side panel tab");
    await clickMenuItem(menu, "Files");

    expect(screen.getByRole("tab", { name: "Files" }) !== null).toBe(true);
    await waitFor(() => {
      expect(
        invokeCalls.some(
          (call) =>
            call[0] === "window-session-view:tab-create" &&
            JSON.stringify(call[1]).includes('"kind":"files"'),
        ),
      ).toBe(true);
    });
    expect(screen.container.querySelector('[data-app-shell-tabpanel-preview="true"]')).toBe(null);
    const fileTabCreateCount = invokeCalls.filter(
      (call) =>
        call[0] === "window-session-view:tab-create" &&
        JSON.stringify(call[1]).includes('"kind":"files"'),
    ).length;

    await pointerDownAndSettle(getFilesPreviewInteractionTarget(screen));
    expect(
      invokeCalls.filter(
        (call) =>
          call[0] === "window-session-view:tab-create" &&
          JSON.stringify(call[1]).includes('"kind":"files"'),
      ),
    ).toHaveLength(fileTabCreateCount);
  });

  test("proposed-plan side panel opens as a renderer-local singleton tab", async () => {
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeAttachedSession({ rightCollapsed: true })] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    let stageProps = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(JSON.stringify(stageProps?.planSidePanelState)).toBe(
      JSON.stringify({
        rightPanelEnabled: true,
        activePlanKey: null,
        activeRightPanelTabId: null,
      }),
    );

    const actions = getLastThreadStageActions();
    const openPlan = actions.onOpenPlanInSidePanel as
      | ((input: {
          planKey: string;
          threadId: string;
          turnId: string;
          itemId: string;
          content: string;
          cwd: string | null;
        }) => Promise<void>)
      | undefined;
    expect(typeof openPlan).toBe("function");
    const closePlan = actions.onClosePlanSidePanel as
      | ((input: { planKey: string }) => Promise<void>)
      | undefined;
    expect(typeof closePlan).toBe("function");

    await act(async () => {
      await openPlan?.({
        planKey: "turn-plan-1",
        threadId: "thread-alpha",
        turnId: "turn-plan-1",
        itemId: "plan-item-1",
        content: "# First plan\n\nUse the side panel.",
        cwd: "/Users/asc/repo/nodex",
      });
    });
    await settleAsyncRender();

    expect(screen.getByRole("tab", { name: "Plan" }) !== null).toBe(true);
    expect(textContent(screen.container).includes("First plan")).toBe(true);
    expect(invokeCalls.some((call) => call[0] === "window-session-view:tab-create")).toBe(false);

    stageProps = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(JSON.stringify(stageProps?.planSidePanelState)).toBe(
      JSON.stringify({
        rightPanelEnabled: true,
        activePlanKey: "turn-plan-1",
        activeRightPanelTabId: "plan",
      }),
    );

    await act(async () => {
      await openPlan?.({
        planKey: "turn-plan-2",
        threadId: "thread-alpha",
        turnId: "turn-plan-2",
        itemId: "plan-item-2",
        content: "# Second plan\n\nReplace the singleton content.",
        cwd: "/Users/asc/repo/nodex",
      });
    });
    await settleAsyncRender();

    const planTabs = screen.getAllByRole("tab").filter((tab) => textContent(tab).includes("Plan"));
    expect(planTabs.length).toBe(1);
    expect(textContent(screen.container).includes("First plan")).toBe(false);
    expect(textContent(screen.container).includes("Second plan")).toBe(true);
    expect(invokeCalls.some((call) => call[0] === "window-session-view:tab-create")).toBe(false);

    stageProps = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(JSON.stringify(stageProps?.planSidePanelState)).toBe(
      JSON.stringify({
        rightPanelEnabled: true,
        activePlanKey: "turn-plan-2",
        activeRightPanelTabId: "plan",
      }),
    );
  });

  test("summary output side-panel opener creates a renderer-local Files preview tab", async () => {
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeAttachedSession({ rightCollapsed: true })] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const actions = getLastThreadStageActions();
    const openOutput = actions.onOpenSummaryOutputInSidePanel as
      | ((input: {
          cwd?: string | null;
          path: string;
          title: string;
          workspaceRoot?: string | null;
        }) => Promise<boolean>)
      | undefined;
    expect(typeof openOutput).toBe("function");

    let opened = false;
    await act(async () => {
      opened =
        (await openOutput?.({
          cwd: "/Users/asc/.nodex/worktrees/abcd/nodex",
          path: "/Users/asc/.nodex/worktrees/abcd/nodex/reports/summary.txt",
          title: "summary.txt",
          workspaceRoot: "/Users/asc/.nodex/worktrees/abcd/nodex",
        })) ?? false;
    });
    await settleAsyncRender();

    expect(opened).toBe(true);
    expect(screen.getByRole("tab", { name: "summary.txt" }) !== null).toBe(true);
    expect(
      screen.container.querySelector('[data-app-shell-tabpanel-preview="true"]') !== null,
    ).toBe(true);
    expect(invokeCalls.some((call) => call[0] === "window-session-view:tab-create")).toBe(false);
    const metadataCall = invokeCalls.find((call) => call[0] === "read-file-metadata");
    expect(JSON.stringify(metadataCall?.[1])).toContain(
      "/Users/asc/.nodex/worktrees/abcd/nodex/reports/summary.txt",
    );
    expect(JSON.stringify(metadataCall?.[1])).not.toContain("workspaceRoot");
  });

  test("a Files tree interaction replaces the existing preview without persisting it", async () => {
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeAttachedSession({ rightCollapsed: true })] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const openOutput = getLastThreadStageActions().onOpenSummaryOutputInSidePanel as
      | ((input: {
          cwd?: string | null;
          path: string;
          title: string;
          workspaceRoot?: string | null;
        }) => Promise<boolean>)
      | undefined;
    expect(typeof openOutput).toBe("function");

    await act(async () => {
      await openOutput?.({
        cwd: "/Users/asc/repo/nodex",
        path: "/Users/asc/repo/nodex/reports/summary.txt",
        title: "summary.txt",
        workspaceRoot: "/Users/asc/repo/nodex",
      });
    });
    await settleAsyncRender();

    const firstTab = screen.getByRole("tab", { name: "summary.txt" });
    const previewChrome = firstTab.closest("[data-app-shell-tab-controller]");
    const fileTreeSurface = screen.container.querySelector(
      "aside[data-tab-preview-pin-exempt='true']",
    );
    if (!(fileTreeSurface instanceof HTMLElement)) {
      throw new Error("Expected the Files tree surface");
    }

    await pointerDownAndSettle(fileTreeSurface);
    await act(async () => {
      await openOutput?.({
        cwd: "/Users/asc/repo/nodex",
        path: "/Users/asc/repo/nodex/reports/details.json",
        title: "details.json",
        workspaceRoot: "/Users/asc/repo/nodex",
      });
    });
    await settleAsyncRender();

    const replacementTab = screen.getByRole("tab", { name: "details.json" });
    expect(screen.queryByRole("tab", { name: "summary.txt" })).toBe(null);
    expect(replacementTab.closest("[data-app-shell-tab-controller]")).toBe(previewChrome);
    expect(replacementTab.querySelector("[data-file-tab-icon='json']")).not.toBe(null);
    expect(
      screen.container.querySelectorAll('[data-app-shell-tabpanel-preview="true"]'),
    ).toHaveLength(1);
    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:tab-create" &&
          JSON.stringify(call[1]).includes('"kind":"files"'),
      ),
    ).toBe(false);
  });

  test("uses the matching secondary Project source only as Files tree context", async () => {
    const primaryRoot = "/Users/asc/repo/alpha";
    const secondaryRoot = "/Volumes/code/alpha-secondary";
    const project = makeProject("alpha", "Alpha", primaryRoot);
    project.sources = [
      { root: primaryRoot, order: 0 },
      { root: secondaryRoot, order: 1 },
    ];
    const screen = renderWorkbench({
      projects: [project],
      sessionsByProject: {
        alpha: [makeAttachedSession({ rightCollapsed: true })],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const openOutput = getLastThreadStageActions().onOpenSummaryOutputInSidePanel as
      | ((input: { path: string; title: string }) => Promise<boolean>)
      | undefined;
    await act(async () => {
      await openOutput?.({
        path: `${secondaryRoot}/reports/summary.txt`,
        title: "summary.txt",
      });
    });
    await settleAsyncRender();

    expect(screen.getByRole("tab", { name: "summary.txt" }) !== null).toBe(true);
    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "workspace-directory-entries" &&
          JSON.stringify(call[1]).includes(`"workspaceRoot":"${secondaryRoot}"`),
      ),
    ).toBe(true);
    expect(
      invokeCalls.some(
        (call) =>
          ["read-file-metadata", "read-file"].includes(String(call[0])) &&
          JSON.stringify(call[1]).includes("workspaceRoot"),
      ),
    ).toBe(false);
  });

  test("summary output side-panel opener supports projectless file previews", async () => {
    const projectlessSession = makeAttachedSession({
      id: "session:projectless:summary-output",
      projectId: null,
      title: "Projectless output",
      threadId: "thread-projectless-output",
      rightCollapsed: true,
      tabs: [],
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [] },
      projectlessSessions: [projectlessSession],
      initialSelectedSessionId: projectlessSession.id,
    });
    await settleAsyncRender();
    await settleAsyncRender();
    await waitFor(() => {
      expect(getThreadRow(screen.container, "Projectless output") !== null).toBe(true);
    });
    await act(async () => {
      fireEvent.click(getThreadRow(screen.container, "Projectless output"));
      await Promise.resolve();
    });
    await settleAsyncRender();
    await waitFor(() => {
      expect(
        Boolean(
          (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
            .__lastConnectedThreadStageProps?.actions,
        ),
      ).toBe(true);
    });

    const actions = getLastThreadStageActions();
    const openOutput = actions.onOpenSummaryOutputInSidePanel as
      | ((input: { path: string; title: string }) => Promise<boolean>)
      | undefined;
    expect(typeof openOutput).toBe("function");

    let opened = false;
    await act(async () => {
      opened =
        (await openOutput?.({
          path: "/Users/asc/Downloads/nodex-output/report.md",
          title: "report.md",
        })) ?? false;
    });
    await settleAsyncRender();

    expect(opened).toBe(true);
    expect(screen.getByRole("tab", { name: "report.md" }) !== null).toBe(true);
    expect(
      screen.container.querySelector(
        '[data-workspace-files-session-id="session:projectless:summary-output"]',
      ) !== null,
    ).toBe(true);
    expect(invokeCalls.some((call) => call[0] === "window-session-view:tab-create")).toBe(false);

    await pointerDownAndSettle(getFilesPreviewInteractionTarget(screen));
    await waitFor(() => {
      expect(
        invokeCalls.some(
          (call) =>
            call[0] === "window-session-view:tab-create" &&
            JSON.stringify(call[1]).includes('"kind":"files"') &&
            JSON.stringify(call[1]).includes('"projectId":null'),
        ),
      ).toBe(true);
    });
  });

  test("opening a Browser preview preserves the durable empty Files tab", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();
    await settleAsyncRender();

    const filesMenu = await openPanelMenu(screen, "Open side panel tab");
    await clickMenuItem(filesMenu, "Files");

    expect(screen.getByRole("tab", { name: "Files" }) !== null).toBe(true);

    const browserMenu = await openPanelMenu(screen, "Open side panel tab");
    await clickMenuItem(browserMenu, "Browser");

    expect(screen.getByRole("tab", { name: "Files" }) !== null).toBe(true);
    expect(screen.getByRole("tab", { name: "Browser" }) !== null).toBe(true);
    expect(
      screen.container.querySelector('[data-app-shell-tabpanel-preview="true"]') !== null,
    ).toBe(true);
    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:tab-create" &&
          JSON.stringify(call[1]).includes('"kind":"files"'),
      ),
    ).toBe(true);
  });

  test("threadless empty right panel omits attached-chat actions", async () => {
    const emptySession = makeSession({
      id: "session:alpha:empty",
      tabs: [],
      rightLayout: makePanelLayout([], null),
    });
    const screen = renderWorkbench({
      projects: [makeProject("alpha", "Alpha", "/Users/asc/repo/project-workspace")],
      sessionsByProject: { alpha: [emptySession] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const actionGrid = screen.container.querySelector(
      '[data-thread-side-panel-new-tab-action-grid="true"]',
    );
    expect(actionGrid !== null).toBe(true);
    if (!(actionGrid instanceof HTMLElement)) throw new Error("Expected right-panel action grid");
    const actionText = textContent(actionGrid);
    expect(actionText.includes("Review")).toBe(false);
    expect(actionText.indexOf("Terminal") < actionText.indexOf("Browser")).toBe(true);
    expect(actionText.indexOf("Browser") < actionText.indexOf("Files")).toBe(true);
    expect(within(actionGrid).queryByRole("button", { name: /Review/ })).toBe(null);
    expect(screen.getByRole("button", { name: /Terminal/ }) !== null).toBe(true);
    expect(screen.getByRole("button", { name: /Browser/ }) !== null).toBe(true);
    expect(screen.getByRole("button", { name: /Files/ }) !== null).toBe(true);
    expect(screen.queryByRole("button", { name: /Side chat/ })).toBe(null);
    expect(screen.getByRole("button", { name: /DB View/ }) !== null).toBe(true);
    expect(within(actionGrid).getByRole("button", { name: "Page" }) !== null).toBe(true);
    expect(actionText.indexOf("Files") < actionText.indexOf("DB View")).toBe(true);
    expect(actionText.indexOf("DB View") < actionText.indexOf("Page")).toBe(true);
    expect(textContent(actionGrid).includes("⌃⇧G")).toBe(false);
    expect(textContent(actionGrid).includes("⌃`")).toBe(true);
    expect(textContent(actionGrid).includes("Ctrl+T")).toBe(true);
    expect(textContent(actionGrid).includes("Ctrl+Shift+E")).toBe(true);
    expect(textContent(actionGrid).includes("Alt+Ctrl+S")).toBe(false);
  });

  test("attached projectless chats expose and dispatch conversation-native panel tools", async () => {
    const projectlessSession = makeAttachedSession({
      id: "session:projectless:tools",
      projectId: null,
      title: "Projectless tools",
      threadId: "thread-projectless-tools",
      tabs: [],
      rightCollapsed: false,
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [] },
      projectlessSessions: [projectlessSession],
      initialSelectedSessionId: projectlessSession.id,
    });
    await settleAsyncRender();
    await act(async () => {
      fireEvent.click(getThreadRow(screen.container, "Projectless tools"));
      await Promise.resolve();
    });
    await settleAsyncRender();
    const actionGrid = screen.container.querySelector(
      '[data-thread-side-panel-new-tab-action-grid="true"]',
    );
    if (!actionGrid) throw new Error("Expected projectless right-panel action grid");
    const actionText = textContent(actionGrid);
    expect(actionText.indexOf("Side chat") < actionText.indexOf("Browser")).toBe(true);
    expect(actionText.indexOf("Browser") < actionText.indexOf("Terminal")).toBe(true);
    expect(actionText.includes("Files")).toBe(false);
    expect(actionText.includes("Review")).toBe(true);

    const menu = await openPanelMenu(screen, "Open side panel tab");
    expect(within(menu).getByText("Side chat") !== null).toBe(true);
    expect(within(menu).getByText("Browser") !== null).toBe(true);
    expect(within(menu).getByText("Terminal") !== null).toBe(true);
    expect(within(menu).getByText("Review") !== null).toBe(true);
    expect(within(menu).queryByText("Files")).toBe(null);

    await clickMenuItem(menu, "Side chat");
    await waitFor(() => {
      expect(startSideChatCalls).toHaveLength(1);
    });
    const sideChatInput = startSideChatCalls[0] as Record<string, unknown>;
    expect("projectId" in sideChatInput).toBe(false);
    expect(sideChatInput.parentNavigationPath).toBe(
      "session:session:projectless:tools/thread:thread-projectless-tools",
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close Side chat tab" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
      await Promise.resolve();
    });
    await openBottomPanel(screen);
    const bottomMenu = await openPanelMenu(screen, "Open bottom panel tab");
    const bottomMenuText = textContent(bottomMenu);
    expect(bottomMenuText.indexOf("Side chat") < bottomMenuText.indexOf("Browser")).toBe(true);
    expect(bottomMenuText.indexOf("Browser") < bottomMenuText.indexOf("Terminal")).toBe(true);
    expect(within(bottomMenu).queryByText("Files")).toBe(null);

    await clickMenuItem(bottomMenu, "Terminal");
    await settleAsyncRender();
    const createCall = invokeCalls.find(
      (call) =>
        call[0] === "window-session-view:tab-create" &&
        (call[1] as { kind?: string } | undefined)?.kind === "terminal",
    );
    expect(createCall).toBeDefined();
    const createInput = createCall?.[1] as Record<string, unknown>;
    expect("projectId" in createInput).toBe(false);
    expect(Object.keys(createInput.config as Record<string, unknown>)).toEqual([
      "terminalSessionId",
    ]);
    expect(getLastTerminalPanelProps()).toMatchObject({
      cwd: "/Users/asc/repo/nodex",
      conversationId: "thread-projectless-tools",
      projectSessionId: "session:projectless:tools",
    });
  });

  test("blank projectless chats only expose Browser", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New projectless chat" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    const sideChatShortcut = new KeyboardEvent("keydown", {
      key: "s",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    const terminalShortcut = new KeyboardEvent("keydown", {
      key: "`",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      document.dispatchEvent(sideChatShortcut);
      document.dispatchEvent(terminalShortcut);
      await Promise.resolve();
    });
    expect(sideChatShortcut.defaultPrevented).toBe(false);
    expect(terminalShortcut.defaultPrevented).toBe(false);
    expect(startSideChatCalls).toHaveLength(0);
    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:tab-create" &&
          (call[1] as { kind?: string } | undefined)?.kind === "terminal",
      ),
    ).toBe(false);

    const browserShortcut = new KeyboardEvent("keydown", {
      key: "t",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      document.dispatchEvent(browserShortcut);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Browser" })).toBeDefined();
    });
    expect(browserShortcut.defaultPrevented).toBe(true);
    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:tab-create" &&
          (call[1] as { kind?: string } | undefined)?.kind === "browser",
      ),
    ).toBe(false);
  });

  test("bottom panel add menu shows Codex-eligible non-default actions", async () => {
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeAttachedSession()] },
    });
    await settleAsyncRender();
    await settleAsyncRender();
    await openBottomPanel(screen);

    const menu = await openPanelMenu(screen, "Open bottom panel tab");
    expect(within(menu).getByText("Files") !== null).toBe(true);
    expect(within(menu).getByText("Side chat") !== null).toBe(true);
    expect(within(menu).getByText("Browser") !== null).toBe(true);
    expect(within(menu).queryByText("Review")).toBe(null);
    expect(within(menu).getByText("Terminal") !== null).toBe(true);
    expect(within(menu).queryByText("DB View")).toBe(null);
    expect(within(menu).queryByText("Page")).toBe(null);
    expect(textContent(menu).includes("⌃`")).toBe(true);
  });

  test("right panel keeps Nodex-only actions after Codex actions", async () => {
    const emptySession = makeAttachedSession({
      id: "session:alpha:nodex-actions",
      tabs: [],
      rightLayout: makePanelLayout([], null),
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [emptySession] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const menu = await openPanelMenu(screen, "Open side panel tab");
    const menuText = textContent(menu);
    expect(menuText.indexOf("Review") < menuText.indexOf("Terminal")).toBe(true);
    expect(menuText.indexOf("Side chat") < menuText.indexOf("DB View")).toBe(true);
    expect(menuText.indexOf("DB View") < menuText.indexOf("Page")).toBe(true);
  });

  test("empty right panel DB View action creates the current project tab directly", async () => {
    const emptySession = makeSession({
      id: "session:alpha:db-direct",
      tabs: [],
      rightLayout: makePanelLayout([], null),
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [emptySession] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await pointerActivate(screen.getByRole("button", { name: /DB View/ }));
    await settleAsyncRender();

    expect(screen.queryByRole("dialog", { name: "Open DB view" })).toBe(null);
    const createCall = invokeCalls.find(
      (call) =>
        call[0] === "window-session-view:tab-create" &&
        JSON.stringify(call[1]).includes('"kind":"db_view"'),
    );
    expect(createCall).toBeDefined();
    expect(JSON.stringify(createCall?.[1]).includes('"targetLeafId"')).toBe(true);
    expect(JSON.stringify((createCall?.[1] as { config?: unknown } | undefined)?.config)).toBe(
      JSON.stringify({
        projectId: "alpha",
        databaseViewId: "database-view:alpha:primary-board",
      }),
    );
  });

  test("DB View action creates the project default View tab in an ordinary chat session", async () => {
    const chatSession = makeSession({
      id: "session:alpha:plain-chat",
      title: "Plain chat",
      tabs: [],
      rightLayout: makePanelLayout([], null),
    });
    // The action resolves the Project's default View instead of per-session state.
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [chatSession] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await pointerActivate(screen.getByRole("button", { name: /DB View/ }));
    await settleAsyncRender();

    const createCall = invokeCalls.find(
      (call) =>
        call[0] === "window-session-view:tab-create" &&
        JSON.stringify(call[1]).includes('"kind":"db_view"'),
    );
    expect(createCall).toBeDefined();
    expect(JSON.stringify((createCall?.[1] as { config?: unknown } | undefined)?.config)).toBe(
      JSON.stringify({
        projectId: "alpha",
        databaseViewId: "database-view:alpha:primary-board",
      }),
    );
  });

  test("View deep links create the requested saved View tab", async () => {
    const emptySession = makeSession({
      id: "session:alpha:view-deep-link",
      tabs: [],
      rightLayout: makePanelLayout([], null),
    });
    renderWorkbench({
      sessionsByProject: { alpha: [emptySession] },
      pendingViewDeepLinkOpen: {
        projectId: "alpha",
        viewId: "view:planning",
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const createCall = invokeCalls.find(
      (call) =>
        call[0] === "window-session-view:tab-create" &&
        (call[1] as { config?: { databaseViewId?: string } }).config?.databaseViewId ===
          "view:planning",
    );
    expect(createCall).toBeDefined();
  });

  test("repeated View deep links focus the existing saved View tab", async () => {
    const targetTab = makeSessionTab({
      id: "tab:view-planning",
      title: "Planning",
      kind: "db_view",
      config: {
        projectId: "alpha",
        databaseViewId: "view:planning",
      },
    });
    const otherTab = makeSessionTab({
      id: "tab:other-view",
      title: "Other",
      kind: "db_view",
      config: {
        projectId: "alpha",
        databaseViewId: "view:other",
      },
    });
    const session = makeSession({
      id: "session:alpha:existing-view-deep-link",
      tabs: [targetTab, otherTab],
      rightLayout: makePanelLayout([targetTab.id, otherTab.id], otherTab.id),
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
      pendingViewDeepLinkOpen: {
        projectId: "alpha",
        viewId: "view:planning",
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(screen.getByRole("tab", { name: "Planning", selected: true })).toBeDefined();
    expect(invokeCalls.some((call) => call[0] === "window-session-view:tab-create")).toBe(false);
  });

  test("DB View action reports a missing project default View instead of silently doing nothing", async () => {
    const chatSession = makeSession({
      id: "session:alpha:no-view-chat",
      title: "Plain chat",
      tabs: [],
      rightLayout: makePanelLayout([], null),
    });
    const projectWithoutView: Project = {
      ...makeProject(),
      defaultDatabaseViewId: null,
    };
    const screen = renderWorkbench({
      projects: [projectWithoutView],
      sessionsByProject: { alpha: [chatSession] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await pointerActivate(screen.getByRole("button", { name: /DB View/ }));
    await settleAsyncRender();

    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:tab-create" &&
          JSON.stringify(call[1]).includes('"kind":"db_view"'),
      ),
    ).toBe(false);
    expect(
      __getNodexToastSnapshotForTests().some(
        (toastItem) =>
          toastItem.kind === "plain" &&
          toastItem.title === "This project's Database has no default View to open.",
      ),
    ).toBe(true);
  });

  test("right panel DB View action opens the picker after the current project DB exists", async () => {
    const screen = renderWorkbench({
      projects: [makeProject(), makeProject("beta", "Beta")],
      sessionsByProject: { alpha: [makeSession()] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const menu = await openPanelMenu(screen, "Open side panel tab");
    const dbViewText = within(menu).getByText("DB View");
    const dbViewItem = dbViewText.closest('[role="menuitem"]');
    if (!(dbViewItem instanceof HTMLElement)) {
      throw new Error("Expected DB View menu item");
    }
    await act(async () => {
      fireEvent.pointerMove(dbViewItem, { pointerType: "mouse" });
      fireEvent.keyDown(dbViewItem, { key: "ArrowRight" });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Open DB view" }) !== null).toBe(true);
    });
    await waitFor(() => {
      expect(
        invokeCalls.some(
          (call) =>
            call[0] === "database-module:read" &&
            (call[2] as { read?: { mode?: string } } | undefined)?.read?.mode === "database",
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /Board.*Alpha/ }) !== null).toBe(true);
      expect(screen.getByRole("option", { name: /Board.*Beta/ }) !== null).toBe(true);
    });

    setInvokeCalls([]);
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /Board.*Alpha/ }));
      await Promise.resolve();
    });
    await settleAsyncRender();
    expect(invokeCalls.some((call) => call[0] === "window-session-view:tab-create")).toBe(false);

    const betaMenu = await openPanelMenu(screen, "Open side panel tab");
    const betaDbViewText = within(betaMenu).getByText("DB View");
    const betaDbViewItem = betaDbViewText.closest('[role="menuitem"]');
    if (!(betaDbViewItem instanceof HTMLElement)) {
      throw new Error("Expected DB View menu item");
    }
    await act(async () => {
      fireEvent.pointerMove(betaDbViewItem, { pointerType: "mouse" });
      fireEvent.keyDown(betaDbViewItem, { key: "ArrowRight" });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Open DB view" }) !== null).toBe(true);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /Board.*Beta/ }));
      await Promise.resolve();
    });
    await settleAsyncRender();
    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:tab-create" &&
          JSON.stringify(call[1]).includes('"kind":"db_view"') &&
          JSON.stringify(call[1]).includes('"projectId":"beta"'),
      ),
    ).toBe(true);
    expect(screen.getByRole("tab", { name: /Beta project, DB View/ }) !== null).toBe(true);
  });

  test("empty right panel Page action loads current-Project Pages and searches other Projects on demand", async () => {
    const emptySession = makeSession({
      id: "session:alpha:card-picker",
      tabs: [],
      rightLayout: makePanelLayout([], null),
    });
    const screen = renderWorkbench({
      projects: [makeProject(), makeProject("beta", "Beta")],
      sessionsByProject: { alpha: [emptySession] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const actionGrid = screen.container.querySelector(
      '[data-thread-side-panel-new-tab-action-grid="true"]',
    );
    if (!(actionGrid instanceof HTMLElement)) throw new Error("Expected right-panel action grid");
    await pointerActivate(within(actionGrid).getByRole("button", { name: "Page" }));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Open Page" }) !== null).toBe(true);
      expect(screen.getByText("Current project") !== null).toBe(true);
    });
    expect(screen.getByRole("combobox", { name: "Open Page" }) !== null).toBe(true);
    expect(screen.queryByText("Other projects")).toBe(null);
    expect(screen.queryByRole("option", { name: /Beta Card/ })).toBe(null);

    await waitFor(() => {
      expect(screen.getByRole("option", { name: /Card One/ }) !== null).toBe(true);
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Open Page" }), {
      target: { value: "Beta Card" },
    });
    await waitFor(() => {
      expect(screen.getByText("Other projects") !== null).toBe(true);
      expect(screen.getByRole("option", { name: /Beta Card/ }) !== null).toBe(true);
    });
    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "pages:search" &&
          (call[2] as { query?: string } | undefined)?.query === "beta card",
      ),
    ).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /Beta Card/ }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:tab-create" &&
          JSON.stringify(call[1]).includes('"kind":"page_stage"') &&
          JSON.stringify(call[1]).includes('"projectId":"beta"') &&
          JSON.stringify(call[1]).includes('"pageId":"card-beta"'),
      ),
    ).toBe(true);
  });

  test("Files action creates a durable empty tab whose navigation does not trigger preview pinning", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();
    await settleAsyncRender();
    await openBottomPanel(screen);

    const menu = await openPanelMenu(screen, "Open bottom panel tab");
    await clickMenuItem(menu, "Files");
    await waitFor(() => {
      expect(
        invokeCalls.some(
          (call) =>
            call[0] === "window-session-view:tab-create" &&
            JSON.stringify(call[1]).includes('"panelId":"bottom"') &&
            JSON.stringify(call[1]).includes('"kind":"files"'),
        ),
      ).toBe(true);
    });

    expect(screen.getByRole("tab", { name: "Files" }) !== null).toBe(true);
    expect(screen.container.querySelector('[data-app-shell-tabpanel-preview="true"]')).toBe(null);
    const tabCreateCount = invokeCalls.filter(
      (call) =>
        call[0] === "window-session-view:tab-create" &&
        JSON.stringify(call[1]).includes('"kind":"files"'),
    ).length;
    await pointerDownAndSettle(getFilesPreviewInteractionTarget(screen));
    expect(
      invokeCalls.filter(
        (call) =>
          call[0] === "window-session-view:tab-create" &&
          JSON.stringify(call[1]).includes('"kind":"files"'),
      ),
    ).toHaveLength(tabCreateCount);
  });

  for (const previewCase of [
    { label: "Browser", kind: "browser", pinPlaceholder: "Enter a URL" },
  ] as const) {
    test(`bottom ${previewCase.label} preview mounts and pins after interaction`, async () => {
      const screen = renderWorkbench();
      await settleAsyncRender();
      await settleAsyncRender();
      await openBottomPanel(screen);

      const menu = await openPanelMenu(screen, "Open bottom panel tab");
      await clickMenuItem(menu, previewCase.label);

      expect(screen.getByRole("tab", { name: previewCase.label }) !== null).toBe(true);
      expect(
        screen.container.querySelector('[data-app-shell-tabpanel-preview="true"]') !== null,
      ).toBe(true);
      expect(invokeCalls.some((call) => call[0] === "window-session-view:tab-create")).toBe(false);

      await pointerDownAndSettle(screen.getByPlaceholderText(previewCase.pinPlaceholder));
      await waitFor(() => {
        expect(
          invokeCalls.some(
            (call) =>
              call[0] === "window-session-view:tab-create" &&
              JSON.stringify(call[1]).includes('"panelId":"bottom"') &&
              JSON.stringify(call[1]).includes(`"kind":"${previewCase.kind}"`),
          ),
        ).toBe(true);
      });

      expect(
        invokeCalls.some(
          (call) =>
            call[0] === "window-session-view:tab-create" &&
            JSON.stringify(call[1]).includes('"panelId":"bottom"') &&
            JSON.stringify(call[1]).includes(`"kind":"${previewCase.kind}"`),
        ),
      ).toBe(true);
    });
  }

  test("bottom Side chat action starts an ephemeral side tab instead of a durable preview", async () => {
    localStorage.setItem(THREAD_QUEUE_FOLLOW_UPS_STORAGE_KEY, "false");
    localStorage.setItem(COMPOSER_ENTER_BEHAVIOR_STORAGE_KEY, "cmdIfMultiline");
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeAttachedSession()] },
    });
    await settleAsyncRender();
    await settleAsyncRender();
    await openBottomPanel(screen);
    await waitFor(() => {
      expect(
        invokeCalls.some(
          (call) =>
            call[0] === "window-session-view:tab-create" &&
            (call[1] as { kind?: string } | undefined)?.kind === "terminal",
        ),
      ).toBe(true);
    });
    const durableTabCreateCount = invokeCalls.filter(
      (call) => call[0] === "window-session-view:tab-create",
    ).length;

    const menu = await openPanelMenu(screen, "Open bottom panel tab");
    await act(async () => {
      fireEvent.click(within(menu).getByText("Side chat"));
      await Promise.resolve();
    });
    await settleAsyncRender();

    await waitFor(() => {
      expect(screen.queryAllByRole("tab", { name: "Side chat" }).length).toBe(1);
    });
    expect(screen.getByRole("tab", { name: "Side chat" }) !== null).toBe(true);
    expect(screen.container.querySelector('[data-app-shell-tabpanel-preview="true"]')).toBe(null);
    expect(String(startSideChatCalls.length)).toBe("1");
    expect(JSON.stringify(startSideChatCalls[0]).includes('"parentThreadId":"thread-alpha"')).toBe(
      true,
    );
    expect(invokeCalls.filter((call) => call[0] === "window-session-view:tab-create")).toHaveLength(
      durableTabCreateCount,
    );
    expect(textContent(screen.container).includes("Thread:side-thread-1")).toBe(true);
    const stageProps = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(JSON.stringify(stageProps?.sideChatContext ?? null)).toBe(
      '{"parentThreadId":"thread-alpha","tabTitle":"Side chat"}',
    );
    expect(typeof stageProps?.composerScopeIdentity).toBe("string");
    expect(String(stageProps?.composerScopeIdentity).startsWith("side-chat:")).toBe(true);
    expect(stageProps?.isQueueingEnabled).toBe(false);
    expect(stageProps?.composerEnterBehavior).toBe("cmdIfMultiline");
    expect(Boolean(stageProps?.summaryPanelMounted)).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close Side chat tab" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(String(discardSideChatCalls.length)).toBe("1");
    expect(discardSideChatCalls[0] ?? "").toBe("side-thread-1");
  });

  test("ready Side chat keeps its explicit projectless conversation context after parent rehome", async () => {
    setSideChatConversationProjectId(null);
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeAttachedSession()] },
    });
    await settleAsyncRender();
    await openBottomPanel(screen);

    const menu = await openPanelMenu(screen, "Open bottom panel tab");
    await clickMenuItem(menu, "Side chat");

    await waitFor(() => {
      expect(getConnectedThreadStagePropsByThreadId("side-thread-1")?.projectId).toBe(null);
    });
    expect(getConnectedThreadStagePropsByThreadId("side-thread-1")?.projectWorkspacePath).toBe(
      null,
    );
  });

  test("selected-text side chat drafts prefill the side composer without submitting a prompt", async () => {
    renderWorkbench({
      sessionsByProject: { alpha: [makeAttachedSession()] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const actions = getLastThreadStageActions();
    const openSideChat = actions.onOpenSideChat as
      | ((input?: { kind: "draft"; draftPrompt: string }) => Promise<void>)
      | undefined;
    expect(typeof openSideChat).toBe("function");

    await act(async () => {
      await openSideChat?.({
        kind: "draft",
        draftPrompt: "Use this selected paragraph",
      });
      await Promise.resolve();
    });
    await settleAsyncRender();

    const startInput = startSideChatCalls[0] as
      | { prompt?: unknown; promptInput?: unknown }
      | undefined;
    expect(String(startSideChatCalls.length)).toBe("1");
    expect(Boolean(startInput && "prompt" in startInput)).toBe(false);
    expect(Boolean(startInput && "promptInput" in startInput)).toBe(false);
    expect(String(setComposerIntentCalls.length)).toBe("1");
    expect(setComposerIntentCalls[0]?.[0]).toBe("side-thread-1");
    expect((setComposerIntentCalls[0]?.[1] as { prompt?: string } | undefined)?.prompt).toBe(
      "Use this selected paragraph",
    );
    expect(
      typeof (setComposerIntentCalls[0]?.[1] as { focusNonce?: number } | undefined)?.focusNonce,
    ).toBe("number");
  });

  test("routes inline subagent contexts inside one Subagents right-panel tab", async () => {
    sideChatConversations["thread-child"] = {
      threadId: "thread-child",
      projectId: "alpha",
      source: {
        parentThreadId: "thread-alpha",
        agentNickname: "Scout",
      },
      threadName: "Scout",
      threadPreview: "Checking the repo",
      modelProvider: "openai",
      cwd: "/Users/asc/repo/nodex",
      statusType: "idle",
      statusActiveFlags: [],
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      linkedAt: "",
      resumeState: "resumed",
      turns: [],
      requests: [],
      pendingSteers: [],
      queuedFollowUps: {
        status: "ready",
        ledgerRevision: 0,
        projectionRevision: 0,
        entries: [],
        inFlightFollowUpId: null,
        editingFollowUpId: null,
        error: null,
      },
      backgroundTerminalRows: [],
      capabilityFlags: {
        canEditLastUserTurn: false,
        canForkFromTurn: false,
        canSearch: true,
        canCollapseTurns: true,
      },
      ephemeral: true,
    };
    sideChatConversations["thread-legacy"] = {
      ...sideChatConversations["thread-child"],
      threadId: "thread-legacy",
      threadName: "Legacy worker",
      source: { parentThreadId: "thread-alpha" },
    };
    sideChatConversations["thread-child-2"] = {
      ...sideChatConversations["thread-child"],
      threadId: "thread-child-2",
      threadName: "Reviewer",
      source: { parentThreadId: "thread-alpha" },
    };

    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeAttachedSession({ rightCollapsed: true })] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const actions = getLastThreadStageActions();
    const openThread = actions.onOpenThread as
      | ((
          threadId: string,
          context?: {
            subagent?: {
              conversationId: string;
              displayName: string;
              agentRole: string | null;
              spawnModel: string | null;
              status: "active" | "waiting" | "done";
              statusSummary: string | null;
              showInlineActivity?: boolean;
              diffStats: { linesAdded: number; linesRemoved: number } | null;
            };
          },
        ) => Promise<void>)
      | undefined;
    expect(typeof openThread).toBe("function");
    if (!openThread) return;

    let resolveSnapshot: () => void = () => undefined;
    setRequestThreadStreamSnapshotImpl(async () => {
      await new Promise<void>((resolve) => {
        resolveSnapshot = resolve;
      });
    });

    setInvokeCalls([]);
    try {
      await act(async () => {
        const openPromise = openThread("thread-child", {
          subagent: {
            conversationId: "thread-child",
            displayName: "Scout",
            agentRole: "explorer",
            spawnModel: "gpt-5.5",
            status: "active",
            statusSummary: "checking files",
            showInlineActivity: true,
            diffStats: { linesAdded: 2, linesRemoved: 1 },
          },
        });
        const openResult = await Promise.race([
          openPromise.then(() => "resolved"),
          new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0)),
        ]);
        expect(openResult).toBe("resolved");
        await Promise.resolve();
      });
      await settleAsyncRender();
      await settleAsyncRender();
    } finally {
      resolveSnapshot();
      setRequestThreadStreamSnapshotImpl(null);
    }

    const tab = getPanelTabById(screen.container, "subagents:thread-alpha");
    expect(tab.textContent?.includes("Subagents")).toBe(true);
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(tab.querySelector('[data-subagent-glyph-icon="true"]') !== null).toBe(true);
    expect(
      screen.container.querySelector('[data-subagents-side-panel-tab="subagents:thread-alpha"]') !==
        null,
    ).toBe(true);
    expect(textContent(screen.container).includes("Thread:thread-child")).toBe(true);
    const detailStageProps = (
      globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> }
    ).__lastConnectedThreadStageProps;
    expect(detailStageProps?.backgroundAgentDetail).toBe(true);
    const globalHeaderTitles = within(screen.getByTestId("workbench-global-header")).getAllByTestId(
      "thread-stage-title",
    );
    expect(globalHeaderTitles).toHaveLength(1);
    expect(globalHeaderTitles[0]?.textContent).toBe("Alpha thread");
    expect(invokeCalls.some((call) => call[0] === "codex:thread:ensure-session")).toBe(false);
    expect(hydrateBackgroundSubagentThreadsCalls).toEqual([]);
    expect(
      requestThreadStreamSnapshotCalls.filter((threadId) => threadId === "thread-child").length >=
        1,
    ).toBe(true);

    await act(async () => {
      await openThread("thread-child-2", {
        subagent: {
          conversationId: "thread-child-2",
          displayName: "Reviewer",
          agentRole: "reviewer",
          spawnModel: null,
          status: "done",
          statusSummary: null,
          showInlineActivity: true,
          diffStats: null,
        },
      });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(
      screen
        .getAllByRole("tab")
        .filter((candidate) => candidate.textContent?.includes("Subagents")),
    ).toHaveLength(1);
    expect(textContent(screen.container).includes("Thread:thread-child-2")).toBe(true);
    expect(hydrateSubagentPanelCalls).toEqual([
      { rootThreadId: "thread-alpha", threadIds: ["thread-child"], includeTail: true },
      { rootThreadId: "thread-alpha", threadIds: ["thread-child-2"], includeTail: true },
    ]);

    await act(async () => {
      await openThread("thread-legacy", {
        subagent: {
          conversationId: "thread-legacy",
          displayName: "Legacy worker",
          agentRole: null,
          spawnModel: null,
          status: "done",
          statusSummary: null,
          showInlineActivity: false,
          diffStats: null,
        },
      });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(getPanelTabById(screen.container, "background-agent:thread-legacy")).toBeTruthy();
    expect(hydrateBackgroundSubagentThreadsCalls).toEqual([
      { rootThreadId: "thread-alpha", threadIds: ["thread-legacy"] },
    ]);
  });
});
