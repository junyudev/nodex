import "./workbench-testkit/workbench-shell-harness";
import { describe, test, expect } from "vite-plus/test";
import { settleAsyncRender, textContent } from "../../test/dom";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { getBoardProjectStore } from "@/lib/board-store";
import { MotionGlobalConfig } from "motion";
import { type CodexSidebarThreadItem } from "@/lib/types";
import { __getNodexToastSnapshotForTests } from "@/components/ui/toast";
import {
  makeAttachedSession,
  makePanelLayout,
  makeProject,
  makeSession,
} from "./workbench-testkit/workbench-shell-fixtures";
import {
  getConnectedThreadStagePropsByThreadId,
  getLastThreadStageActions,
  getMountedSessionIds,
  getMountedSessionRoot,
  getSidebarProjectGroup,
  getSidebarSection,
  getThreadRow,
  getThreadRowTitles,
  installMotionEnabledMatchMediaForTest,
  installReducedMotionMatchMediaForTest,
  invokeCalls,
  mockInvokeImpl,
  renderWorkbench,
  requestThreadStreamSnapshotCalls,
  selectSidebarSession,
  setInvokeCalls,
  setMockInvokeImpl,
  setRequestThreadStreamSnapshotImpl,
} from "./workbench-testkit/workbench-shell-harness";
describe("workbench session shell / sidebar-core", () => {
  test("settles Motion without impersonating reduced-motion preferences", () => {
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(false);
    expect(MotionGlobalConfig.skipAnimations).toBe(true);
  });

  test("loads project sessions and renders the Database View DB tab", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();
    await settleAsyncRender();

    const text = textContent(screen.container);
    expect(text.includes("Alpha")).toBe(true);
    expect(text.includes("Database View")).toBe(true);
    expect(text.includes("DB:alpha:board")).toBe(true);
    expect(
      invokeCalls.some((call) => call[0] === "project-sessions:list" && call[1] === "alpha"),
    ).toBe(false);
    expect(
      invokeCalls.some((call) => call[0] === "workspace:tasks:list" && call[1] === "alpha"),
    ).toBe(true);
    expect(
      invokeCalls.some(
        (call) => call[0] === "project-sessions:get" && call[1] === "session:alpha:database-view",
      ),
    ).toBe(true);
  });

  test("shows the Chats loading state on the first render instead of flashing the empty state", async () => {
    const screen = renderWorkbench({
      projectlessSessions: [],
      sessionsByProject: { alpha: [] },
    });
    const projectRow = screen.container.querySelector(
      '[data-app-action-sidebar-project-id="alpha"]',
    );
    if (!(projectRow instanceof HTMLElement)) {
      throw new Error("Expected Alpha project row");
    }

    expect(screen.getAllByText("Loading chats...")).toHaveLength(1);
    expect(within(projectRow).queryByText("Loading chats...")).toBe(null);
    expect(screen.queryByText("No projectless chats")).toBe(null);
    expect(screen.queryByText("No chats inside")).toBe(null);

    await settleAsyncRender();
    await settleAsyncRender();
    expect(screen.getByText("No projectless chats") !== null).toBe(true);
    const projectsSection = getSidebarSection(screen.container, "Projects");
    const projectGroup = getSidebarProjectGroup(projectsSection, "alpha");
    expect(within(projectGroup).getByText("No chats inside") !== null).toBe(true);
    expect(screen.queryByText("Loading chats...")).toBe(null);
  });

  test("does not reload session scopes when Project objects change without membership changes", async () => {
    const initialProjects = [makeProject()];
    const screen = renderWorkbench({ projects: initialProjects });
    await settleAsyncRender();
    await settleAsyncRender();

    const initialSummaryCallCount = invokeCalls.filter(
      (call) => call[0] === "workspace:tasks:list",
    ).length;
    expect(screen.getByText("No projectless chats") !== null).toBe(true);

    await act(async () => {
      screen.replaceProjects(
        initialProjects.map((project) => ({
          ...project,
          created: new Date(project.created),
          updated: new Date(project.updated),
        })),
      );
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(invokeCalls.filter((call) => call[0] === "workspace:tasks:list").length).toBe(
      initialSummaryCallCount,
    );
    expect(screen.getByText("No projectless chats") !== null).toBe(true);
    expect(screen.queryByText("Loading chats...")).toBe(null);
  });

  test("loads projectless Chats when the workspace has no Projects", async () => {
    const projectless = makeAttachedSession({
      id: "session:projectless:only",
      projectId: null,
      threadId: "thread-projectless-only",
      title: "Projectless only chat",
    });
    const screen = renderWorkbench({
      projects: [],
      sessionsByProject: {},
      projectlessSessions: [projectless],
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(screen.getByText("Projectless only chat") !== null).toBe(true);
    expect(screen.queryByText("No projects found.")).toBe(null);
    expect(invokeCalls.some((call) => call[0] === "workspace:tasks:list" && call[1] === null)).toBe(
      true,
    );
  });

  test("enters an explicit projectless composition after the final Project disappears", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();

    await act(async () => {
      screen.replaceProjects([]);
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(screen.getByRole("button", { name: "Start a projectless chat" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Project sidebar options" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add new project" })).toBeTruthy();
  });

  test("navigates back to the explicit no-Project state after restoring a Project", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();

    await act(async () => {
      screen.replaceProjects([]);
      await Promise.resolve();
    });
    await settleAsyncRender();
    await act(async () => {
      screen.replaceProjects([makeProject()]);
      await Promise.resolve();
    });
    await settleAsyncRender();

    await selectSidebarSession(screen.container, "Database View");
    expect(textContent(screen.container).includes("DB:alpha:board")).toBe(true);
    const backButton = screen.getByRole("button", { name: "Back" });
    const forwardButton = screen.getByRole("button", { name: "Forward" });
    expect(backButton.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      fireEvent.click(backButton);
      await Promise.resolve();
    });
    await settleAsyncRender();
    expect(screen.getByRole("button", { name: "Start a projectless chat" })).toBeTruthy();
    expect(forwardButton.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      fireEvent.click(forwardButton);
      await Promise.resolve();
    });
    await settleAsyncRender();
    expect(textContent(screen.container).includes("DB:alpha:board")).toBe(true);
  });

  test("consumes a staged fork side-panel snapshot only after a real target session enters", async () => {
    const target = makeAttachedSession({
      id: "session:alpha:fork-target",
      threadId: "thread-fork-target",
      title: "Fork target",
    });
    renderWorkbench({
      sessionsByProject: { alpha: [target] },
      initialSelectedSessionId: target.id,
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const consumeCalls = invokeCalls.filter(
      (call) => call[0] === "codex:fork-side-panel-transfer:consume",
    );
    expect(consumeCalls.length).toBe(1);
    expect(JSON.stringify(consumeCalls[0]?.[1])).toBe(
      JSON.stringify({
        routeKind: "local-thread",
        targetConversationId: "thread-fork-target",
        targetProjectSessionId: "session:alpha:fork-target",
        targetBrowserViewScopeId: "window-session:test",
      }),
    );
  });

  test("switches cached DB sessions with one mounted page and restores explicit scroll state", async () => {
    const alphaHome = makeSession({
      id: "session:alpha:home",
      title: "Alpha Home",
      order: 0,
      rightFullWidth: true,
    });
    const alphaWork = makeSession({
      id: "session:alpha:work",
      title: "Alpha Work",
      order: 1,
      rightFullWidth: true,
      tabs: [
        {
          id: "session:alpha:work:db",
          sessionId: "session:alpha:work",
          projectId: "alpha",
          kind: "db_view",
          title: "DB View",
          config: { projectId: "alpha" },
        },
      ],
      rightLayout: makePanelLayout(["session:alpha:work:db"], "session:alpha:work:db"),
    });
    const betaWork = makeSession({
      id: "session:beta:work",
      projectId: "beta",
      title: "Beta Work",
      order: 0,
      rightFullWidth: true,
    });
    const screen = renderWorkbench({
      projects: [makeProject("alpha", "Alpha"), makeProject("beta", "Beta")],
      sessionsByProject: {
        alpha: [alphaHome, alphaWork],
        beta: [betaWork],
      },
      initialSelectedSessionId: alphaHome.id,
      sidebar: { collapsed: false, width: 300 },
    });
    await settleAsyncRender();
    await settleAsyncRender();
    await waitFor(() => {
      expect(getMountedSessionIds(screen.container)).toEqual([alphaHome.id]);
    });
    await waitFor(() => {
      expect(
        getBoardProjectStore("alpha", "database-view:alpha:primary-board").getSnapshot().loading,
      ).toBe(false);
    });
    expect(
      getBoardProjectStore("alpha", "database-view:alpha:primary-board").getSnapshot().error,
    ).toBe(null);
    await waitFor(() => {
      expect(
        getBoardProjectStore("alpha", "database-view:alpha:primary-board").getSnapshot()
          .databaseView?.databaseViewId,
      ).toBe("view:alpha");
    });

    const alphaSearch = within(getMountedSessionRoot(screen.container)).getByLabelText(
      "Mock DB search alpha",
    ) as HTMLInputElement;
    const alphaScroll = within(getMountedSessionRoot(screen.container)).getByTestId(
      "mock-db-scroll-alpha",
    );
    await act(async () => {
      fireEvent.input(alphaSearch, { target: { value: "status:hot" } });
      alphaScroll.scrollTop = 136;
      alphaScroll.scrollLeft = 28;
      fireEvent.scroll(alphaScroll);
      await Promise.resolve();
    });
    expect(alphaSearch.value).toBe("status:hot");
    expect(alphaScroll.scrollTop).toBe(136);
    expect(alphaScroll.scrollLeft).toBe(28);

    setInvokeCalls([]);
    await selectSidebarSession(screen.container, "Alpha Work");
    const betaProjectRow = screen.container.querySelector(
      '[data-app-action-sidebar-project-id="beta"]',
    );
    if (!(betaProjectRow instanceof HTMLElement)) {
      throw new Error("Expected Beta project row");
    }
    await act(async () => {
      fireEvent.click(within(betaProjectRow).getByText("Beta"));
      await Promise.resolve();
    });
    await settleAsyncRender();
    await selectSidebarSession(screen.container, "Beta Work");
    await selectSidebarSession(screen.container, "Alpha Home");

    const detailGets = invokeCalls
      .filter((call) => call[0] === "project-sessions:get")
      .map((call) => String(call[1]));
    expect(JSON.stringify(detailGets)).toBe(
      JSON.stringify(["session:alpha:work", "session:beta:work"]),
    );
    expect(invokeCalls.some((call) => call[0] === "project-sessions:list")).toBe(false);
    expect(
      invokeCalls.some((call) => call[0] === "database:view-window:get" && call[1] === "alpha"),
    ).toBe(false);

    const restoredAlphaSearch = within(getMountedSessionRoot(screen.container)).getByLabelText(
      "Mock DB search alpha",
    ) as HTMLInputElement;
    const restoredAlphaScroll = within(getMountedSessionRoot(screen.container)).getByTestId(
      "mock-db-scroll-alpha",
    );
    expect(restoredAlphaSearch.value).toBe("");
    expect(restoredAlphaScroll.scrollTop).toBe(136);
    expect(restoredAlphaScroll.scrollLeft).toBe(28);
  });

  test("mounts exactly one selected page while switching across five sessions", async () => {
    const sessions = [1, 2, 3, 4, 5].map((index) =>
      makeSession({
        id: `session:alpha:single-${index}`,
        title: `Session ${index}`,
        order: index - 1,
        rightFullWidth: true,
      }),
    );
    const screen = renderWorkbench({
      sessionsByProject: { alpha: sessions },
      initialSelectedSessionId: "session:alpha:single-1",
      sidebar: { collapsed: false, width: 300 },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const firstSearch = within(getMountedSessionRoot(screen.container)).getByLabelText(
      "Mock DB search alpha",
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.input(firstSearch, { target: { value: "evict me" } });
      await Promise.resolve();
    });
    expect(firstSearch.value).toBe("evict me");

    await selectSidebarSession(screen.container, "Session 2");
    await selectSidebarSession(screen.container, "Session 3");
    await selectSidebarSession(screen.container, "Session 4");
    await selectSidebarSession(screen.container, "Session 5");

    expect(getMountedSessionIds(screen.container)).toEqual(["session:alpha:single-5"]);

    await selectSidebarSession(screen.container, "Session 1");
    const remountedSearch = within(getMountedSessionRoot(screen.container)).getByLabelText(
      "Mock DB search alpha",
    ) as HTMLInputElement;
    expect(remountedSearch.value).toBe("");
  });

  test("regular right panels preserve the selected thread route and transcript", async () => {
    const session = makeAttachedSession({
      id: "session:alpha:thread-regular",
      threadId: "thread-regular",
      title: "Regular thread",
      order: 0,
      rightFullWidth: false,
    });
    const namedSession = {
      ...session,
      thread: session.thread ? { ...session.thread, threadName: "Regular thread" } : null,
    };
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [namedSession] },
      initialSelectedSessionId: session.id,
      sidebar: { collapsed: false, width: 300 },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(screen.getByTestId("thread-stage-title").textContent).toBe("Regular thread");
    expect(getConnectedThreadStagePropsByThreadId("thread-regular")?.routeActive).toBe(true);
    expect(getConnectedThreadStagePropsByThreadId("thread-regular")?.threadBodyVisible).toBe(true);
  });

  test("keeps the selected route active while hiding only its full-width transcript", async () => {
    const first = makeAttachedSession({
      id: "session:alpha:thread-a",
      threadId: "thread-a",
      title: "Thread A",
      order: 0,
      rightFullWidth: true,
    });
    const second = makeAttachedSession({
      id: "session:alpha:thread-b",
      threadId: "thread-b",
      title: "Thread B",
      order: 1,
      rightFullWidth: true,
    });
    const namedFirst = {
      ...first,
      thread: first.thread ? { ...first.thread, threadName: "Thread A" } : null,
    };
    const namedSecond = {
      ...second,
      thread: second.thread ? { ...second.thread, threadName: "Thread B" } : null,
    };
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [namedFirst, namedSecond] },
      initialSelectedSessionId: first.id,
      sidebar: { collapsed: false, width: 300 },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(getConnectedThreadStagePropsByThreadId("thread-a")?.routeActive).toBe(true);
    expect(getConnectedThreadStagePropsByThreadId("thread-a")?.threadBodyVisible).toBe(false);

    await selectSidebarSession(screen.container, "Thread B");

    expect(screen.getByTestId("thread-stage-title").textContent).toBe("Thread B");
    expect(getConnectedThreadStagePropsByThreadId("thread-b")?.routeActive).toBe(true);
    expect(getConnectedThreadStagePropsByThreadId("thread-b")?.threadBodyVisible).toBe(false);
    expect(getMountedSessionIds(screen.container)).toEqual(["session:alpha:thread-b"]);
  });

  test("renders Codex sidebar route rows inside the scroll area in captured order", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();
    await settleAsyncRender();

    const nav = screen.getByRole("navigation", { name: "Automation folders" });
    const scrollChrome = nav.parentElement;
    if (!(scrollChrome instanceof HTMLElement)) {
      throw new Error("Expected sidebar scroll chrome owner");
    }
    const fixedHeader = nav.children.item(0);
    if (!(fixedHeader instanceof HTMLElement)) {
      throw new Error("Expected fixed sidebar header");
    }

    const fixedHeaderText = textContent(fixedHeader);
    expect(fixedHeaderText.includes("Nodex")).toBe(true);
    expect(fixedHeaderText.includes("New chat")).toBe(true);
    expect(within(fixedHeader).getByRole("button", { name: "Search" }) !== null).toBe(true);
    expect(fixedHeaderText.includes("Scheduled")).toBe(false);
    expect(fixedHeaderText.includes("Plugins")).toBe(false);
    expect(fixedHeader.getAttribute("data-scrolled-content-under-header")).toBe("false");

    const scrollArea = nav.querySelector("[data-app-action-sidebar-scroll]");
    if (!(scrollArea instanceof HTMLElement)) {
      throw new Error("Expected sidebar scroll area");
    }

    const routeActions = scrollArea.querySelector("[data-app-action-sidebar-scroll-top-actions]");
    if (!(routeActions instanceof HTMLElement)) {
      throw new Error("Expected scroll-owned route actions");
    }

    expect(scrollArea.firstElementChild === routeActions).toBe(true);
    expect(within(routeActions).getByRole("button", { name: "Scheduled" }) !== null).toBe(true);
    expect(within(routeActions).getByRole("button", { name: "Plugins" }) !== null).toBe(true);
    expect(scrollArea.getAttribute("data-content-below")).toBe("false");
    expect(scrollChrome.style.getPropertyValue("--sidebar-scroll-footer-edge-offset")).toBe(
      "calc(var(--spacing) * 10)",
    );

    const routeActionsText = textContent(routeActions);
    expect(routeActionsText.indexOf("Scheduled") < routeActionsText.indexOf("Plugins")).toBe(true);

    Object.defineProperties(scrollArea, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 220 },
    });

    await act(async () => {
      scrollArea.scrollTop = 0;
      fireEvent.scroll(scrollArea);
      await Promise.resolve();
    });
    expect(scrollArea.getAttribute("data-content-below")).toBe("true");
    expect(scrollChrome.style.getPropertyValue("--sidebar-scroll-footer-edge-offset")).toBe("0px");

    await act(async () => {
      scrollArea.scrollTop = 120;
      fireEvent.scroll(scrollArea);
      await Promise.resolve();
    });
    expect(fixedHeader.getAttribute("data-scrolled-content-under-header")).toBe("true");
    expect(scrollArea.getAttribute("data-content-below")).toBe("false");
    expect(scrollChrome.style.getPropertyValue("--sidebar-scroll-footer-edge-offset")).toBe(
      "calc(var(--spacing) * 10)",
    );
  });

  test("renders the Codex sidebar navigation landmark", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();
    await settleAsyncRender();

    const nav = screen.getByRole("navigation", { name: "Automation folders" });
    expect(nav.closest('[data-testid="project-session-sidebar"]') !== null).toBe(true);
  });

  test("sidebar Search opens the command palette in pages mode", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      screen.openCommandPalette("pages");
      await Promise.resolve();
    });
    await settleAsyncRender();

    const commandModeInput = screen.getByLabelText("Command palette search") as HTMLInputElement;
    expect(commandModeInput.value).toBe("pages");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close palette" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    const sidebar = screen.container.querySelector('[data-testid="project-session-sidebar"]');
    if (!(sidebar instanceof HTMLElement)) {
      throw new Error("Expected project session sidebar");
    }

    const searchButton = within(sidebar).getByRole("button", { name: "Search" });

    await act(async () => {
      fireEvent.click(searchButton);
      await Promise.resolve();
    });
    await settleAsyncRender();

    const defaultSearchInput = screen.getByLabelText("Command palette search") as HTMLInputElement;
    expect(defaultSearchInput.value).toBe("pages");
  });

  test("sidebar pin button toggles a session without selecting it", async () => {
    const target = makeAttachedSession({
      id: "session:alpha:pin-target",
      threadId: "thread-pin-target",
      title: "Pin target",
      order: 1,
      rightCollapsed: true,
      tabs: [],
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeSession(), target] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const row = getThreadRow(screen.container, "Pin target");
    const pinButton = row.querySelector("[data-app-action-sidebar-thread-pin-session]");
    if (!(pinButton instanceof HTMLButtonElement)) {
      throw new Error("Expected Pin target pin button");
    }
    expect(pinButton.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 20 20");
    await act(async () => {
      fireEvent.click(pinButton);
      await Promise.resolve();
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "codex:threads:pinned:set" &&
          call[1] === "thread-pin-target" &&
          (call[2] as { pinned?: boolean } | undefined)?.pinned === true,
      ),
    ).toBe(true);
    const updatedRow = getThreadRow(screen.container, "Pin target");
    expect(updatedRow.getAttribute("data-app-action-sidebar-thread-pinned")).toBe("true");
    const updatedButton = updatedRow.querySelector("[data-app-action-sidebar-thread-pin-session]");
    expect(updatedButton?.getAttribute("aria-label")).toBe("Unpin chat");
    expect(updatedButton?.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 24 24");
  });

  test("does not keep a session fork action pending on destination snapshot hydration", async () => {
    const sourceSession = makeAttachedSession({
      id: "session:alpha:fork-source",
      threadId: "thread-fork-source",
      title: "Fork source",
      tabs: [],
    });
    const targetSession = makeAttachedSession({
      id: "session:alpha:fork-target",
      threadId: "thread-fork-target",
      title: "Fork target",
      tabs: [],
    });
    renderWorkbench({
      sessionsByProject: { alpha: [sourceSession] },
      initialSelectedSessionId: sourceSession.id,
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const renderInvoke = mockInvokeImpl;
    if (!renderInvoke) throw new Error("Expected the workbench invoke mock");
    setMockInvokeImpl(async (channel, ...args) => {
      if (channel === "project-sessions:fork") {
        return {
          session: targetSession,
          threadId: "thread-fork-target",
          composerIntent: {
            prompt: "",
            focusNonce: 1,
          },
        };
      }
      return await renderInvoke(channel, ...args);
    });

    let releaseSnapshot: () => void = () => undefined;
    setRequestThreadStreamSnapshotImpl(async () => {
      await new Promise<void>((resolve) => {
        releaseSnapshot = resolve;
      });
    });

    const actions = getLastThreadStageActions();
    const forkFromTurn = actions.onForkFromTurn as
      | ((input: { threadId: string; turnId: string; message: string }) => Promise<void>)
      | undefined;
    expect(typeof forkFromTurn).toBe("function");

    let forkActionResolved = false;
    const forkAction =
      forkFromTurn?.({
        threadId: "thread-fork-source",
        turnId: "turn-fork-source",
        message: "Fork from here",
      }).then(() => {
        forkActionResolved = true;
      }) ?? Promise.resolve();

    try {
      await waitFor(() => {
        expect(requestThreadStreamSnapshotCalls.includes("thread-fork-target")).toBe(true);
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(forkActionResolved).toBe(true);
    } finally {
      releaseSnapshot();
      await forkAction;
      setRequestThreadStreamSnapshotImpl(null);
    }
  });

  test("sidebar archive hover action archives a session-backed chat optimistically", async () => {
    const target = makeAttachedSession({
      id: "session:alpha:archive-target",
      threadId: "thread-archive-target",
      title: "Archive target",
      order: 1,
      rightCollapsed: true,
      tabs: [],
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeSession(), target] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await selectSidebarSession(screen.container, "Archive target");
    await selectSidebarSession(screen.container, "Database View");
    expect(getMountedSessionIds(screen.container)).toEqual(["session:alpha:database-view"]);

    const row = getThreadRow(screen.container, "Archive target");
    const archiveButton = within(row).getByRole("button", { name: "Archive chat" });
    expect(archiveButton.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 20 20");

    await act(async () => {
      fireEvent.click(archiveButton);
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(
      screen.container.querySelector('[data-app-action-sidebar-thread-title="Archive target"]'),
    ).toBe(null);
    expect(getMountedSessionIds(screen.container).includes("session:alpha:archive-target")).toBe(
      false,
    );
    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "project-sessions:archive" && call[1] === "session:alpha:archive-target",
      ),
    ).toBe(true);
  });

  test("sidebar archive hover action uses codex thread archive for snapshot-only chats", async () => {
    const snapshotOnlyItem: CodexSidebarThreadItem = {
      key: "local:thread-snapshot-only",
      kind: "local",
      runLocation: { kind: "local-checkout" },
      hostId: "local",
      threadId: "thread-snapshot-only",
      parentThreadId: null,
      sessionId: null,
      projectId: null,
      title: "Snapshot only",
      preview: "",
      cwd: null,
      updatedAt: 10,
      createdAt: 1,
      pinned: false,
      pinnedOrder: null,
      unread: false,
      archived: false,
      statusType: "idle",
      statusActiveFlags: [],
      projectless: true,
      disabled: false,
    };
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeSession()] },
      sidebarSnapshotItems: [snapshotOnlyItem],
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const row = getThreadRow(screen.container, "Snapshot only");
    const archiveButton = within(row).getByRole("button", { name: "Archive chat" });

    await act(async () => {
      fireEvent.click(archiveButton);
      await Promise.resolve();
    });

    expect(
      screen.container.querySelector('[data-app-action-sidebar-thread-title="Snapshot only"]'),
    ).toBe(null);
    expect(
      invokeCalls.some(
        (call) => call[0] === "codex:thread:archive" && call[1] === "thread-snapshot-only",
      ),
    ).toBe(true);
  });

  test("sidebar archive pending state is released when snapshot-only archive fails", async () => {
    const snapshotOnlyItem: CodexSidebarThreadItem = {
      key: "local:thread-archive-failure",
      kind: "local",
      runLocation: { kind: "local-checkout" },
      hostId: "local",
      threadId: "thread-archive-failure",
      parentThreadId: null,
      sessionId: null,
      projectId: null,
      title: "Archive failure",
      preview: "",
      cwd: null,
      updatedAt: 10,
      createdAt: 1,
      pinned: false,
      pinnedOrder: null,
      unread: false,
      archived: false,
      statusType: "idle",
      statusActiveFlags: [],
      projectless: true,
      disabled: false,
    };
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeSession()] },
      sidebarSnapshotItems: [snapshotOnlyItem],
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const baseInvoke = mockInvokeImpl;
    if (!baseInvoke) throw new Error("Expected the workbench invoke mock");
    let rejectArchive!: (reason?: unknown) => void;
    const archiveRequest = new Promise<unknown>((_resolve, reject) => {
      rejectArchive = reject;
    });
    setMockInvokeImpl(async (channel, ...args) => {
      if (channel === "codex:thread:archive") return await archiveRequest;
      return await baseInvoke(channel, ...args);
    });

    const row = getThreadRow(screen.container, "Archive failure");
    await act(async () => {
      fireEvent.click(within(row).getByRole("button", { name: "Archive chat" }));
      await Promise.resolve();
    });
    expect(
      screen.container.querySelector('[data-app-action-sidebar-thread-title="Archive failure"]'),
    ).toBe(null);

    await act(async () => {
      rejectArchive(new Error("archive failed"));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(getThreadRow(screen.container, "Archive failure")).not.toBeNull();
    expect(
      __getNodexToastSnapshotForTests().some(
        (toastItem) => toastItem.kind === "plain" && toastItem.title === "Failed to archive chat",
      ),
    ).toBe(true);
  });

  test("sidebar pin button promotes pinned sessions above unpinned siblings", async () => {
    const first = makeAttachedSession({
      id: "session:alpha:first",
      threadId: "thread-first-unpinned",
      title: "First unpinned",
      order: 1,
      rightCollapsed: true,
      tabs: [],
    });
    const second = makeAttachedSession({
      id: "session:alpha:second",
      threadId: "thread-second-target",
      title: "Second target",
      order: 2,
      rightCollapsed: true,
      tabs: [],
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeSession(), first, second] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const pinButton = getThreadRow(screen.container, "Second target").querySelector(
      "[data-app-action-sidebar-thread-pin-session]",
    );
    if (!(pinButton instanceof HTMLButtonElement)) {
      throw new Error("Expected Second target pin button");
    }

    await act(async () => {
      fireEvent.click(pinButton);
      await Promise.resolve();
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(JSON.stringify(getThreadRowTitles(screen.container).slice(0, 3))).toBe(
      JSON.stringify(["Database View", "Second target", "First unpinned"]),
    );
  });

  test("sidebar unpin button clears pinned state after refresh", async () => {
    const pinned = makeAttachedSession({
      id: "session:alpha:pinned",
      threadId: "thread-pinned-target",
      title: "Pinned target",
      order: 1,
      pinned: true,
      pinnedOrder: 1,
      rightCollapsed: true,
      tabs: [],
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeSession(), pinned] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const unpinButton = getThreadRow(screen.container, "Pinned target").querySelector(
      "[data-app-action-sidebar-thread-pin-session]",
    );
    if (!(unpinButton instanceof HTMLButtonElement)) {
      throw new Error("Expected Pinned target unpin button");
    }
    expect(unpinButton.getAttribute("aria-label")).toBe("Unpin chat");
    expect(unpinButton.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 24 24");

    await act(async () => {
      fireEvent.click(unpinButton);
      await Promise.resolve();
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "codex:threads:pinned:set" &&
          call[1] === "thread-pinned-target" &&
          (call[2] as { pinned?: boolean } | undefined)?.pinned === false,
      ),
    ).toBe(true);
    const row = getThreadRow(screen.container, "Pinned target");
    expect(row.getAttribute("data-app-action-sidebar-thread-pinned")).toBe("false");
    const pinButton = row.querySelector("[data-app-action-sidebar-thread-pin-session]");
    expect(pinButton?.getAttribute("aria-label")).toBe("Pin chat");
    expect(pinButton?.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 20 20");
  });

  test("sidebar pin slot treats Database View as ordinary, reserves unread rows, and protects long titles", async () => {
    const unread = makeAttachedSession({
      id: "session:alpha:unread",
      title: "Unread target",
      order: 1,
      unread: true,
      rightCollapsed: true,
      tabs: [],
    });
    const long = makeAttachedSession({
      id: "session:alpha:long",
      title: "Very long session title that should truncate before colliding with row actions",
      order: 2,
      rightCollapsed: true,
      tabs: [],
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeSession(), unread, long] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const databaseViewRow = getThreadRow(screen.container, "Database View");
    expect(
      databaseViewRow.querySelector("[data-app-action-sidebar-thread-pin-slot]") !== null,
    ).toBe(true);
    expect(
      databaseViewRow.querySelector("[data-app-action-sidebar-thread-pin-session]") !== null,
    ).toBe(true);
    expect(
      databaseViewRow
        .querySelector("[data-app-action-sidebar-thread-pin-session]")
        ?.getAttribute("aria-label"),
    ).toBe("Unpin chat");

    const unreadRow = getThreadRow(screen.container, "Unread target");
    expect(unreadRow.querySelector("[data-app-action-sidebar-thread-pin-slot]") !== null).toBe(
      true,
    );
    expect(unreadRow.querySelector("[data-app-action-sidebar-thread-pin-session]") === null).toBe(
      true,
    );

    const longRow = getThreadRow(
      screen.container,
      "Very long session title that should truncate before colliding with row actions",
    );
    expect(longRow.querySelector("[data-app-action-sidebar-thread-pin-slot]") !== null).toBe(true);
    expect(longRow.querySelector("[data-app-action-sidebar-thread-actions-menu]") === null).toBe(
      true,
    );
    expect(longRow.querySelector("[data-app-action-sidebar-thread-archive]") !== null).toBe(true);
    expect(longRow.querySelector("[data-thread-title]")?.textContent).toBe(
      "Very long session title that should truncate before colliding with row actions",
    );
  });

  test("sidebar title double-click ignores inactive rows and non-title targets", async () => {
    const target = makeAttachedSession({
      id: "session:alpha:rename-target",
      title: "Rename target",
      order: 1,
      rightCollapsed: true,
      tabs: [],
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeSession(), target] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const inactiveRow = getThreadRow(screen.container, "Rename target");
    const inactiveTitle = inactiveRow.querySelector("[data-thread-title]");
    if (!(inactiveTitle instanceof HTMLElement)) {
      throw new Error("Expected Rename target title");
    }

    await act(async () => {
      fireEvent.doubleClick(inactiveTitle);
      await Promise.resolve();
    });
    await settleAsyncRender();
    expect(screen.queryByLabelText("Chat title") === null).toBe(true);

    await act(async () => {
      fireEvent.click(inactiveRow);
      await Promise.resolve();
    });
    await settleAsyncRender();

    const activeRow = getThreadRow(screen.container, "Rename target");
    await act(async () => {
      fireEvent.doubleClick(activeRow);
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(screen.queryByLabelText("Chat title") === null).toBe(true);
  });

  test("active sidebar title double-click opens Rename chat and saves raw title", async () => {
    const target = makeAttachedSession({
      id: "session:alpha:rename-target",
      title: "Rename target",
      order: 1,
      rightCollapsed: true,
      tabs: [],
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeSession(), target] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const row = getThreadRow(screen.container, "Rename target");
    await act(async () => {
      fireEvent.click(row);
      await Promise.resolve();
    });
    await settleAsyncRender();

    const title = getThreadRow(screen.container, "Rename target").querySelector(
      "[data-thread-title]",
    );
    if (!(title instanceof HTMLElement)) {
      throw new Error("Expected Rename target title");
    }
    await act(async () => {
      fireEvent.doubleClick(title);
      await Promise.resolve();
    });
    await settleAsyncRender();

    const input = screen.getByLabelText("Chat title") as HTMLInputElement;
    expect(screen.getByText("Rename chat").textContent).toBe("Rename chat");
    expect(textContent(document.body).includes("Keep it short and recognizable")).toBe(true);
    expect(input.value).toBe("Rename target");

    await act(async () => {
      fireEvent.input(input, { target: { value: "  hello   world  " } });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await Promise.resolve();
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const renameCall = invokeCalls.find((call) => call[0] === "project-sessions:rename");
    expect(renameCall?.[1]).toBe("session:alpha:rename-target");
    expect((renameCall?.[2] as { title?: string } | undefined)?.title).toBe("  hello   world  ");
    expect(
      getThreadRow(screen.container, "hello world").getAttribute(
        "data-app-action-sidebar-thread-title",
      ),
    ).toBe("hello world");
  });

  test("clicking the Projects section header collapses and expands project rows", async () => {
    const restoreMatchMedia = installMotionEnabledMatchMediaForTest();
    try {
      const screen = renderWorkbench();
      await settleAsyncRender();
      await settleAsyncRender();

      const section = screen.container.querySelector(
        '[data-app-action-sidebar-section-heading="Projects"]',
      );
      if (!(section instanceof HTMLElement)) {
        throw new Error("Expected Projects section");
      }

      const toggle = section.querySelector("[data-app-action-sidebar-section-toggle]");
      if (!(toggle instanceof HTMLElement)) {
        throw new Error("Expected Projects section toggle");
      }

      expect(section.getAttribute("data-app-action-sidebar-section-collapsed")).toBe("false");
      expect(section.querySelectorAll("[data-app-action-sidebar-project-row]").length).toBe(1);
      expect(Boolean(section.querySelector("[data-app-action-sidebar-section-body-motion]"))).toBe(
        true,
      );

      await act(async () => {
        fireEvent.click(toggle);
        await Promise.resolve();
      });

      expect(section.getAttribute("data-app-action-sidebar-section-collapsed")).toBe("true");
      const exitingSectionBody = section.querySelector(
        "[data-app-action-sidebar-section-body-motion]",
      );
      expect(Boolean(exitingSectionBody)).toBe(true);
      expect(section.querySelectorAll("[data-app-action-sidebar-project-row]").length).toBe(1);
      expect(
        Boolean(
          section
            .querySelector("[data-app-action-sidebar-project-row]")
            ?.closest("[data-app-action-sidebar-section-body-motion]"),
        ),
      ).toBe(true);

      await act(async () => {
        fireEvent.click(toggle);
        await Promise.resolve();
      });

      expect(section.getAttribute("data-app-action-sidebar-section-collapsed")).toBe("false");
      expect(Boolean(section.querySelector("[data-app-action-sidebar-section-body-motion]"))).toBe(
        true,
      );
      expect(section.querySelectorAll("[data-app-action-sidebar-project-row]").length).toBe(1);
    } finally {
      restoreMatchMedia();
    }
  });

  test("sidebar organizer section collapse state survives sidebar hide and show", async () => {
    const restoreMatchMedia = installReducedMotionMatchMediaForTest();
    try {
      const projectlessSession = makeSession({
        id: "session:projectless:loose-chat",
        projectId: null,
        title: "Loose chat",
      });
      const screen = renderWorkbench({
        projectlessSessions: [projectlessSession],
        sidebar: { collapsed: false, width: 300 },
      });
      await settleAsyncRender();
      await settleAsyncRender();

      const projectsSection = getSidebarSection(screen.container, "Projects");
      const chatsSection = getSidebarSection(screen.container, "Chats");
      const projectsToggle = projectsSection.querySelector(
        "[data-app-action-sidebar-section-toggle]",
      );
      const chatsToggle = chatsSection.querySelector("[data-app-action-sidebar-section-toggle]");
      if (!(projectsToggle instanceof HTMLElement) || !(chatsToggle instanceof HTMLElement)) {
        throw new Error("Expected sidebar section toggles");
      }

      await act(async () => {
        fireEvent.click(projectsToggle);
        fireEvent.click(chatsToggle);
        await Promise.resolve();
      });
      await settleAsyncRender();

      expect(projectsSection.getAttribute("data-app-action-sidebar-section-collapsed")).toBe(
        "true",
      );
      expect(chatsSection.getAttribute("data-app-action-sidebar-section-collapsed")).toBe("true");

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
        await Promise.resolve();
      });
      await waitFor(() => {
        if (screen.container.querySelector('[data-testid="project-session-sidebar"]') !== null) {
          throw new Error("Expected project session sidebar to unmount after hide");
        }
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
        await Promise.resolve();
      });
      await settleAsyncRender();

      expect(
        getSidebarSection(screen.container, "Projects").getAttribute(
          "data-app-action-sidebar-section-collapsed",
        ),
      ).toBe("true");
      expect(
        getSidebarSection(screen.container, "Chats").getAttribute(
          "data-app-action-sidebar-section-collapsed",
        ),
      ).toBe("true");
    } finally {
      restoreMatchMedia();
    }
  });
});
