import "./workbench-testkit/workbench-shell-harness";
import { describe, test, expect } from "vite-plus/test";
import { settleAsyncRender, textContent } from "../../test/dom";
import { within, act, fireEvent, waitFor } from "@testing-library/react";
import { type CodexSidebarSyncResult, type CodexSidebarThreadItem } from "@/lib/types";
import {
  makeAttachedSession,
  makePanelLayout,
  makeProject,
  makeSession,
  makeSidebarSnapshotItemForSession,
} from "./workbench-testkit/workbench-shell-fixtures";
import {
  NEW_CHAT_ICON_PREFIX,
  codexHostMessageListener,
  getSidebarProjectGroup,
  getSidebarSection,
  getThreadRow,
  getThreadRowTitles,
  invokeCalls,
  openPanelMenu,
  renderWorkbench,
} from "./workbench-testkit/workbench-shell-harness";

async function ensureProjectRowExpanded(
  container: HTMLElement,
  projectId = "alpha",
): Promise<HTMLElement> {
  const row = container.querySelector(`[data-app-action-sidebar-project-id="${projectId}"]`);
  if (!(row instanceof HTMLElement)) {
    throw new Error(`Expected ${projectId} project row`);
  }
  const disclosure = within(row).queryByRole("button", {
    name: "Expand project",
  });
  if (!disclosure) return row;
  await act(async () => {
    fireEvent.click(disclosure);
    await Promise.resolve();
  });
  await settleAsyncRender();
  return row;
}

describe("workbench session shell / sidebar-projects", () => {
  test("Projects header actions mirror Codex controls and reopen previous project folders", async () => {
    const screen = renderWorkbench({
      projects: [makeProject(), makeProject("beta", "Beta")],
      initialSelectedSessionId: null,
      sessionsByProject: {
        alpha: [makeSession()],
        beta: [
          makeSession({
            id: "session:beta:database-view",
            projectId: "beta",
            title: "Beta Database",
          }),
        ],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const section = getSidebarSection(screen.container, "Projects");
    const options = within(section).getByRole("button", { name: "Project sidebar options" });
    const addNewProject = within(section).getByRole("button", { name: "Add new project" });
    const alphaRow = section.querySelector('[data-app-action-sidebar-project-id="alpha"]');
    const betaRow = section.querySelector('[data-app-action-sidebar-project-id="beta"]');

    if (!(alphaRow instanceof HTMLElement) || !(betaRow instanceof HTMLElement)) {
      throw new Error("Expected Alpha and Beta project rows");
    }

    expect(options.getAttribute("aria-disabled")).toBe(null);
    expect(addNewProject.getAttribute("aria-label")).toBe("Add new project");
    expect(
      within(alphaRow).getByRole("button", { name: "Open Alpha" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(alphaRow)
        .getByRole("button", { name: "Collapse project" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      within(betaRow).getByRole("button", { name: "Expand project" }).getAttribute("aria-expanded"),
    ).toBe("false");
    expect(within(section).queryByRole("button", { name: "Collapse all" }) === null).toBe(true);

    await ensureProjectRowExpanded(screen.container, "alpha");
    await ensureProjectRowExpanded(screen.container, "beta");

    expect(
      within(betaRow)
        .getByRole("button", { name: "Collapse project" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    const collapseAll = within(section).getByRole("button", { name: "Collapse all" });

    await act(async () => {
      fireEvent.click(collapseAll);
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(
      within(alphaRow)
        .getByRole("button", { name: "Expand project" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      within(betaRow).getByRole("button", { name: "Expand project" }).getAttribute("aria-expanded"),
    ).toBe("false");
    const reopenPrevious = within(section).getByRole("button", { name: "Reopen previous" });
    expect(reopenPrevious.getAttribute("data-app-action-sidebar-projects-collapse-action")).toBe(
      "reopen-previous",
    );

    await act(async () => {
      fireEvent.click(reopenPrevious);
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(
      within(alphaRow)
        .getByRole("button", { name: "Collapse project" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      within(betaRow)
        .getByRole("button", { name: "Collapse project" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      within(section)
        .getByRole("button", { name: "Collapse all" })
        .getAttribute("data-app-action-sidebar-projects-collapse-action"),
    ).toBe("collapse-all");
  });

  test("project navigation does not toggle its independent chat disclosure", async () => {
    const activeThread = makeAttachedSession({
      id: "session:alpha:thread",
      title: "Active thread",
      order: 1,
      rightCollapsed: true,
      rightLayout: makePanelLayout([], null),
      tabs: [],
    });
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [makeSession(), activeThread],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await ensureProjectRowExpanded(screen.container);

    await act(async () => {
      fireEvent.click(screen.getByText("Active thread"));
      await Promise.resolve();
    });
    await settleAsyncRender();

    const projectRow = screen.container.querySelector(
      '[data-app-action-sidebar-project-id="alpha"]',
    );
    if (!(projectRow instanceof HTMLElement)) {
      throw new Error("Expected active project row");
    }
    expect(projectRow.getAttribute("data-active")).toBe(null);
    expect(
      getThreadRow(screen.container, "Active thread").getAttribute(
        "data-app-action-sidebar-thread-active",
      ),
    ).toBe("true");
    await act(async () => {
      fireEvent.click(within(projectRow).getByRole("button", { name: "Open Alpha" }));
      await Promise.resolve();
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(projectRow.getAttribute("data-app-action-sidebar-project-collapsed")).toBe("false");
    expect(screen.queryByTestId("project-database-surface") !== null).toBe(true);
    const exitingThreadRow = screen.container.querySelector(
      '[data-app-action-sidebar-thread-title="Active thread"]',
    );
    expect(
      Boolean(exitingThreadRow?.closest("[data-app-action-sidebar-project-list-motion]")),
    ).toBe(true);
  });

  test("top new-chat row ensures the Project's default draft Session", async () => {
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [] },
      initialSelectedSessionId: null,
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New chat" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    const props = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(
      invokeCalls.some(
        (call) => call[0] === "project-sessions:ensure-default-draft" && call[1] === "alpha",
      ),
    ).toBe(true);
    expect(props?.isNewThreadTab).toBe(true);
    expect(props?.newThreadTarget).toMatchObject({
      projectId: "alpha",
      sessionId: "session:alpha:created",
    });
    expect(screen.getByLabelText("Prompt").getAttribute("placeholder")).toBe(
      "Write the first prompt for this new thread...",
    );
    expect(screen.queryByTestId("session-right-panel")).toBe(null);
  });

  test("Project Scene keeps a fixed Database root without creating a Session", async () => {
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const projectRow = await ensureProjectRowExpanded(screen.container);
    const projectsSection = getSidebarSection(screen.container, "Projects");
    const projectGroup = getSidebarProjectGroup(projectsSection, "alpha");
    expect(within(projectRow).queryByText("Loading chats...")).toBe(null);
    expect(within(projectGroup).getByText("No chats inside") !== null).toBe(true);

    expect(screen.queryByTestId("project-database-surface") !== null).toBe(true);
    expect(
      screen
        .getByTestId("project-database-surface")
        .getAttribute("data-app-shell-main-content-layout"),
    ).toBe("default");
    const projectHomeTab = screen.getByRole("tab", { name: "Project Home" });
    expect(projectHomeTab.querySelector('[data-project-home-tab-marker="true"]')).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Close Project Home tab" })).toBeNull();
    expect(screen.queryByTestId("project-scene-header")).toBeNull();
    expect(invokeCalls.some((call) => call[0] === "project-sessions:create")).toBe(false);
    expect(
      screen.container.querySelector('[data-app-action-sidebar-thread-title="Database View"]'),
    ).toBe(null);

    const panelMenu = await openPanelMenu(screen, "Open side panel tab");
    expect(within(panelMenu).queryByText("Review")).toBeNull();
    expect(within(panelMenu).queryByText("Side chat")).toBeNull();
    expect(within(panelMenu).getByText("Browser")).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Canvas" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByTestId("workbench-canvas-stage-panel") !== null).toBe(true);
    });
    expect(invokeCalls.some((call) => call[0] === "project-sessions:create")).toBe(false);

    expect(invokeCalls.filter((call) => call[0] === "project-sessions:create")).toHaveLength(0);
    expect(screen.queryByTestId("project-right-panel") !== null).toBe(true);

    expect(screen.queryByTestId("project-database-surface") !== null).toBe(true);
    expect(invokeCalls.some((call) => call[0] === "project-sessions:archive")).toBe(false);
  });

  test("empty Project bottom panel opens a Project-scoped Terminal", async () => {
    const screen = renderWorkbench({
      projects: [makeProject("alpha", "Alpha", "/Users/asc/repo/nodex")],
      sessionsByProject: { alpha: [] },
      initialSelectedSessionId: null,
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Toggle bottom panel" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(screen.queryByTestId("project-bottom-panel") !== null).toBe(true);
    expect(screen.getByRole("tab", { name: "Terminal", selected: true }) !== null).toBe(true);
    expect(invokeCalls.some((call) => call[0] === "project-sessions:create")).toBe(false);
  });

  test("Project Home opens Database Pages in an adjacent right tab group", async () => {
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const props = (
      globalThis as {
        __lastDatabaseViewSurfaceProps?: Record<string, unknown>;
      }
    ).__lastDatabaseViewSurfaceProps;
    if (typeof props?.onOpenPage !== "function") {
      throw new Error("Expected Project Home Database Page opener");
    }
    await act(async () => {
      await (
        props.onOpenPage as (
          pageId: string,
          title?: string,
          openMode?: "preview" | "durable",
        ) => Promise<void> | void
      )("card-1", "Card One", "preview");
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const projectHomeTab = screen.getByRole("tab", { name: "Project Home" });
    const pageTab = screen.getByRole("tab", { name: "Card One" });
    expect(pageTab.closest('[data-app-shell-tab-preview="true"]')).not.toBeNull();
    const projectHomeRow = projectHomeTab.closest("[data-panel-tab-row]");
    const pageRow = pageTab.closest("[data-panel-tab-row]");
    expect(projectHomeRow).not.toBeNull();
    expect(pageRow).not.toBeNull();
    expect(pageRow?.getAttribute("data-panel-tab-row")).not.toBe(
      projectHomeRow?.getAttribute("data-panel-tab-row"),
    );
    const nextProps = (
      globalThis as {
        __lastDatabaseViewSurfaceProps?: Record<string, unknown>;
      }
    ).__lastDatabaseViewSurfaceProps;
    const presentedPageIds = nextProps?.presentedPageIds as ReadonlySet<string> | undefined;
    expect(presentedPageIds?.has("card-1")).toBe(true);
    expect(invokeCalls.some((call) => call[0] === "project-sessions:create")).toBe(false);

    await act(async () => {
      fireEvent.doubleClick(pageTab);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        screen
          .getByRole("tab", { name: "Card One" })
          .closest('[data-app-shell-tab-preview="true"]'),
      ).toBeNull();
    });
  });

  test("Project Scene tab chrome follows the live Page resource title", async () => {
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const hostProps = (
      globalThis as {
        __lastDatabaseViewSurfaceProps?: Record<string, unknown>;
      }
    ).__lastDatabaseViewSurfaceProps;
    if (typeof hostProps?.onOpenPage !== "function") {
      throw new Error("Expected Project Home Database Page opener");
    }
    await act(async () => {
      await (
        hostProps.onOpenPage as (
          pageId: string,
          title?: string,
          openMode?: "preview" | "durable",
        ) => Promise<void> | void
      )("card-1", "Card One", "preview");
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const pageStageProps = (
      globalThis as {
        __mockPageStagePropsByPageId?: Record<string, Record<string, unknown>>;
      }
    ).__mockPageStagePropsByPageId?.["card-1"];
    const publishTitle = pageStageProps?.__publishPageTitle as
      | ((title: string) => void)
      | undefined;
    if (!publishTitle) throw new Error("Expected live Page title publisher");

    await act(async () => {
      publishTitle("Renamed Page");
      await Promise.resolve();
    });

    expect(screen.queryByRole("tab", { name: "Card One" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Renamed Page" })).not.toBeNull();
  });

  test("Project Scene presents non-root Database surfaces as standard DB View tabs", async () => {
    const screen = renderWorkbench({
      projects: [makeProject(), makeProject("beta", "Beta")],
      sessionsByProject: { alpha: [], beta: [] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const menu = await openPanelMenu(screen, "Open side panel tab");
    const dbViewItem = within(menu).getByText("DB View").closest('[role="menuitem"]');
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
      expect(screen.getByRole("option", { name: /Board.*Beta/ }) !== null).toBe(true);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /Board.*Beta/ }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(screen.getByRole("tab", { name: "Project Home" }) !== null).toBe(true);
    expect(screen.getByRole("tab", { name: "DB View", selected: true }) !== null).toBe(true);
    expect(screen.queryByRole("tab", { name: "Database" })).toBeNull();
  });

  test("Chats section ensures a projectless default-draft composer", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();
    await settleAsyncRender();

    await ensureProjectRowExpanded(screen.container);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New projectless chat" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    const props = (
      globalThis as {
        __lastConnectedThreadStageProps?: Record<string, unknown>;
      }
    ).__lastConnectedThreadStageProps;
    expect(
      invokeCalls.some(
        (call) => call[0] === "project-sessions:ensure-default-draft" && call[1] === null,
      ),
    ).toBe(true);
    expect(props?.isNewThreadTab).toBe(true);
    expect(props?.newThreadTarget).toMatchObject({
      projectId: null,
      projectName: "No project",
      sessionId: "session:projectless:created",
      runInTarget: "localProject",
    });
    expect(props?.newThreadProjectSelector).toMatchObject({
      selectedProjectId: null,
    });
  });

  test("keeps projectless subagent sessions out of Chats", async () => {
    const root = makeAttachedSession({
      id: "session:projectless:root",
      projectId: null,
      threadId: "thread:projectless:root",
      title: "Root chat",
    });
    const childFixture = makeAttachedSession({
      id: "session:projectless:child",
      projectId: null,
      threadId: "thread:projectless:child",
      title: "Subagent chat",
    });
    if (!childFixture.thread) throw new Error("Expected child thread fixture");
    const child = {
      ...childFixture,
      thread: {
        ...childFixture.thread,
        parentThreadId: "thread:projectless:root",
      },
    };
    const screen = renderWorkbench({
      projectlessSessions: [root, child],
      sidebarSnapshotItems: [root, child].map(makeSidebarSnapshotItemForSession),
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const chatsSection = getSidebarSection(screen.container, "Chats");
    expect(getThreadRowTitles(chatsSection)).toEqual(["Root chat"]);
    expect(
      chatsSection.querySelector('[data-app-action-sidebar-thread-title="Subagent chat"]'),
    ).toBeNull();
  });

  test("new project chats render above older project chats", async () => {
    const olderThread = makeAttachedSession({
      id: "session:alpha:older",
      title: "Older chat",
      order: 1,
      rightCollapsed: true,
      rightLayout: makePanelLayout([], null),
      tabs: [],
    });
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [
          makeAttachedSession({
            id: "session:alpha:database-view",
            threadId: "thread-alpha-database-view",
            title: "Database View",
            pinned: true,
            pinnedOrder: 0,
          }),
          olderThread,
        ],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await ensureProjectRowExpanded(screen.container);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New chat" }));
      await Promise.resolve();
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await ensureProjectRowExpanded(screen.container);

    const rowTitles = Array.from(
      screen.container.querySelectorAll<HTMLElement>("[data-app-action-sidebar-thread-title]"),
    ).map((row) => row.getAttribute("data-app-action-sidebar-thread-title") ?? "");
    const overviewIndex = rowTitles.indexOf("Database View");
    const newThreadIndex = rowTitles.indexOf("New chat");
    const olderThreadIndex = rowTitles.indexOf("Older chat");

    expect(overviewIndex >= 0).toBe(true);
    expect(newThreadIndex >= 0).toBe(true);
    expect(olderThreadIndex >= 0).toBe(true);
    expect(overviewIndex < newThreadIndex).toBe(true);
    expect(newThreadIndex < olderThreadIndex).toBe(true);
  });

  test("new blank project chats render above snapshot-backed older chats", async () => {
    const olderThreadBase = makeAttachedSession({
      id: "session:alpha:snapshot-older",
      threadId: "thread-snapshot-older",
      title: "Older snapshot chat",
      order: 1,
      rightCollapsed: true,
      rightLayout: makePanelLayout([], null),
      tabs: [],
    });
    if (!olderThreadBase.thread) throw new Error("Expected older thread");
    const olderThread = {
      ...olderThreadBase,
      thread: {
        ...olderThreadBase.thread,
        threadName: "Older snapshot chat",
        threadPreview: "Older snapshot chat",
        createdAt: 100,
        updatedAt: 100,
      },
    };
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [
          makeAttachedSession({
            id: "session:alpha:database-view",
            threadId: "thread-alpha-database-view",
            title: "Database View",
            pinned: true,
            pinnedOrder: 0,
          }),
          olderThread,
        ],
      },
      sidebarSnapshotItems: [makeSidebarSnapshotItemForSession(olderThread)],
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await ensureProjectRowExpanded(screen.container);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New chat" }));
      await Promise.resolve();
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const rowTitles = getThreadRowTitles(screen.container);
    const databaseViewIndex = rowTitles.indexOf("Database View");
    const newThreadIndex = rowTitles.indexOf("New chat");
    const olderThreadIndex = rowTitles.indexOf("Older snapshot chat");

    expect(databaseViewIndex >= 0).toBe(true);
    expect(newThreadIndex >= 0).toBe(true);
    expect(olderThreadIndex >= 0).toBe(true);
    expect(databaseViewIndex < newThreadIndex).toBe(true);
    expect(newThreadIndex < olderThreadIndex).toBe(true);
  });

  test("project chat list follows Codex Show more and Show less paging", async () => {
    const projectChats = Array.from({ length: 16 }, (_, index) =>
      makeAttachedSession({
        id: `session:alpha:paged-${index + 1}`,
        threadId: `thread-paged-${index + 1}`,
        title: `Paged chat ${index + 1}`,
        order: index + 1,
        pinned: false,
        pinnedOrder: null,
        rightCollapsed: true,
        rightLayout: makePanelLayout([], null),
        tabs: [],
      }),
    );
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: projectChats,
      },
      initialSelectedSessionId: null,
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await ensureProjectRowExpanded(screen.container);
    const projectGroup = getSidebarProjectGroup(
      getSidebarSection(screen.container, "Projects"),
      "alpha",
    );

    expect(
      screen.container.querySelector('[data-app-action-sidebar-thread-title="Paged chat 5"]') !==
        null,
    ).toBe(true);
    expect(
      screen.container.querySelector('[data-app-action-sidebar-thread-title="Paged chat 6"]'),
    ).toBe(null);

    await act(async () => {
      fireEvent.click(within(projectGroup).getByRole("button", { name: "Show more" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(
      screen.container.querySelector('[data-app-action-sidebar-thread-title="Paged chat 15"]') !==
        null,
    ).toBe(true);
    expect(
      screen.container.querySelector('[data-app-action-sidebar-thread-title="Paged chat 16"]'),
    ).toBe(null);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show less" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(
      screen.container.querySelector('[data-app-action-sidebar-thread-title="Paged chat 5"]') !==
        null,
    ).toBe(true);
    expect(
      screen.container.querySelector('[data-app-action-sidebar-thread-title="Paged chat 6"]'),
    ).toBe(null);
  });

  test("projectless Chats starts at fifty rows and expands through the pager", async () => {
    const projectlessChats = Array.from({ length: 52 }, (_, index) =>
      makeAttachedSession({
        id: `session:projectless:paged-${index + 1}`,
        projectId: null,
        threadId: `thread-projectless-paged-${index + 1}`,
        title: `Projectless chat ${index + 1}`,
        order: index + 1,
        pinned: false,
        pinnedOrder: null,
        rightCollapsed: true,
        rightLayout: makePanelLayout([], null),
        tabs: [],
      }),
    );
    const screen = renderWorkbench({ projectlessSessions: projectlessChats });
    await settleAsyncRender();
    await settleAsyncRender();

    const chatsSection = getSidebarSection(screen.container, "Chats");
    expect(chatsSection.querySelectorAll("[data-app-action-sidebar-thread-row]").length).toBe(50);
    expect(
      chatsSection.querySelector('[data-app-action-sidebar-thread-title="Projectless chat 50"]') !==
        null,
    ).toBe(true);
    expect(
      chatsSection.querySelector('[data-app-action-sidebar-thread-title="Projectless chat 51"]'),
    ).toBe(null);

    await act(async () => {
      fireEvent.click(within(chatsSection).getByRole("button", { name: "Show more" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(chatsSection.querySelectorAll("[data-app-action-sidebar-thread-row]").length).toBe(52);
    expect(
      chatsSection.querySelector('[data-app-action-sidebar-thread-title="Projectless chat 51"]') !==
        null,
    ).toBe(true);
    expect(within(chatsSection).queryByRole("button", { name: "Show more" })).toBe(null);
    expect(within(chatsSection).queryByRole("button", { name: "Show less" }) !== null).toBe(true);
  });

  test("Cmd+N ensures a project-scoped default Session", async () => {
    renderWorkbench({
      sessionsByProject: { alpha: [] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.keyDown(document, { key: "n", metaKey: true, ctrlKey: true });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(
      invokeCalls.some(
        (call) => call[0] === "project-sessions:ensure-default-draft" && call[1] === "alpha",
      ),
    ).toBe(true);
    const props = (
      globalThis as {
        __lastConnectedThreadStageProps?: Record<string, unknown>;
      }
    ).__lastConnectedThreadStageProps;
    expect(props?.newThreadTarget).toMatchObject({
      projectId: "alpha",
      sessionId: "session:alpha:created",
    });
  });

  test("project row new-chat button opens a project composer without prompting or toggling", async () => {
    const promptCalls: string[] = [];
    const originalPrompt = window.prompt;
    window.prompt = ((message?: string) => {
      promptCalls.push(String(message ?? ""));
      return "Should not be used";
    }) as typeof window.prompt;

    try {
      const screen = renderWorkbench({
        projects: [makeProject(), makeProject("beta", "Beta")],
        sessionsByProject: {
          alpha: [makeSession()],
          beta: [
            makeSession({
              id: "session:beta:database-view",
              projectId: "beta",
              title: "Database View",
            }),
          ],
        },
      });
      await settleAsyncRender();
      await settleAsyncRender();

      const betaAction = screen.getByLabelText("Start new chat in Beta");
      const iconPath = betaAction.querySelector("path")?.getAttribute("d") ?? "";
      expect(iconPath.startsWith(NEW_CHAT_ICON_PREFIX)).toBe(true);

      await act(async () => {
        fireEvent.click(betaAction);
        await Promise.resolve();
      });
      await settleAsyncRender();

      expect(promptCalls.length).toBe(0);
      expect(
        invokeCalls.some(
          (call) => call[0] === "project-sessions:ensure-default-draft" && call[1] === "beta",
        ),
      ).toBe(true);
      await waitFor(() => {
        const latestProps = (
          globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> }
        ).__lastConnectedThreadStageProps;
        expect(latestProps?.newThreadTarget).toMatchObject({
          projectId: "beta",
          sessionId: "session:beta:created",
        });
      });
    } finally {
      window.prompt = originalPrompt;
    }
  });

  test("sidebar sync does not hydrate an inactive collapsed Project lane", async () => {
    const sidebarSyncResult: CodexSidebarSyncResult = {
      snapshot: {
        items: [],
        pinnedThreadIds: [],
        projectAssignments: {},
        projectlessThreadIds: [],
        generatedAt: 2,
      },
      source: "app-server",
      refreshed: true,
      refreshedAt: 2,
      changedProjectIds: ["beta"],
      projectlessChanged: false,
      materializedSessionIds: [],
      failedThreadIds: [],
    };
    renderWorkbench({
      projects: [makeProject(), makeProject("beta", "Beta")],
      sessionsByProject: {
        alpha: [makeSession()],
        beta: [
          makeSession({
            id: "session:beta:database-view",
            projectId: "beta",
            title: "Beta Database View",
          }),
        ],
      },
    });
    await settleAsyncRender();

    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "codex:sidebar:sync" &&
          JSON.stringify(call[1]) === JSON.stringify({ policy: "force", reason: "mount" }),
      ),
    ).toBe(false);

    await waitFor(() => {
      if (codexHostMessageListener === null) {
        throw new Error("missing host message listener");
      }
    });
    const betaFullRefreshCountBefore = invokeCalls.filter(
      (call) => call[0] === "project-sessions:list" && call[1] === "beta",
    ).length;
    const betaSummaryRefreshCountBefore = invokeCalls.filter(
      (call) => call[0] === "workspace:tasks:list" && call[1] === "beta",
    ).length;
    await act(async () => {
      codexHostMessageListener?.({
        type: "sidebarSyncUpdated",
        hostId: "local",
        result: sidebarSyncResult,
        reason: "host-message",
      });
      await Promise.resolve();
    });
    await settleAsyncRender();

    await waitFor(() => {
      const betaSummaryRefreshCount = invokeCalls.filter(
        (call) => call[0] === "workspace:tasks:list" && call[1] === "beta",
      ).length;
      expect(betaSummaryRefreshCount).toBe(betaSummaryRefreshCountBefore);
      const betaFullRefreshCountAfter = invokeCalls.filter(
        (call) => call[0] === "project-sessions:list" && call[1] === "beta",
      ).length;
      expect(betaFullRefreshCountAfter).toBe(betaFullRefreshCountBefore);
    });
  });

  test("project action menu opens without selecting the project row", async () => {
    const beta = makeProject("beta", "Beta");
    const screen = renderWorkbench({
      projects: [makeProject(), beta],
      sessionsByProject: {
        alpha: [makeSession()],
        beta: [
          makeSession({
            id: "session:beta:database-view",
            projectId: "beta",
            title: "Beta Database View",
          }),
        ],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      const trigger = screen.getByLabelText("Project actions for Beta");
      fireEvent.pointerDown(trigger, {
        button: 0,
        ctrlKey: false,
      });
      fireEvent.mouseDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await Promise.resolve();
    });

    expect(textContent(document.body).includes("Edit project")).toBe(true);
    expect(textContent(document.body).includes("Archive chats")).toBe(true);
    expect(textContent(document.body).includes("Add source folder")).toBe(false);
    expect(textContent(document.body).includes("Edit sources")).toBe(false);
  });

  test("pinned project groups render above normal projects and are excluded from Projects", async () => {
    const beta = {
      ...makeProject("beta", "Beta"),
      pinned: true,
      pinnedOrder: 0,
    };
    const screen = renderWorkbench({
      projects: [makeProject(), beta, makeProject("gamma", "Gamma")],
      sessionsByProject: {
        alpha: [makeSession()],
        beta: [
          makeSession({
            id: "session:beta:database-view",
            projectId: "beta",
            title: "Beta Database View",
          }),
        ],
        gamma: [
          makeSession({
            id: "session:gamma:database-view",
            projectId: "gamma",
            title: "Gamma Database View",
          }),
        ],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const pinnedSections = Array.from(
      screen.container.querySelectorAll('[data-app-action-sidebar-section-heading="Pinned"]'),
    );
    const projectsSection = screen.container.querySelector(
      '[data-app-action-sidebar-section-heading="Projects"]',
    );
    expect(pinnedSections.length).toBe(1);
    expect(
      pinnedSections[0]?.querySelector('[data-app-action-sidebar-project-id="beta"]') !== null,
    ).toBe(true);
    expect(
      projectsSection?.querySelector('[data-app-action-sidebar-project-id="beta"]') === null,
    ).toBe(true);
    expect(
      projectsSection?.querySelector('[data-app-action-sidebar-project-id="alpha"]') !== null,
    ).toBe(true);
    expect(
      projectsSection?.querySelector('[data-app-action-sidebar-project-id="gamma"]') !== null,
    ).toBe(true);
  });

  test("keeps individually pinned chats at the top of their project subtree", async () => {
    const pinnedAlpha = makeAttachedSession({
      id: "session:alpha:pinned",
      threadId: "thread-alpha-pinned",
      title: "Pinned Alpha",
      pinned: true,
      pinnedOrder: 0,
      order: 1,
    });
    const normalAlpha = makeAttachedSession({
      id: "session:alpha:normal",
      threadId: "thread-alpha-normal",
      title: "Normal Alpha",
      pinned: false,
      pinnedOrder: null,
      order: 2,
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [pinnedAlpha, normalAlpha] },
      sidebarSnapshotItems: [
        makeSidebarSnapshotItemForSession(pinnedAlpha),
        makeSidebarSnapshotItemForSession(normalAlpha),
      ],
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const projectsSection = getSidebarSection(screen.container, "Projects");
    const alphaGroup = getSidebarProjectGroup(projectsSection, "alpha");

    expect(
      screen.container.querySelector('[data-app-action-sidebar-section-heading="Pinned"]'),
    ).toBe(null);
    expect(JSON.stringify(getThreadRowTitles(alphaGroup))).toBe(
      JSON.stringify(["Pinned Alpha", "Normal Alpha"]),
    );
  });

  test("keeps projectless pinned chats in the Pinned section", async () => {
    const projectlessPinnedItem: CodexSidebarThreadItem = {
      key: "local:thread-projectless-pinned",
      kind: "local",
      runLocation: { kind: "local-checkout" },
      hostId: "local",
      threadId: "thread-projectless-pinned",
      parentThreadId: null,
      sessionId: null,
      projectId: null,
      title: "Pinned Projectless",
      preview: "",
      cwd: null,
      updatedAt: 10,
      createdAt: 1,
      pinned: true,
      pinnedOrder: 0,
      unread: false,
      archived: false,
      statusType: "idle",
      statusActiveFlags: [],
      projectless: true,
      disabled: false,
    };
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeSession()] },
      sidebarSnapshotItems: [projectlessPinnedItem],
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const pinnedSection = getSidebarSection(screen.container, "Pinned");
    expect(
      pinnedSection.querySelector('[data-app-action-sidebar-thread-title="Pinned Projectless"]') !==
        null,
    ).toBe(true);
  });

  test("renders Chats in canonical TaskWindow order", async () => {
    const chatA = makeAttachedSession({
      id: "session:chat:a",
      projectId: null,
      threadId: "thread-chat-a",
      title: "Chat A",
      order: 0,
    });
    const chatNew = makeAttachedSession({
      id: "session:chat:new",
      projectId: null,
      threadId: "thread-chat-new",
      title: "Chat New",
      order: 1,
    });
    const chatB = makeAttachedSession({
      id: "session:chat:b",
      projectId: null,
      threadId: "thread-chat-b",
      title: "Chat B",
      order: 2,
    });
    if (!chatA.thread || !chatNew.thread || !chatB.thread) {
      throw new Error("Expected attached projectless sessions");
    }
    chatA.thread.updatedAt = 300;
    chatNew.thread.updatedAt = 200;
    chatB.thread.updatedAt = 100;
    const projectlessSessions = [chatB, chatNew, chatA];
    const screen = renderWorkbench({
      projectlessSessions,
      sidebarSnapshotItems: projectlessSessions.map(makeSidebarSnapshotItemForSession),
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const chatsSection = getSidebarSection(screen.container, "Chats");
    expect(JSON.stringify(getThreadRowTitles(chatsSection))).toBe(
      JSON.stringify(["Chat B", "Chat New", "Chat A"]),
    );
  });

  test("keeps a pre-thread New Chat in its canonical Session position", async () => {
    const chatA = makeAttachedSession({
      id: "session:alpha:a",
      threadId: "thread-alpha-a",
      title: "Alpha A",
    });
    const draft = makeSession({
      id: "session:alpha:draft",
      projectId: "alpha",
      noThreadFallbackTitle: "New chat",
      displayTitle: "New chat",
      thread: null,
    });
    const chatB = makeAttachedSession({
      id: "session:alpha:b",
      threadId: "thread-alpha-b",
      title: "Alpha B",
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [chatA, draft, chatB] },
      sidebarSnapshotItems: [chatA, chatB].map(makeSidebarSnapshotItemForSession),
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const projectsSection = getSidebarSection(screen.container, "Projects");
    expect(getThreadRowTitles(projectsSection)).toEqual(["Alpha A", "New chat", "Alpha B"]);
  });

  test("keeps canonical project TaskWindow order stable across session selection", async () => {
    const pinned = makeAttachedSession({
      id: "session:alpha:pinned",
      threadId: "thread-alpha-pinned",
      title: "Pinned Alpha",
      pinned: true,
      pinnedOrder: 0,
    });
    const chatA = makeAttachedSession({
      id: "session:alpha:a",
      threadId: "thread-alpha-a",
      title: "Alpha A",
      order: 0,
    });
    const chatNew = makeAttachedSession({
      id: "session:alpha:new",
      threadId: "thread-alpha-new",
      title: "Alpha New",
      order: 1,
    });
    const chatB = makeAttachedSession({
      id: "session:alpha:b",
      threadId: "thread-alpha-b",
      title: "Alpha B",
      order: 2,
    });
    if (!pinned.thread || !chatA.thread || !chatNew.thread || !chatB.thread) {
      throw new Error("Expected attached project sessions");
    }
    pinned.thread.updatedAt = 400;
    chatA.thread.updatedAt = 300;
    chatNew.thread.updatedAt = 200;
    chatB.thread.updatedAt = 100;
    const sessions = [pinned, chatB, chatNew, chatA];
    const screen = renderWorkbench({
      sessionsByProject: { alpha: sessions },
      sidebarSnapshotItems: sessions.map(makeSidebarSnapshotItemForSession),
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const alphaGroup = getSidebarProjectGroup(
      getSidebarSection(screen.container, "Projects"),
      "alpha",
    );
    expect(JSON.stringify(getThreadRowTitles(alphaGroup))).toBe(
      JSON.stringify(["Pinned Alpha", "Alpha B", "Alpha New", "Alpha A"]),
    );

    await act(async () => {
      fireEvent.click(getThreadRow(alphaGroup, "Alpha A"));
      await Promise.resolve();
    });

    expect(JSON.stringify(getThreadRowTitles(alphaGroup))).toBe(
      JSON.stringify(["Pinned Alpha", "Alpha B", "Alpha New", "Alpha A"]),
    );
  });

  test("keeps an individually pinned chat inside its pinned project group", async () => {
    const beta = {
      ...makeProject("beta", "Beta"),
      pinned: true,
      pinnedOrder: 0,
    };
    const pinnedBeta = makeAttachedSession({
      id: "session:beta:pinned",
      projectId: "beta",
      threadId: "thread-beta-pinned",
      title: "Pinned Beta",
      pinned: true,
      pinnedOrder: 0,
      order: 1,
    });
    const normalBeta = makeAttachedSession({
      id: "session:beta:normal",
      projectId: "beta",
      threadId: "thread-beta-normal",
      title: "Normal Beta",
      pinned: false,
      pinnedOrder: null,
      order: 2,
    });
    const pendingBeta: CodexSidebarThreadItem = {
      key: "local:client-new-thread:beta-pending",
      kind: "pending-worktree",
      runLocation: { kind: "local-worktree", path: null, phase: "pending" },
      pendingWorktreeId: "pending-worktree:beta-pending",
      clientThreadId: "client-new-thread:beta-pending",
      pinnedBeforeThreadId: null,
      hostId: "local",
      threadId: "client-new-thread:beta-pending",
      parentThreadId: null,
      sessionId: null,
      projectId: "beta",
      title: "Pending Beta",
      preview: "",
      cwd: "/repo/beta",
      updatedAt: 3,
      createdAt: 3,
      pinned: false,
      pinnedOrder: null,
      unread: false,
      archived: false,
      statusType: "active",
      statusActiveFlags: [],
      projectless: false,
      disabled: false,
    };
    const screen = renderWorkbench({
      projects: [beta, makeProject()],
      sessionsByProject: {
        beta: [pinnedBeta, normalBeta],
        alpha: [makeSession()],
      },
      sidebarSnapshotItems: [
        makeSidebarSnapshotItemForSession(pinnedBeta),
        makeSidebarSnapshotItemForSession(normalBeta),
        pendingBeta,
      ],
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const pinnedSection = getSidebarSection(screen.container, "Pinned");
    const betaGroup = getSidebarProjectGroup(pinnedSection, "beta");
    const normalTitle = betaGroup.querySelector(
      '[data-app-action-sidebar-thread-title="Normal Beta"]',
    );
    const pendingTitle = betaGroup.querySelector(
      '[data-app-action-sidebar-thread-title="Pending Beta"]',
    );
    const normalSortableActivator = normalTitle?.closest('[aria-roledescription="sortable"]');
    const pendingSortableActivator = pendingTitle?.closest('[aria-roledescription="sortable"]');

    expect(JSON.stringify(getThreadRowTitles(betaGroup))).toBe(
      JSON.stringify(["Pinned Beta", "Normal Beta", "Pending Beta"]),
    );
    expect(normalSortableActivator !== null).toBe(true);
    expect(pendingSortableActivator == null).toBe(true);
  });

  test("projects options menu does not expose the non-reference Organize pins mode", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();
    await settleAsyncRender();

    expect(screen.queryByLabelText("Pinned section actions")).toBe(null);

    const projectsSection = getSidebarSection(screen.container, "Projects");
    expect(within(projectsSection).queryByLabelText("New section")).toBe(null);

    await act(async () => {
      const trigger = within(projectsSection).getByLabelText("Project sidebar options");
      fireEvent.pointerDown(trigger, {
        button: 0,
        ctrlKey: false,
      });
      fireEvent.mouseDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(textContent(document.body).includes("Organize sidebar")).toBe(true);
    });

    expect(textContent(document.body).includes("Organize pins")).toBe(false);
  });

  test("project row new-chat button reuses an existing blank session", async () => {
    const betaBlank = makeSession({
      id: "session:beta:blank",
      projectId: "beta",
      title: "New thread",
      thread: null,
      tabs: [],
    });
    const screen = renderWorkbench({
      projects: [makeProject(), makeProject("beta", "Beta")],
      sessionsByProject: {
        alpha: [makeSession()],
        beta: [
          makeAttachedSession({
            id: "session:beta:database-view",
            projectId: "beta",
            threadId: "thread-beta-database-view",
            title: "Database View",
          }),
          betaBlank,
        ],
      },
      defaultDraftSessionIdsByScope: {
        beta: betaBlank.id,
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Start new chat in Beta"));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(
      invokeCalls.some(
        (call) => call[0] === "project-sessions:ensure-default-draft" && call[1] === "beta",
      ),
    ).toBe(true);
    await waitFor(() => {
      const latestProps = (
        globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> }
      ).__lastConnectedThreadStageProps;
      expect(latestProps?.newThreadTarget).toMatchObject({
        projectId: "beta",
        sessionId: "session:beta:blank",
      });
    });
  });
});
