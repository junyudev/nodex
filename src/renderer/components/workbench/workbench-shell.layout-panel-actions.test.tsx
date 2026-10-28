import "./workbench-testkit/workbench-shell-harness";
import { describe, test, expect } from "vite-plus/test";
import type { MotionValue } from "motion/react";
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
  WORKBENCH_NAVIGATION_RAIL_WIDTH_PX,
  WORKBENCH_SURFACE_GUTTER_PX,
} from "@/lib/workbench-shell-geometry";
import { parseDatabaseId, parseDatabaseViewId } from "../../../shared/database-identities";
import type { LibraryDatabaseNavigationNode } from "../../../shared/library-module";
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
  clickMenuItem,
  discardSideChatCalls,
  executeCommandPaletteCommand,
  getBottomPanelContentSizer,
  getConnectedThreadStagePropsByThreadId,
  findFilesPreviewInteractionTarget,
  getHeaderShellSlot,
  getLastTerminalPanelProps,
  getLastThreadStageActions,
  getPanelTabById,
  getThreadRow,
  getWorkbenchTabProjectionDeleteTabIds,
  hydrateSelectedSubagentCalls,
  installReducedMotionMatchMediaForTest,
  installTerminalEventApiMock,
  invokeCalls,
  agentRuntimeLaunchCalls,
  rendererCommandPayload,
  mockInvokeImpl,
  setMockInvokeImpl,
  moveSidebarPointer,
  hoverSidebarDestination,
  openBottomPanel,
  openPanelMenu,
  pointerActivate,
  pointerDownAndSettle,
  releasePointerDrag,
  renderWorkbench,
  requestPageCreateFromContextMock,
  setWindowInnerWidthForTest,
  sideChatConversations,
  startSideChatCalls,
  setInvokeCalls,
  waitForLastThreadStageActions,
  waitForThreadRow,
} from "./workbench-testkit/workbench-shell-harness";
import type { FloatingComposerPlacement } from "@/features/floating-composer/floating-composer";

// Layout fixtures control the body budget independently of fixed window chrome.
const setShellBodyWidthForTest = (width: number) =>
  setWindowInnerWidthForTest(
    width + WORKBENCH_NAVIGATION_RAIL_WIDTH_PX + WORKBENCH_SURFACE_GUTTER_PX,
  );

async function expectSummaryContentShift(props: Record<string, unknown> | undefined, x: number) {
  const contentShift = props?.summaryPanelContentShift as MotionValue<number> | undefined;
  await waitFor(() => expect(contentShift?.get()).toBeCloseTo(x, 2));
}

describe("workbench session shell / layout-panel-actions", () => {
  test("full view switches between its leading Chat tab and retained content", async () => {
    const session = makeAttachedSession({ title: "Workspace research", rightFullWidth: true });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
      initialSelectedSessionId: session.id,
    });
    const chat = await screen.findByRole("tab", { name: "Workspace research" });
    const rightPanel = screen.getByTestId("session-right-panel");
    expect(within(rightPanel).getAllByRole("tab")[0]).toBe(chat);
    expect(chat.getAttribute("aria-selected")).toBe("false");
    expect(within(rightPanel).getByRole("tab", { name: "DB View", selected: true })).toBeTruthy();
    expect(within(rightPanel).getByRole("tabpanel", { name: "DB View" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Move to .* pane$/ })).toBeNull();

    await pointerActivate(chat);

    await waitFor(() => {
      expect(invokeCalls).toContainEqual([
        "window-session-view:panel-patch",
        session.id,
        "right",
        expect.objectContaining({ collapsed: true }),
      ]);
      expect(screen.getByRole("tab", { name: "Workspace research", selected: true })).toBeTruthy();
      expect(
        screen.getByTestId("session-thread-page").getAttribute("data-workbench-primary-hidden"),
      ).toBe("false");
    });
    expect(rightPanel.getAttribute("data-right-panel-concealed")).toBe("true");
    expect(rightPanel.getAttribute("data-right-panel-width-mode")).toBe("full");
    expect(within(rightPanel).queryByRole("tabpanel")).toBeNull();
    const content = within(rightPanel).getByRole("tab", { name: "DB View", selected: false });

    await pointerActivate(content);

    await waitFor(() => {
      expect(invokeCalls).toContainEqual([
        "window-session-view:panel-patch",
        session.id,
        "right",
        expect.objectContaining({ collapsed: false }),
      ]);
      expect(within(rightPanel).getByRole("tab", { name: "DB View", selected: true })).toBeTruthy();
      expect(within(rightPanel).getByRole("tabpanel", { name: "DB View" })).toBeTruthy();
    });
    expect(screen.getByRole("tab", { name: "Workspace research", selected: false })).toBeTruthy();
    expect(rightPanel.getAttribute("data-right-panel-concealed")).toBeNull();
    expect(rightPanel.getAttribute("data-right-panel-width-mode")).toBe("full");
    expect(
      screen.getByTestId("session-thread-page").getAttribute("data-workbench-primary-hidden"),
    ).toBe("true");
  });

  test("a full-view content tab's menu presents it in a pane beside the Chat", async () => {
    const session = makeAttachedSession({ title: "Present content", rightFullWidth: true });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
      initialSelectedSessionId: session.id,
    });
    const content = await screen.findByRole("tab", { name: "DB View", selected: true });
    await act(async () => {
      fireEvent.contextMenu(content);
      await Promise.resolve();
    });
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent)
        .filter((label) => label?.startsWith("Move to")),
    ).toEqual(["Move to left pane", "Move to right pane", "Move to bottom panel"]);
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Move to left pane" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(invokeCalls).toContainEqual([
        "window-session-view:panel-patch",
        session.id,
        "right",
        expect.objectContaining({
          side: "left",
          size: expect.objectContaining({ fullWidth: false }),
        }),
      ]);
      expect(screen.getByTestId("session-right-panel").getAttribute("data-right-panel-side")).toBe(
        "left",
      );
    });
    expect(screen.getByRole("tab", { name: "DB View", selected: true })).toBeTruthy();
  });

  test("the full-view Chat context menu moves the Conversation into the right pane", async () => {
    const session = makeAttachedSession({
      title: "Move this Chat",
      rightFullWidth: true,
      rightCollapsed: true,
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
      initialSelectedSessionId: session.id,
    });
    const chat = await screen.findByRole("tab", { name: "Move this Chat", selected: true });
    expect(screen.queryByRole("button", { name: /^Move to .* pane$/ })).toBeNull();
    await act(async () => {
      fireEvent.contextMenu(chat);
      await Promise.resolve();
    });
    const move = await screen.findByRole("menuitem", { name: "Move to right pane" });
    await act(async () => {
      fireEvent.click(move);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(invokeCalls).toContainEqual([
        "window-session-view:panel-patch",
        session.id,
        "right",
        expect.objectContaining({
          side: "left",
          collapsed: false,
          size: expect.objectContaining({ fullWidth: false }),
        }),
      ]);
      expect(screen.getByTestId("session-right-panel").getAttribute("data-right-panel-side")).toBe(
        "left",
      );
    });
    expect(
      screen.getByTestId("session-right-panel").getAttribute("data-right-panel-width-mode"),
    ).toBe("regular");
    expect(
      screen.getByTestId("session-right-panel").getAttribute("data-right-panel-concealed"),
    ).toBeNull();
    expect(
      screen.getByTestId("session-thread-page").getAttribute("data-workbench-primary-hidden"),
    ).toBe("false");
    expect(screen.queryByRole("tab", { name: "Move this Chat" })).toBeNull();
    expect(await screen.findByRole("button", { name: "Move to left pane" })).toBeTruthy();
  });

  test("a saved left content pane carries its full-view toggle and can swap sides from Chat actions", async () => {
    const session = makeAttachedSession({ rightFullWidth: false, rightCollapsed: false });
    session.panels.right.side = "left";
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
      initialSelectedSessionId: session.id,
    });
    const fullViewToggle = await screen.findByRole("button", { name: "Enter full view" });
    const rightPanel = screen.getByTestId("session-right-panel");
    expect(rightPanel.getAttribute("data-right-panel-side")).toBe("left");
    expect(rightPanel.contains(fullViewToggle)).toBe(true);
    expect(getHeaderShellSlot(screen, "right").contains(fullViewToggle)).toBe(false);
    const content = within(rightPanel).getByRole("tab", { name: "DB View" });
    expect(
      content.compareDocumentPosition(fullViewToggle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Move to right pane" })).toBeNull();

    await pointerActivate(await screen.findByRole("button", { name: "Move to left pane" }));

    await waitFor(() => {
      expect(invokeCalls).toContainEqual([
        "window-session-view:panel-patch",
        session.id,
        "right",
        expect.objectContaining({ side: "right" }),
      ]);
      expect(rightPanel.getAttribute("data-right-panel-side")).toBe("right");
    });
    expect(rightPanel.getAttribute("data-right-panel-width-mode")).toBe("regular");
    expect(
      screen.getByTestId("session-thread-page").getAttribute("data-workbench-primary-hidden"),
    ).toBe("false");
    expect(await screen.findByRole("button", { name: "Move to right pane" })).toBeTruthy();
    expect(
      getHeaderShellSlot(screen, "right").contains(
        screen.getByRole("button", { name: "Enter full view" }),
      ),
    ).toBe(true);
  });

  test("settles a failed side chat open into a closable retry surface", async () => {
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

    const base = mockInvokeImpl;
    if (!base) throw new Error("Expected Core Session transport");
    let failure = true;
    setMockInvokeImpl(async (channel, ...args) => {
      if (channel === "agent-runtime:session:create-side-chat" && failure)
        throw new Error("Session creation timed out");
      return base(channel, ...args);
    });
    const menu = await openPanelMenu(screen, "right");
    await clickMenuItem(menu, "Side chat");

    expect(textContent(await screen.findByRole("alert"))).toContain(
      "Side chat could not be opened",
    );
    expect(screen.getByText("Session creation timed out")).toBeTruthy();
    failure = false;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        invokeCalls.filter(([channel]) => channel === "agent-runtime:session:create-side-chat"),
      ).toHaveLength(2),
    );
    const attempts = invokeCalls.filter(
      ([channel]) => channel === "agent-runtime:session:create-side-chat",
    );
    expect(attempts[1]?.[1]).toEqual(attempts[0]?.[1]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Close Side chat tab" })).toBeTruthy();
  });

  test("discards side context that finishes materializing after its loading tab closes", async () => {
    const source = makeAttachedSession({ id: "source:late-side", tabs: [] });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [source] },
      initialSelectedSessionId: source.id,
    });
    const actions = await waitForLastThreadStageActions();
    const base = mockInvokeImpl;
    if (!base) throw new Error("Expected Session transport");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    setMockInvokeImpl(async (channel, ...args) => {
      if (channel === "agent-runtime:session:create-side-chat") await pending;
      return base(channel, ...args);
    });
    let opening!: Promise<void>;
    await act(async () => {
      opening =
        (actions.onOpenSideChat as import("@/features/local-conversation/thread-stage-types").ThreadStageActions["onOpenSideChat"])!(
          { kind: "draft", draftPrompt: "Keep this local" },
        );
      await Promise.resolve();
    });
    const close = await screen.findByRole("button", { name: "Close Side chat tab" });
    await act(async () => {
      fireEvent.click(close);
      await Promise.resolve();
    });
    await act(async () => {
      release();
      await opening;
    });
    await waitFor(() =>
      expect(
        invokeCalls.filter(([channel]) => channel === "agent-runtime:session:discard-side-chat"),
      ).toHaveLength(1),
    );
    expect(screen.queryByRole("tab", { name: "Side chat" })).toBeNull();
    expect(
      invokeCalls.filter(([channel]) => channel === "agent-runtime:session:message"),
    ).toHaveLength(0);
  });

  test("collapsed right panel opens from the global side-panel toggle", async () => {
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeSession({ rightCollapsed: true })] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(screen.queryAllByRole("tablist").length).toBe(0);
    const globalHeader = screen.container.querySelector('[data-testid="workbench-global-header"]');
    const toggleButton = screen.getByRole("button", { name: "Show tabs" });
    expect(globalHeader?.contains(toggleButton)).toBe(true);
    expect(toggleButton.getAttribute("aria-pressed")).toBe("false");
    expect(toggleButton.className.includes("no-drag")).toBe(true);
    expect(toggleButton.getAttribute("aria-description")).toBe("1 open tab");
    expect(screen.queryByRole("button", { name: "Attach thread" })).toBe(null);
    expect(screen.queryByRole("button", { name: "Detach thread" })).toBe(null);

    await act(async () => {
      fireEvent.click(toggleButton);
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(invokeCalls).toContainEqual([
      "window-session-view:panel-patch",
      "session:alpha:database-view",
      "right",
      expect.objectContaining({ collapsed: false }),
    ]);
    expect(screen.getByRole("button", { name: "Hide tabs" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
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
    const sidePanelToggle = screen.getByRole("button", { name: "Show tabs" });
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
    setShellBodyWidthForTest(1400);
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
    await expectSummaryContentShift(stageProps, -154);

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
    await expectSummaryContentShift(stageProps, 0);
    expect(localStorage.getItem("nodex:thread-summary-panel:pinned-open")).toBe("false");
  });

  test("large thread widths use edge-scroll header and gutter summary mode", async () => {
    setShellBodyWidthForTest(1902);
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
    await expectSummaryContentShift(stageProps, 0);
  });

  test("medium thread widths keep guarded header chrome and shift pinned summary", async () => {
    setShellBodyWidthForTest(1801);
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
    await expectSummaryContentShift(stageProps, -154);
  });

  test("narrow effective thread widths switch summary to overlay popover", async () => {
    setShellBodyWidthForTest(1350);
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
    await expectSummaryContentShift(stageProps, 0);
  });

  test("resize-driven overlay mode keeps the summary mounted so it can animate out", async () => {
    setShellBodyWidthForTest(1801);
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
    await expectSummaryContentShift(stageProps, -154);

    setShellBodyWidthForTest(1350);
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
    await expectSummaryContentShift(stageProps, 0);
    expect(localStorage.getItem("nodex:thread-summary-panel:pinned-open")).toBe("true");
  });

  test("responsive shell guards close competing right panel and sidebar at Codex thresholds", async () => {
    setShellBodyWidthForTest(1000);
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

    setShellBodyWidthForTest(959);
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

    setShellBodyWidthForTest(719);
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await Promise.resolve();
    });
    await settleAsyncRender();

    await waitFor(() => {
      expect(screen.queryByTestId("project-session-sidebar") === null).toBe(true);
    });
  });

  test.each(["project", "space"] as const)(
    "%s keeps its root content when crossing medium and narrow shell widths",
    async (destination) => {
      const database: LibraryDatabaseNavigationNode = {
        kind: "database",
        databaseId: parseDatabaseId("database:test:responsive"),
        title: "Tasks",
        defaultViewId: parseDatabaseViewId("database-view:test:responsive"),
        hasMultipleViews: false,
        isPrimary: false,
        metadataRevision: 1,
        locationRevision: 1,
        updatedAt: "2026-10-15T00:00:00.000Z",
      };
      setShellBodyWidthForTest(1000);
      const screen = renderWorkbench({
        libraryRoots: [database],
        sidebar: { collapsed: false, width: 300 },
      });
      await settleAsyncRender();
      await settleAsyncRender();

      if (destination === "project") {
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: "Open Alpha" }));
          await Promise.resolve();
        });
      } else {
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: "Space" }));
          await Promise.resolve();
        });
        const content = await screen.findByRole("list", { name: "Content" });
        const row = within(content).getByText("Tasks").closest('[role="listitem"]');
        if (!(row instanceof HTMLElement)) throw new Error("Expected the Tasks content row");
        await act(async () => {
          fireEvent.click(row);
          await Promise.resolve();
        });
      }
      await settleAsyncRender();
      await settleAsyncRender();

      const assertRootContent = () => {
        const panel = screen.getByTestId(
          destination === "project" ? "project-right-panel" : "library-right-panel",
        );
        expect(panel.getAttribute("data-right-panel-width-mode")).toBe("full");
        if (destination === "project") {
          // A Project's root is its own Inbox.
          expect(within(panel).getByTestId("inbox-route").getAttribute("data-inbox-scope")).toBe(
            "project",
          );
        } else {
          expect(within(panel).getByRole("tab", { name: "Tasks", selected: true })).toBeTruthy();
          expect(within(panel).getByTestId("workbench-database-view-surface")).toBeTruthy();
        }
        expect(__getNodexToastSnapshotForTests().filter((item) => item.level === "danger")).toEqual(
          [],
        );
        expect(
          invokeCalls.filter((call) => {
            const patch = call[3] as { collapsed?: boolean } | undefined;
            return (
              call[0] === "window-session-view:panel-patch" &&
              call[2] === "right" &&
              patch?.collapsed === true
            );
          }),
        ).toEqual([]);
      };
      assertRootContent();
      setInvokeCalls([]);

      for (const [width, shellClass] of [
        [959, "medium"],
        [719, "narrow"],
      ] as const) {
        setShellBodyWidthForTest(width);
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
          ).toBe(shellClass);
          assertRootContent();
        });
      }
      expect(
        screen.queryByRole("navigation", { name: destination === "project" ? "Home" : "Space" }),
      ).toBeNull();
      expect(screen.getByRole("button", { name: "Show sidebar" })).toBeTruthy();
    },
  );

  test("full view keeps the summary beside the workspace controls, as a popover over content", async () => {
    setShellBodyWidthForTest(1400);
    const session = makeAttachedSession({
      id: "session:alpha:full-summary",
      title: "Full summary",
      rightFullWidth: true,
    });
    const screen = renderWorkbench({ sessionsByProject: { alpha: [session] } });
    await settleAsyncRender();
    await settleAsyncRender();

    // Content fills the view: the Chat pane is hidden, so the summary opens over the content.
    const rightSlot = getHeaderShellSlot(screen, "right");
    const contentSummary = within(rightSlot).getByRole("button", { name: "Toggle summary" });
    expect(
      contentSummary.compareDocumentPosition(
        within(rightSlot).getByRole("button", { name: "Exit full view" }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
        .__lastConnectedThreadStageProps?.summaryPanelMounted,
    ).toBe(false);

    await pointerActivate(await screen.findByRole("tab", { name: "Full summary" }));
    await settleAsyncRender();

    // The Chat fills the view: its pinned summary returns, and the control stays put.
    await waitFor(() =>
      expect(
        within(getHeaderShellSlot(screen, "right")).getByRole("button", {
          name: "Toggle pinned summary",
        }),
      ).toBeTruthy(),
    );
    expect(
      (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
        .__lastConnectedThreadStageProps?.summaryPanelMounted,
    ).toBe(true);
    expect(screen.getAllByRole("button", { name: /^Toggle (pinned )?summary$/ })).toHaveLength(1);
  });

  test("thread summary toggle stays visible while the right panel is open and keeps the pinned overlay hidden", async () => {
    setShellBodyWidthForTest(1400);
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
    await expectSummaryContentShift(stageProps, 0);
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
    await expectSummaryContentShift(stageProps, 0);
    expect(localStorage.getItem("nodex:thread-summary-panel:pinned-open")).toBe("true");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Hide tabs" }));
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
    await expectSummaryContentShift(stageProps, -154);
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
    const restoreButton = screen.getByRole("button", { name: "Exit full view" });
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
      const tabHeader =
        rightPanel.querySelector('[role="tablist"]')?.parentElement?.parentElement?.parentElement;
      if (!tabHeader) throw new Error("Expected right-panel tab header");
      const leadingSpacer = tabHeader.firstElementChild?.firstElementChild;
      const tabRow = tabHeader.children.item(1);
      const trailingSpacer = screen.container.querySelector(
        '[data-testid="right-panel-tab-bar-header-spacer"]',
      );
      const restoreButton = screen.getByRole("button", { name: "Exit full view" });

      expect(leftSlot.getAttribute("style")?.includes("width: 0px")).toBe(true);
      expect(leftSlot.getAttribute("style")?.includes("min-width: 224px")).toBe(true);
      expect(tabHeader.className.includes("draggable")).toBe(false);
      expect(within(leftSlot).getByRole("button", { name: "New chat" }) !== null).toBe(true);
      expect(rightSlot.getAttribute("style")?.includes("width: 0px")).toBe(true);
      expect(rightSlot.getAttribute("style")?.includes("min-width: 70px")).toBe(true);
      expect(
        Number.parseFloat((leadingSpacer as HTMLElement | null)?.style.width ?? "0") +
          WORKBENCH_NAVIGATION_RAIL_WIDTH_PX,
      ).toBe(Number.parseFloat(leftSlot.style.minWidth));
      expect(leadingSpacer?.className.includes("pointer-events-none")).toBe(true);
      expect(tabRow?.querySelector('[role="tablist"]') !== null).toBe(true);
      expect(tabHeader.contains(restoreButton)).toBe(false);
      expect(rightSlot.contains(restoreButton)).toBe(true);
      expect(trailingSpacer?.getAttribute("style")?.includes("width: calc(70px)")).toBe(true);
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

      await moveSidebarPointer(WORKBENCH_NAVIGATION_RAIL_WIDTH_PX + 12);
      await hoverSidebarDestination(screen, "Home");
      const floatingShell = screen.container.querySelector(
        '[data-testid="floating-project-session-sidebar-shell"]',
      ) as HTMLElement | null;
      expect(floatingShell !== null).toBe(true);
      expect(floatingShell?.className.includes(APP_SHELL_FLOATING_LEFT_PANEL_LAYER_CLASS)).toBe(
        true,
      );

      await hoverSidebarDestination(screen, "Home", false);
      await moveSidebarPointer(WORKBENCH_NAVIGATION_RAIL_WIDTH_PX + 301);
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
        screen.getByRole("button", { name: "Enter full view" }).getAttribute("aria-pressed"),
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
    expect(props?.rightPanelComposerOverlayTarget).toBe(host);
    const placement = props?.rightPanelComposerOverlayPlacement as
      | FloatingComposerPlacement
      | undefined;
    expect(placement?.reserveContent).toBe(true);
    expect(placement?.control?.state).toMatchObject({ visible: true });
    expect(placement?.menuItems?.map((item) => item.label)).toEqual([
      "Open in full view",
      "Move to left pane",
      "Move to right pane",
    ]);

    // Minimizing and docking persist in the Session's Scene.
    await act(async () => {
      placement?.control?.onStateChange({ visible: false, minimizedDock: "top-left" });
      await Promise.resolve();
    });
    await settleAsyncRender();
    await act(async () => {
      placement?.control?.onStateChange({ dock: "bottom-right" });
      await Promise.resolve();
    });
    await settleAsyncRender();

    const nextPlacement = (
      globalThis as {
        __lastConnectedThreadStageProps?: Record<string, unknown>;
      }
    ).__lastConnectedThreadStageProps?.rightPanelComposerOverlayPlacement as
      | FloatingComposerPlacement
      | undefined;
    expect(nextPlacement?.control?.state).toEqual({
      visible: false,
      minimizedDock: "top-left",
      dock: "bottom-right",
    });
  });

  test("a Runtime-owned chat floats its composer over full-width content", async () => {
    const runtimeSession = makeAttachedSession({
      rightFullWidth: true,
      thread: null,
      executionRef: { runtimeId: "runtime:test", threadId: "runtime-thread-alpha" },
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [runtimeSession] },
    });
    await settleAsyncRender();
    await settleAsyncRender();
    await settleAsyncRender();

    const host = screen
      .getByTestId("session-right-panel")
      .querySelector('[data-right-panel-composer-overlay-host="true"]');
    const props = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(host !== null).toBe(true);
    expect(props?.rightPanelComposerOverlayEnabled).toBe(true);
    expect(props?.rightPanelComposerOverlayTarget).toBe(host);
  });

  test("a full-width Browser tab floats the same composer without reserving page space", async () => {
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
    const placement = props?.rightPanelComposerOverlayPlacement as
      | FloatingComposerPlacement
      | undefined;
    expect(placement?.reserveContent).toBe(false);
    expect(placement?.control?.state).toMatchObject({ visible: true });
  });

  test("full-width overlay state keeps the bottom-panel toggle clickable after pointerdown", async () => {
    const session = makeAttachedSession({
      id: "session:alpha:overlay-bottom-toggle",
      tabs: [
        {
          id: "db-tab",
          kind: "db_view",
          title: "DB View",
          config: { routingContext: { kind: "project", projectId: "alpha" } },
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

  test("full-width overlay keeps the global split control clickable after pointerdown", async () => {
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

    await pointerActivate(screen.getByRole("button", { name: "Enter split view" }));
    await settleAsyncRender();

    await waitFor(() => {
      expect(
        screen.getByTestId("session-right-panel").getAttribute("data-right-panel-width-mode"),
      ).toBe("regular");
    });
    expect(screen.getByRole("button", { name: "Hide tabs" })).toBeTruthy();
    const splitProps = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(splitProps?.rightPanelComposerOverlayEnabled).toBe(false);
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

    await pointerActivate(screen.getByRole("button", { name: "Exit full view" }));

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
          config: {
            routingContext: { kind: "project", projectId: "alpha" },
            pageId: "card-1",
            titleSnapshot: "Card One",
          },
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
          config: {
            routingContext: { kind: "project", projectId: "alpha" },
            pageId: "card-1",
            titleSnapshot: "Card One",
          },
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
          config: { routingContext: { kind: "project", projectId: "alpha" } },
        },
        {
          id: "page-stage-tab",
          kind: "page_stage",
          title: "Card One",
          config: {
            routingContext: { kind: "project", projectId: "alpha" },
            pageId: "card-1",
            titleSnapshot: "Card One",
          },
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
    setShellBodyWidthForTest(1024);
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
    const tabHeader =
      rightPanel?.querySelector('[role="tablist"]')?.parentElement?.parentElement?.parentElement;
    const headerShellSlot = getHeaderShellSlot(screen, "right");
    if (!tabHeader) throw new Error("Expected right-panel tab header");

    const sidePanelToggle = screen.getByRole("button", { name: "Hide tabs" });
    const expandButton = screen.getByRole("button", { name: "Enter full view" });
    const rightPanelHeaderSpacer = screen.container.querySelector(
      '[data-testid="right-panel-tab-bar-header-spacer"]',
    );
    const visibleGlobalHeaderButtons = Array.from(
      headerShellSlot?.querySelectorAll("button") ?? [],
    );
    expect(globalHeader?.contains(sidePanelToggle)).toBe(true);
    expect(headerShellSlot?.contains(sidePanelToggle)).toBe(true);
    expect(
      visibleGlobalHeaderButtons.map((button) => button.getAttribute("aria-label")).join(","),
    ).toBe("Toggle bottom panel,Enter full view,Hide tabs");
    expect(rightPanel?.className.includes(APP_SHELL_RIGHT_PANEL_LAYER_CLASS)).toBe(true);
    expect(globalHeader?.className.includes(APP_SHELL_GLOBAL_HEADER_LAYER_CLASS)).toBe(true);
    expect(headerCenterSurface.getAttribute("aria-hidden")).toBe(null);
    expect(headerCenterSurface.className.includes("invisible")).toBe(false);
    await waitFor(() => {
      expect(headerShellSlot?.getAttribute("style")?.includes("width: 372px")).toBe(true);
    });
    expect(headerShellSlot?.getAttribute("style")?.includes("min-width: 70px")).toBe(true);
    expect(sidePanelToggle.getAttribute("aria-pressed")).toBe("true");
    expect(headerShellSlot?.contains(expandButton)).toBe(true);
    expect(tabHeader.contains(expandButton)).toBe(false);
    expect(rightPanelHeaderSpacer?.className.includes("pointer-events-none")).toBe(true);
    expect(rightPanelHeaderSpacer?.parentElement?.className.includes("pointer-events-auto")).toBe(
      false,
    );
    expect(rightPanelHeaderSpacer?.parentElement?.getAttribute("role")).toBe("presentation");
    expect(expandButton.className.includes("no-drag")).toBe(true);
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
      rightPanel?.querySelector('[role="tablist"]')?.parentElement?.parentElement?.parentElement;
    expect(fullWidthTabHeader?.firstElementChild?.querySelector('[role="tablist"]') !== null).toBe(
      true,
    );
    const restoreButton = screen.getByRole("button", { name: "Exit full view" });
    expect(globalHeader?.contains(restoreButton)).toBe(true);
    expect(fullWidthTabHeader?.contains(restoreButton)).toBe(false);
    expect(restoreButton.getAttribute("aria-pressed")).toBe("true");
  });

  test("right panel resize previews the dragged width before persistence", async () => {
    setShellBodyWidthForTest(1024);
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
    setShellBodyWidthForTest(1024);
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

      const toggleButton = screen.getByRole("button", { name: "Hide tabs" });
      await act(async () => {
        fireEvent.click(toggleButton);
        await Promise.resolve();
      });
      await settleAsyncRender();
      expect(screen.queryByTestId("session-right-panel")).toBe(null);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Show tabs" }));
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
    setShellBodyWidthForTest(1800);
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
    setShellBodyWidthForTest(1024);
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
      fireEvent.click(screen.getByRole("button", { name: "Exit full view" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    const regularRightPanel = screen.getByTestId("session-right-panel");
    const regularThreadPage = screen.container.querySelector('[data-testid="session-thread-page"]');
    const expandButton = screen.getByRole("button", { name: "Enter full view" });
    expect(regularRightPanel.getAttribute("data-right-panel-width-mode")).toBe("regular");
    expect(regularThreadPage?.getAttribute("data-session-thread-page-hidden")).toBe("false");
    expect(regularThreadPage?.className.split(/\s+/).includes("w-0")).toBe(false);
    expect(expandButton.getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Hide tabs" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(screen.queryByRole("button", { name: "Exit full view" })).toBe(null);
    expect(screen.queryByRole("separator", { name: "Resize right panel" })).toBe(null);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show tabs" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    const restoredRightPanel = screen.getByTestId("session-right-panel");
    const restoredThreadPage = screen.container.querySelector(
      '[data-testid="session-thread-page"]',
    );
    const restoredExpandButton = screen.getByRole("button", { name: "Enter full view" });
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
    const addTabButton = screen.getByRole("button", { name: "New tab" });
    expect(globalHeader?.contains(addTabButton)).toBe(false);
    expect(screen.queryByRole("button", { name: "Add DB view" })).toBe(null);

    const menu = await openPanelMenu(screen, "right");
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

    await pointerDownAndSettle(await findFilesPreviewInteractionTarget(screen));
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
    await waitFor(() => {
      const metadataCall = invokeCalls.find((call) => call[0] === "read-file-metadata");
      expect(JSON.stringify(metadataCall?.[1])).toContain(
        "/Users/asc/.nodex/worktrees/abcd/nodex/reports/summary.txt",
      );
      expect(JSON.stringify(metadataCall?.[1])).not.toContain("workspaceRoot");
    });
    expect(invokeCalls.some((call) => call[0] === "window-session-view:tab-create")).toBe(false);
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
    const fileTreeSurface = await waitFor(() => {
      const surface = screen.container.querySelector("aside[data-tab-preview-pin-exempt='true']");
      if (!(surface instanceof HTMLElement)) throw new Error("Expected the Files tree surface");
      return surface;
    });

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

  test("opening an existing file focuses its original panel instead of duplicating it", async () => {
    const path = "/workspace/report.txt";
    const id = "file:local:/workspace/report.txt";
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [
          makeAttachedSession({
            tabs: [
              {
                id,
                kind: "files",
                title: "report.txt",
                panelId: "bottom",
                config: {
                  projectId: "alpha",
                  hostId: "local",
                  cwd: "/workspace",
                  workspaceRoot: "/workspace",
                  path,
                },
              },
            ],
            panels: makePanels({
              rightCollapsed: true,
              bottomTabIds: [id],
              bottomActiveTabId: id,
              bottomCollapsed: true,
            }),
          }),
        ],
      },
    });
    await settleAsyncRender();
    const openOutput = (await waitForLastThreadStageActions())
      .onOpenSummaryOutputInSidePanel as (input: {
      path: string;
      title: string;
      cwd: string;
    }) => Promise<boolean>;
    await act(async () => {
      expect(await openOutput({ path, title: "report.txt", cwd: "/workspace" })).toBe(true);
    });
    await waitFor(() =>
      expect(screen.getAllByRole("tab", { name: "report.txt", selected: true })).toHaveLength(1),
    );
    expect(
      screen
        .getByTestId("session-bottom-panel")
        .contains(screen.getByRole("tab", { name: "report.txt" })),
    ).toBe(true);
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
    await waitFor(() => {
      expect(
        screen.container.querySelector(
          '[data-workspace-files-session-id="session:projectless:summary-output"]',
        ) !== null,
      ).toBe(true);
    });
    expect(invokeCalls.some((call) => call[0] === "window-session-view:tab-create")).toBe(false);

    await pointerDownAndSettle(await findFilesPreviewInteractionTarget(screen));
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

  test("the Browser action opens a durable New tab beside the durable Files tab", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();
    await settleAsyncRender();

    const filesMenu = await openPanelMenu(screen, "right");
    await clickMenuItem(filesMenu, "Files");

    expect(screen.getByRole("tab", { name: "Files" }) !== null).toBe(true);

    const browserMenu = await openPanelMenu(screen, "right");
    await clickMenuItem(browserMenu, "Browser");

    expect(screen.getByRole("tab", { name: "Files" }) !== null).toBe(true);
    expect((await screen.findByRole("tab", { name: "New tab" })) !== null).toBe(true);
    expect(screen.container.querySelector('[data-app-shell-tabpanel-preview="true"]')).toBe(null);
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
    expect(within(actionGrid).getByRole("button", { name: "Open page" }) !== null).toBe(true);
    expect(actionText.indexOf("Files") < actionText.indexOf("New page")).toBe(true);
    expect(actionText.indexOf("New page") < actionText.indexOf("DB View")).toBe(true);
    expect(actionText.indexOf("DB View") < actionText.indexOf("Open page")).toBe(true);
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
    // Async queries manage their own act environment; finish them before opening act.
    const projectlessRow = await waitForThreadRow(screen.container, "Projectless tools");
    await act(async () => {
      fireEvent.click(projectlessRow);
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

    const menu = await openPanelMenu(screen, "right");
    expect(within(menu).getByText("Side chat") !== null).toBe(true);
    expect(within(menu).getByText("Browser") !== null).toBe(true);
    expect(within(menu).getByText("Terminal") !== null).toBe(true);
    expect(within(menu).getByText("Review") !== null).toBe(true);
    expect(within(menu).queryByText("Files")).toBe(null);

    await clickMenuItem(menu, "Side chat");
    await settleAsyncRender();
    const created = invokeCalls.find(
      ([channel]) => channel === "agent-runtime:session:create-side-chat",
    )?.[1];
    expect(created).toMatchObject({
      source: { sessionId: projectlessSession.id, threadId: "thread-projectless-tools" },
    });
    expect(agentRuntimeLaunchCalls).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Close Side chat tab" })).toBeTruthy();
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
    const bottomMenu = await openPanelMenu(screen, "bottom");
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

  test("blank projectless chats expose Browser and New page", async () => {
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
      expect(screen.getByRole("tab", { name: "New tab" })).toBeDefined();
    });
    expect(browserShortcut.defaultPrevented).toBe(true);
    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:tab-create" &&
          (call[1] as { kind?: string } | undefined)?.kind === "browser",
      ),
    ).toBe(true);
  });

  test("bottom panel add menu shows Codex-eligible non-default actions", async () => {
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeAttachedSession()] },
    });
    await settleAsyncRender();
    await settleAsyncRender();
    await openBottomPanel(screen);

    const menu = await openPanelMenu(screen, "bottom");
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

    const menu = await openPanelMenu(screen, "right");
    const menuText = textContent(menu);
    expect(menuText.indexOf("Review") < menuText.indexOf("Terminal")).toBe(true);
    expect(menuText.indexOf("Side chat") < menuText.indexOf("New page")).toBe(true);
    expect(menuText.indexOf("New page") < menuText.indexOf("DB View")).toBe(true);
    expect(menuText.indexOf("DB View") < menuText.indexOf("Open page")).toBe(true);
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
        routingContext: { kind: "project", projectId: "alpha" },
        target: { kind: "database-view", databaseViewId: "view:planning" },
      },
    });
    const otherTab = makeSessionTab({
      id: "tab:other-view",
      title: "Other",
      kind: "db_view",
      config: {
        routingContext: { kind: "project", projectId: "alpha" },
        target: { kind: "database-view", databaseViewId: "view:other" },
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

    const menu = await openPanelMenu(screen, "right");
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

    const betaMenu = await openPanelMenu(screen, "right");
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
    await pointerActivate(within(actionGrid).getByRole("button", { name: "Open page" }));
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

    const menu = await openPanelMenu(screen, "bottom");
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
    await pointerDownAndSettle(await findFilesPreviewInteractionTarget(screen));
    expect(
      invokeCalls.filter(
        (call) =>
          call[0] === "window-session-view:tab-create" &&
          JSON.stringify(call[1]).includes('"kind":"files"'),
      ),
    ).toHaveLength(tabCreateCount);
  });

  test("bottom Browser action opens a durable New tab", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();
    await settleAsyncRender();
    await openBottomPanel(screen);

    const menu = await openPanelMenu(screen, "bottom");
    await clickMenuItem(menu, "Browser");

    expect((await screen.findByRole("tab", { name: "New tab" })) !== null).toBe(true);
    expect(screen.container.querySelector('[data-app-shell-tabpanel-preview="true"]')).toBe(null);
    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:tab-create" &&
          JSON.stringify(call[1]).includes('"panelId":"bottom"') &&
          JSON.stringify(call[1]).includes('"kind":"browser"'),
      ),
    ).toBe(true);
  });

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

    const menu = await openPanelMenu(screen, "bottom");
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
    expect(
      invokeCalls.filter(([channel]) => channel === "agent-runtime:session:create-side-chat"),
    ).toHaveLength(1);
    expect(agentRuntimeLaunchCalls).toHaveLength(0);
    expect(invokeCalls.filter((call) => call[0] === "window-session-view:tab-create")).toHaveLength(
      durableTabCreateCount,
    );
    expect(screen.getByRole("textbox", { name: "Prompt" })).toBeTruthy();
    const stageProps = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(JSON.stringify(stageProps?.sideChatContext ?? null)).toBe(
      '{"parentThreadId":"thread-alpha","tabTitle":"Side chat"}',
    );
    expect(typeof stageProps?.composerScopeIdentity).toBe("string");
    expect(String(stageProps?.composerScopeIdentity).startsWith("side-chat-session:")).toBe(true);
    expect(stageProps?.isQueueingEnabled).toBe(false);
    expect(stageProps?.composerEnterBehavior).toBe("cmdIfMultiline");
    expect(Boolean(stageProps?.summaryPanelMounted)).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close Side chat tab" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(discardSideChatCalls).toHaveLength(0);
    expect(
      invokeCalls.filter(([channel]) => channel === "agent-runtime:session:discard-side-chat"),
    ).toHaveLength(1);
    expect(invokeCalls.filter(([channel]) => channel === "project-sessions:delete")).toHaveLength(
      0,
    );
  });

  test("projectless side chat creates its own projectless Session and draft", async () => {
    const source = makeAttachedSession({
      id: "source:projectless",
      projectId: null,
      threadId: "source-thread",
      tabs: [],
    });
    const screen = renderWorkbench({
      projects: [],
      sessionsByProject: {},
      projectlessSessions: [source],
      initialSelectedSessionId: source.id,
    });
    const actions = await waitForLastThreadStageActions();
    await act(async () => {
      await (
        actions.onOpenSideChat as import("@/features/local-conversation/thread-stage-types").ThreadStageActions["onOpenSideChat"]
      )?.({ kind: "draft", draftPrompt: "Independent context" });
    });
    await settleAsyncRender();
    await screen.findByDisplayValue("Independent context");
    const created = invokeCalls.find(
      ([channel]) => channel === "agent-runtime:session:create-side-chat",
    )?.[1] as import("../../../shared/agent-runtime-api").AgentRuntimeSideChatCreateInput;
    expect(created?.sessionId).not.toBe(source.id);
    expect(created?.source).toEqual({ sessionId: source.id, threadId: "source-thread" });
    expect(agentRuntimeLaunchCalls).toHaveLength(0);
  });

  test.each(["runtime", "native-import"] as const)(
    "selected-text side chat from %s captures context before Send and keeps its bound Session",
    async (sourceKind) => {
      const browserTab = makeSessionTab({
        id: "selection-source:browser",
        sessionId: "selection-source",
        kind: "browser",
        title: "Browser",
        config: { projectId: "alpha" },
      });
      const source = makeAttachedSession({
        id: "selection-source",
        tabs: [browserTab],
        rightLayout: makePanelLayout([browserTab.id], browserTab.id),
      });
      if (sourceKind === "native-import") {
        source.executionRef = null;
        source.thread = {
          ...source.thread!,
          backendBinding: { kind: "claude", instanceConfigId: "native-claude" },
        };
      }
      const screen = renderWorkbench({
        sessionsByProject: { alpha: [source] },
        initialSelectedSessionId: source.id,
      });
      if (sourceKind === "native-import")
        await pointerActivate(await waitForThreadRow(screen.container, source.displayTitle));
      const actions = await waitForLastThreadStageActions();
      await act(async () => {
        await (
          actions.onOpenSideChat as import("@/features/local-conversation/thread-stage-types").ThreadStageActions["onOpenSideChat"]
        )?.({ kind: "draft", draftPrompt: "Use this selected paragraph" });
      });
      await screen.findByDisplayValue("Use this selected paragraph");
      const created = invokeCalls.find(
        ([channel]) => channel === "agent-runtime:session:create-side-chat",
      )?.[1] as import("../../../shared/agent-runtime-api").AgentRuntimeSideChatCreateInput;
      expect(created?.sessionId).not.toBe(source.id);
      expect(agentRuntimeLaunchCalls).toHaveLength(0);
      expect(startSideChatCalls).toHaveLength(0);
      expect(created.source).toMatchObject({ sessionId: source.id });
      expect(
        invokeCalls.filter(([channel]) => channel === "agent-runtime:session:message"),
      ).toHaveLength(0);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(
          invokeCalls.filter(([channel]) => channel === "agent-runtime:session:message"),
        ).toHaveLength(1),
      );
      expect(
        invokeCalls.find(([channel]) => channel === "agent-runtime:session:message")?.[1],
      ).toMatchObject({
        sessionId: created?.sessionId,
        threadId: `engine:${created.sessionId}`,
        message: { text: "Use this selected paragraph" },
      });
      expect(screen.queryByRole("tab", { name: "Side chat" })).toBeTruthy();
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: "Browser" }));
        await Promise.resolve();
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: "Side chat" }));
        await Promise.resolve();
      });
      await waitFor(() => {
        const sideChat = getConnectedThreadStagePropsByThreadId(`engine:${created.sessionId}`);
        expect(sideChat?.isNewThreadTab).toBe(false);
      });
      expect(agentRuntimeLaunchCalls).toHaveLength(0);
      expect(
        invokeCalls.filter(([channel]) => channel === "agent-runtime:session:message"),
      ).toHaveLength(1);
    },
  );

  test("an explicit side-chat prompt sends once in the captured conversation", async () => {
    const source = makeAttachedSession({ id: "explicit-side-source", tabs: [] });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [source] },
      initialSelectedSessionId: source.id,
    });
    const actions = await waitForLastThreadStageActions();
    await act(async () => {
      await (
        actions.onOpenSideChat as import("@/features/local-conversation/thread-stage-types").ThreadStageActions["onOpenSideChat"]
      )?.({ prompt: "Answer this separate question" });
    });
    await waitFor(() =>
      expect(
        invokeCalls.filter(([channel]) => channel === "agent-runtime:session:message"),
      ).toHaveLength(1),
    );
    const created = invokeCalls.find(
      ([channel]) => channel === "agent-runtime:session:create-side-chat",
    )?.[1] as import("../../../shared/agent-runtime-api").AgentRuntimeSideChatCreateInput;
    expect(
      invokeCalls.find(([channel]) => channel === "agent-runtime:session:message")?.[1],
    ).toMatchObject({
      sessionId: created?.sessionId,
      threadId: `engine:${created.sessionId}`,
      message: { text: "Answer this separate question" },
    });
    expect(startSideChatCalls).toHaveLength(0);
    expect(agentRuntimeLaunchCalls).toHaveLength(0);
    expect(created.source).toMatchObject({ sessionId: source.id });
    expect(screen.getByRole("tab", { name: "Answer this separate question" })).toBeTruthy();
  });

  test("opens each interactive child in its owning root detail without native hydration", async () => {
    const root = makeAttachedSession({
      id: "root-session",
      threadId: "root-thread",
      tabs: [],
      rightCollapsed: true,
    });
    for (const id of ["interactive-a", "interactive-b"])
      sideChatConversations[id] = {
        threadId: id,
        source: { parentThreadId: "root-thread" },
        threadName: id,
      };
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [root] },
      initialSelectedSessionId: root.id,
    });
    const actions = await waitForLastThreadStageActions();
    const open =
      actions.onOpenThread as import("@/features/local-conversation/thread-stage-types").ThreadStageActions["onOpenThread"];
    for (const id of ["interactive-a", "interactive-b"]) {
      await act(async () => {
        await open(id, {
          runtimeSessionId: root.id,
          subagent: {
            conversationId: id,
            displayName: id,
            agentRole: null,
            spawnModel: null,
            status: "active",
            statusSummary: null,
            diffStats: null,
            canInteract: true,
          },
        });
      });
      await waitFor(() =>
        expect(getConnectedThreadStagePropsByThreadId(id)?.backgroundAgentCanInteract).toBe(true),
      );
    }
    expect(
      getPanelTabById(screen.container, "subagents:root-thread").getAttribute("aria-selected"),
    ).toBe("true");
    expect(hydrateSelectedSubagentCalls).toHaveLength(0);
    expect(
      invokeCalls.filter(([channel]) => channel === "agent-runtime:session:read"),
    ).toHaveLength(0);
  });

  test("a late child inspection cannot replace a newer selected child", async () => {
    const root = makeAttachedSession({ id: "latest-root", threadId: "root-thread", tabs: [] });
    for (const id of ["late-child", "latest-child"])
      sideChatConversations[id] = {
        threadId: id,
        source: { parentThreadId: "root-thread" },
        threadName: id,
      };
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [root] },
      initialSelectedSessionId: root.id,
    });
    const actions = await waitForLastThreadStageActions();
    const open =
      actions.onOpenThread as import("@/features/local-conversation/thread-stage-types").ThreadStageActions["onOpenThread"];
    const base = mockInvokeImpl;
    if (!base) throw new Error("Expected Runtime metadata transport");
    let release = () => {};
    let entered = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setMockInvokeImpl(async (channel, ...args) => {
      if (
        channel === "agent-runtime:session:inspect" &&
        (args[0] as { threadId: string }).threadId === "late-child"
      ) {
        entered = true;
        await gate;
      }
      return base(channel, ...args);
    });
    let late: Promise<void> = Promise.resolve();
    try {
      await act(async () => {
        late = Promise.resolve(open("late-child", { runtimeSessionId: root.id }));
        await Promise.resolve();
      });
      await waitFor(() => expect(entered).toBe(true));
      await act(async () => {
        await open("latest-child", { runtimeSessionId: root.id });
      });
      await waitFor(() =>
        expect(getConnectedThreadStagePropsByThreadId("latest-child")).toBeDefined(),
      );
      await act(async () => {
        release();
        await late;
      });
      expect(getConnectedThreadStagePropsByThreadId("late-child")).toBeUndefined();
      expect(getConnectedThreadStagePropsByThreadId("latest-child")).toBeDefined();
      expect(
        screen.container.querySelector('[data-subagents-side-panel-tab="subagents:root-thread"]'),
      ).toBeTruthy();
      expect(
        invokeCalls.filter(([channel]) => channel === "agent-runtime:session:read"),
      ).toHaveLength(0);
    } finally {
      await act(async () => {
        release();
        await late;
      });
    }
  });
});
