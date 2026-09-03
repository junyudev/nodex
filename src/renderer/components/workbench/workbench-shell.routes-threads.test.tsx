import "./workbench-testkit/workbench-shell-harness";
import { describe, test, expect } from "vite-plus/test";
import { settleAsyncRender, textContent } from "../../test/dom";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { WORKBENCH_AUTOMATION_FIRST_RUN_SUGGESTIONS } from "./workbench-automation-templates";
import { THREAD_QUEUE_FOLLOW_UPS_STORAGE_KEY } from "@/lib/thread-composer-follow-up-mode";
import { COMPOSER_ENTER_BEHAVIOR_STORAGE_KEY } from "@/lib/composer-enter-behavior";
import { type CodexScheduledAutomationCreateInput } from "@/lib/types";
import { __getNodexToastSnapshotForTests } from "@/components/ui/toast";
import { parseDatabaseId, parseDatabaseViewId } from "../../../shared/database-identities";
import type { LibraryDatabaseNavigationNode } from "../../../shared/library-module";
import {
  makeAttachedSession,
  makeBlankSession,
  makePanelLayout,
  makeProject,
  makeScheduledAutomation,
  makeSession,
  makeSessionTab,
} from "./workbench-testkit/workbench-shell-fixtures";
import {
  getHeaderShellSlot,
  getLastThreadStageActions,
  getPanelTabById,
  installShellBodyMeasurementForTest,
  installTerminalEventApiMock,
  invokeCalls,
  mockInvokeImpl,
  mockThreadStartProgress,
  renderWorkbench,
  setMockConversationHasVisibleTurn,
  setMockInvokeImpl,
  setMockThreadStartProgress,
} from "./workbench-testkit/workbench-shell-harness";

const standaloneTasksDatabase: LibraryDatabaseNavigationNode = {
  kind: "database",
  databaseId: parseDatabaseId("database:test:standalone"),
  title: "Tasks",
  defaultViewId: parseDatabaseViewId("database-view:test:board"),
  hasMultipleViews: false,
  metadataRevision: 1,
  locationRevision: 1,
  updatedAt: "2026-08-03T00:00:00.000Z",
};

const standaloneNotesDatabase: LibraryDatabaseNavigationNode = {
  ...standaloneTasksDatabase,
  databaseId: parseDatabaseId("database:test:notes"),
  defaultViewId: parseDatabaseViewId("database-view:test:notes"),
  title: "Notes",
};

const openStandaloneTasksDatabase = async (screen: ReturnType<typeof renderWorkbench>) => {
  await settleAsyncRender();
  await settleAsyncRender();
  const row = (await screen.findAllByText("Tasks"))
    .map((element) => element.closest('[role="listitem"]'))
    .find((element): element is HTMLElement => element instanceof HTMLElement);
  if (!(row instanceof HTMLElement)) {
    throw new Error("Expected the standalone Tasks row");
  }
  await act(async () => {
    fireEvent.click(row);
    await Promise.resolve();
  });
  await settleAsyncRender();
  await settleAsyncRender();
};

describe("workbench session shell / routes-threads", () => {
  test("opens settings as a full-window route shell from the sidebar settings button", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();
    await settleAsyncRender();

    const settingsButton = screen.getByRole("button", { name: "Settings" });
    if (!(settingsButton instanceof HTMLElement)) {
      throw new Error("Expected a sidebar settings button");
    }
    expect(screen.container.querySelector('[aria-label="Manage workspaces"]')).toBe(null);

    await act(async () => {
      fireEvent.click(settingsButton);
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(screen.queryByRole("dialog", { name: "Settings" })).toBe(null);
    const routeShell = screen.container.querySelector('[data-testid="settings-route-shell"]');
    expect(routeShell !== null).toBe(true);
    expect(screen.container.querySelector('[data-thread-stage="true"]')).toBe(null);

    const settingsSidebar = screen.container.querySelector(".app-shell-left-panel");
    expect(settingsSidebar !== null).toBe(true);
    expect(
      screen.container.querySelector('[data-testid="settings-route-shell"] .main-surface') !== null,
    ).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByText("Back to app"));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(screen.container.querySelector('[data-testid="settings-route-shell"]')).toBe(null);
    expect(screen.container.querySelector('[data-thread-stage="true"]') !== null).toBe(true);
  });

  test("opens scheduled task management as a full-window route shell from the sidebar", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Scheduled" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    const routeShell = screen.getByTestId("automations-route-shell");
    const globalHeader = screen.getByTestId("workbench-global-header");
    const headerContextSurface = screen.getByTestId("app-shell-header-context-menu-surface");
    const leftSlot = getHeaderShellSlot(screen, "left");
    const rightSlot = getHeaderShellSlot(screen, "right");
    const leftLabels = Array.from(leftSlot.querySelectorAll("button"))
      .map((button) => button.getAttribute("aria-label"))
      .join(",");

    await waitFor(() => {
      expect(within(headerContextSurface).queryByRole("button", { name: "Tasks" }) !== null).toBe(
        true,
      );
    });

    expect(routeShell !== null).toBe(true);
    expect(screen.container.querySelector('[data-thread-stage="true"]')).toBe(null);
    expect(globalHeader.contains(headerContextSurface)).toBe(true);
    expect(headerContextSurface.getAttribute("aria-hidden")).toBe(null);
    expect(headerContextSurface.className.includes("invisible")).toBe(false);
    expect(leftLabels).toBe("Hide sidebar,Back,Forward");
    expect(rightSlot.getAttribute("style")?.includes("width: 0px")).toBe(true);
    expect(rightSlot.getAttribute("style")?.includes("min-width: 0")).toBe(true);
    expect(within(globalHeader).queryByRole("button", { name: "Toggle bottom panel" })).toBe(null);
    expect(within(globalHeader).queryByRole("button", { name: "Toggle side panel" })).toBe(null);
    expect(within(headerContextSurface).queryByRole("button", { name: "Templates" }) !== null).toBe(
      true,
    );
    expect(
      within(headerContextSurface).queryByRole("button", { name: "Create via chat" }) !== null,
    ).toBe(true);
    expect(routeShell.contains(headerContextSurface)).toBe(false);
    expect(routeShell.querySelector("main > header") === null).toBe(true);
    expect(
      within(screen.getByRole("navigation", { name: "Automation folders" }))
        .getByRole("button", { name: "Scheduled" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      textContent(screen.container).includes(
        "Ask ChatGPT to schedule tasks, set reminders, or monitor for updates.",
      ),
    ).toBe(true);
    expect(textContent(screen.container).includes("Create your first scheduled task")).toBe(true);
    const firstRunSuggestionNames = WORKBENCH_AUTOMATION_FIRST_RUN_SUGGESTIONS.map(
      (suggestion) => suggestion.name,
    ).join(",");
    const visibleFirstRunSuggestionNames = WORKBENCH_AUTOMATION_FIRST_RUN_SUGGESTIONS.map(
      (suggestion) =>
        screen.getByRole("button", { name: suggestion.name }).textContent?.trim() ?? "",
    ).join(",");
    expect(visibleFirstRunSuggestionNames).toBe(firstRunSuggestionNames);
    expect(screen.container.querySelector('[data-testid="project-session-sidebar"]') !== null).toBe(
      true,
    );
  });

  test("routes a Pages Database through global Back and Forward", async () => {
    const screen = renderWorkbench({ libraryRoots: [standaloneTasksDatabase] });
    await settleAsyncRender();
    await settleAsyncRender();

    const globalHeader = screen.getByTestId("workbench-global-header");
    await openStandaloneTasksDatabase(screen);

    expect(screen.getByTestId("workbench-database-view-surface") !== null).toBe(true);
    const breadcrumb = screen.getByTestId("app-shell-header-context-menu-surface");
    expect(within(breadcrumb).getByText("Pages") !== null).toBe(true);
    expect(within(breadcrumb).getByText("Tasks") !== null).toBe(true);

    const back = within(globalHeader).getByRole("button", { name: "Back" });
    expect((back as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(back);
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(screen.queryByTestId("workbench-database-view-surface")).toBeNull();
    const forward = within(globalHeader).getByRole("button", { name: "Forward" });
    expect((forward as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(forward);
      await Promise.resolve();
    });
    await settleAsyncRender();
    expect(screen.getByTestId("workbench-database-view-surface") !== null).toBe(true);
  });

  test("opens a standalone Database with Library authority in the Pages Scene", async () => {
    const screen = renderWorkbench({ libraryRoots: [standaloneTasksDatabase] });
    await settleAsyncRender();
    await settleAsyncRender();

    await openStandaloneTasksDatabase(screen);

    const props = (
      globalThis as {
        __lastWorkbenchDatabaseViewSurfaceProps?: Record<string, unknown>;
      }
    ).__lastWorkbenchDatabaseViewSurfaceProps;
    expect(props?.accessContext).toEqual({ kind: "library" });
    expect(props?.target).toEqual({
      kind: "database-default",
      databaseId: "database:test:standalone",
    });
    expect(screen.getByRole("tab", { name: "Tasks", selected: true }) !== null).toBe(true);
    expect(screen.queryByText("Library")).toBeNull();
  });

  test("projects a visible Pages Scene Page Stage back into its Database surface", async () => {
    const screen = renderWorkbench({ libraryRoots: [standaloneTasksDatabase] });
    await settleAsyncRender();
    await openStandaloneTasksDatabase(screen);

    const props = (
      globalThis as {
        __lastWorkbenchDatabaseViewSurfaceProps?: Record<string, unknown>;
      }
    ).__lastWorkbenchDatabaseViewSurfaceProps;
    if (typeof props?.onOpenPage !== "function") {
      throw new Error("Expected the Pages Database Page opener");
    }
    await act(async () => {
      (
        props.onOpenPage as (pageId: string, title: string, openMode: "preview" | "durable") => void
      )("page:visible", "Visible Page", "preview");
      await Promise.resolve();
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const nextProps = (
      globalThis as {
        __lastWorkbenchDatabaseViewSurfaceProps?: Record<string, unknown>;
      }
    ).__lastWorkbenchDatabaseViewSurfaceProps;
    const presentedPageIds = nextProps?.presentedPageIds as ReadonlySet<string> | undefined;
    expect(presentedPageIds?.has("page:visible")).toBe(true);
    expect(
      screen
        .getByRole("tab", { name: "Visible Page" })
        .closest('[data-app-shell-tab-preview="true"]'),
    ).not.toBeNull();
  });

  test("shares one Pages tablist across standalone roots and reuses open tabs", async () => {
    const screen = renderWorkbench({
      libraryRoots: [standaloneTasksDatabase, standaloneNotesDatabase],
    });
    await openStandaloneTasksDatabase(screen);

    const notesRow = (await screen.findByText("Notes")).closest('[role="listitem"]');
    if (!(notesRow instanceof HTMLElement)) throw new Error("Expected Notes row");
    await act(async () => {
      fireEvent.click(notesRow);
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(screen.getAllByRole("tab")).toHaveLength(2);

    await openStandaloneTasksDatabase(screen);

    expect(screen.getAllByRole("tab")).toHaveLength(2);
    const props = (
      globalThis as {
        __lastWorkbenchDatabaseViewSurfaceProps?: Record<string, unknown>;
      }
    ).__lastWorkbenchDatabaseViewSurfaceProps;
    expect(props?.target).toEqual({
      kind: "database-default",
      databaseId: "database:test:standalone",
    });
  });

  test("restores full-width right-panel geometry after returning from settings", async () => {
    const measurement = installShellBodyMeasurementForTest({ width: 850, height: 640 });
    try {
      const screen = renderWorkbench();
      await settleAsyncRender();
      await settleAsyncRender();

      const rightPanel = screen.getByTestId("session-right-panel");
      expect(rightPanel.getAttribute("data-right-panel-width-mode")).toBe("full");
      await waitFor(() => {
        expect(rightPanel.style.width).toBe("550px");
      });
      const fullWidthBeforeSettings = rightPanel.style.width;

      const settingsButton = screen.getByRole("button", { name: "Settings" });
      if (!(settingsButton instanceof HTMLElement)) {
        throw new Error("Expected a sidebar settings button");
      }
      await act(async () => {
        fireEvent.click(settingsButton);
        await Promise.resolve();
      });
      await settleAsyncRender();

      await act(async () => {
        measurement.flushResizeObservers();
        await Promise.resolve();
      });
      await settleAsyncRender();

      await act(async () => {
        fireEvent.click(screen.getByText("Back to app"));
        await Promise.resolve();
      });
      await settleAsyncRender();
      await settleAsyncRender();

      const restoredRightPanel = screen.getByTestId("session-right-panel");
      const restoredThreadPage = screen.container.querySelector(
        '[data-testid="session-thread-page"]',
      );
      const restoreButton = screen.getByRole("button", { name: "Restore panel width" });
      expect(restoredRightPanel.getAttribute("data-right-panel-width-mode")).toBe("full");
      await waitFor(() => {
        expect(restoredRightPanel.style.width).toBe(fullWidthBeforeSettings);
      });
      expect(restoredThreadPage?.getAttribute("data-session-thread-page-hidden")).toBe("true");
      expect(restoreButton.getAttribute("aria-pressed")).toBe("true");
    } finally {
      measurement.restore();
    }
  });

  test("restores the DB toolbar controls inside session DB tabs", async () => {
    const listTab = makeSessionTab({
      id: "session:alpha:database-view:list",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "db_view",
      title: "Tasks",
      order: 0,
      config: { projectId: "alpha" },
    });
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [
          makeSession({
            tabs: [listTab],
            rightLayout: makePanelLayout([listTab.id], listTab.id),
          }),
        ],
      },
      searchByProject: { alpha: "urgent" },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const dbToolbarTabList = screen.getByRole("tablist", { name: "Database views" });
    expect(dbToolbarTabList.getAttribute("aria-label")).toBe("Database views");
    expect(
      within(dbToolbarTabList).getByRole("tab", { name: "Board" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: "Filter View" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Display options" })).toBeTruthy();
    expect(screen.getByDisplayValue("urgent").getAttribute("value")).toBe("urgent");

    const props = (globalThis as { __lastDatabaseViewSurfaceProps?: Record<string, unknown> })
      .__lastDatabaseViewSurfaceProps;
    expect(props?.searchQuery).toBe("urgent");
    expect(props?.presentationLayout).toBe("board");
  });

  test("switches Board and List as durable View identities in the current Session tab", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      const dbToolbarTabList = screen.getByRole("tablist", { name: "Database views" });
      fireEvent.mouseDown(within(dbToolbarTabList).getByRole("tab", { name: "List" }), {
        button: 0,
        ctrlKey: false,
      });
      fireEvent.click(within(dbToolbarTabList).getByRole("tab", { name: "List" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:tab-update" &&
          call[1] === "session:alpha:database-view:db" &&
          (call[2] as { config?: { databaseViewId?: string } }).config?.databaseViewId ===
            "database-view:alpha:primary-list",
      ),
    ).toBe(true);
    const dbToolbarTabList = screen.getByRole("tablist", { name: "Database views" });
    expect(
      within(dbToolbarTabList).getByRole("tab", { name: "List" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("grid", { name: "Database List" })).toBeTruthy();
    const preferenceWrite = invokeCalls.find(
      (call) =>
        call[0] === "database-module:apply" &&
        call[1] === "alpha" &&
        (call[2] as { operations?: ReadonlyArray<{ kind?: string }> }).operations?.some(
          (operation) => operation.kind === "put_view_personal_preferences",
        ),
    );
    expect(preferenceWrite).toBeUndefined();
  });

  test("keeps two same-Project Database tabs bound to their own durable View identity", async () => {
    const primaryTab = makeSessionTab({
      id: "session:alpha:database-view:primary",
      kind: "db_view",
      title: "Primary",
      config: {
        projectId: "alpha",
        databaseViewId: "view-alpha-primary",
      },
    });
    const focusedTab = makeSessionTab({
      id: "session:alpha:database-view:focused",
      kind: "db_view",
      title: "Focused",
      config: {
        projectId: "alpha",
        databaseViewId: "view-alpha-focused",
      },
    });
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [
          makeSession({
            tabs: [primaryTab, focusedTab],
            rightLayout: makePanelLayout([primaryTab.id, focusedTab.id], focusedTab.id),
          }),
        ],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(
      screen.container.querySelector(
        '[data-database-view-surface="true"][data-database-view-id="view-alpha-focused"]',
      ) !== null,
    ).toBe(true);

    await act(async () => {
      fireEvent.mouseDown(getPanelTabById(screen.container, primaryTab.id), {
        button: 0,
      });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(
      screen.container.querySelector(
        '[data-database-view-surface="true"][data-database-view-id="view-alpha-primary"]',
      ) !== null,
    ).toBe(true);
  });

  test("renders an attached session thread as the main session page", async () => {
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [makeAttachedSession({ id: "session:alpha:thread", title: "Thread" })],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const threadPage = screen.container.querySelector('[data-testid="session-thread-page"]');
    expect(threadPage?.getAttribute("data-session-thread-page-hidden")).toBe("false");
    expect(textContent(screen.container).includes("Thread:thread-alpha")).toBe(true);
    expect(screen.container.querySelector('[data-thread-stage="true"]') !== null).toBe(true);
    const props = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(JSON.stringify(props?.activeThreadSummary).includes('"projectId":"alpha"')).toBe(true);
  });

  test("passes composer follow-up and enter preferences into attached session threads", async () => {
    localStorage.setItem(THREAD_QUEUE_FOLLOW_UPS_STORAGE_KEY, "false");
    localStorage.setItem(COMPOSER_ENTER_BEHAVIOR_STORAGE_KEY, "cmdIfMultiline");
    renderWorkbench({
      sessionsByProject: {
        alpha: [makeAttachedSession({ id: "session:alpha:thread", title: "Thread" })],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const props = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(props?.isQueueingEnabled).toBe(false);
    expect(props?.composerEnterBehavior).toBe("cmdIfMultiline");
  });

  test("moves session start progress onto the thread surface before a turn is visible", async () => {
    setMockConversationHasVisibleTurn(false);
    setMockThreadStartProgress({
      projectId: "alpha",
      sessionId: "session:alpha:thread",
      runInTarget: "localProject",
      threadId: "thread-alpha",
      phase: "startingThread",
      message: "Sending message…",
      outputText: "",
      updatedAt: 10,
    });
    renderWorkbench({
      sessionsByProject: {
        alpha: [makeAttachedSession({ id: "session:alpha:thread", title: "Thread" })],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const props = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(JSON.stringify(props?.threadStartProgress)).toBe(
      JSON.stringify(mockThreadStartProgress),
    );
    expect(props?.isNewThreadTab).toBe(false);
    expect(props?.activeThreadId).toBe("thread-alpha");
  });

  test("uses the global app header as the only top title row", async () => {
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [makeAttachedSession({ id: "session:alpha:thread", title: "Thread" })],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const globalHeader = screen.container.querySelector('[data-testid="workbench-global-header"]');
    const headerContextSurface = screen.container.querySelector(
      '[data-testid="app-shell-header-context-menu-surface"]',
    );
    const threadStage = screen.container.querySelector('[data-thread-stage="true"]');
    const threadFrame = screen.container.querySelector(".app-shell-main-content-frame");
    if (!globalHeader || !threadFrame || !threadStage) {
      throw new Error("Expected workbench global header, thread frame, and thread stage");
    }
    expect(textContent(globalHeader).includes("Database View")).toBe(false);
    expect(textContent(globalHeader).includes("Alpha thread")).toBe(true);
    expect(textContent(threadStage).includes("Alpha thread")).toBe(false);
    expect(headerContextSurface !== null).toBe(true);
    expect(
      (threadFrame.getAttribute("style") ?? "").includes(
        "--app-shell-main-content-frame-top-offset",
      ),
    ).toBe(false);
    expect(
      screen.container.querySelector("[data-app-shell-main-content-header-divider]") === null,
    ).toBe(true);
    const topFade = screen.container.querySelector(".app-shell-main-content-top-fade");
    expect(topFade?.getAttribute("data-app-shell-main-content-top-fade")).toBe("full-bleed");
  });

  test("renders the session new-thread composer instead of the old attach placeholder", async () => {
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeBlankSession()] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const threadPage = screen.container.querySelector('[data-testid="session-thread-page"]');
    const props = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(threadPage?.getAttribute("data-session-thread-page-hidden")).toBe("false");
    expect(screen.getByLabelText("Prompt").getAttribute("placeholder")).toBe(
      "Write the first prompt for this new thread...",
    );
    expect(
      textContent(screen.container).includes(
        "Attach an existing Codex thread to use this session page.",
      ),
    ).toBe(false);
    expect(props?.isNewThreadTab).toBe(true);
    expect(props?.activeThreadId === null).toBe(true);
    expect(
      JSON.stringify(props?.newThreadTarget).includes('"sessionId":"session:alpha:blank"'),
    ).toBe(true);
  });

  test("passes the start-in selector to attached thread summary panels", async () => {
    renderWorkbench({
      sessionsByProject: { alpha: [makeAttachedSession()] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const props = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    const selector = props?.newThreadStartInSelector as
      | {
          target?: { runInTarget?: string; worktreeStartingState?: unknown };
          disabled?: boolean;
        }
      | null
      | undefined;
    expect(props?.isNewThreadTab).toBe(false);
    expect(props?.newThreadTarget === null).toBe(true);
    expect(selector?.target?.runInTarget).toBe("localProject");
    expect(selector?.target?.worktreeStartingState).toBeUndefined();
    expect(selector?.disabled).toBe(false);
  });

  test("summary scheduled automation action opens the selected automation route", async () => {
    installTerminalEventApiMock();
    const automation = makeScheduledAutomation({
      id: "automation-summary",
      name: "Summary cadence",
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeAttachedSession()] },
      scheduledAutomations: [automation],
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const actions = getLastThreadStageActions();
    const openScheduledAutomation = actions.onOpenSummaryScheduledAutomation as
      | ((input: { automationId: string; title: string }) => void)
      | undefined;
    expect(typeof openScheduledAutomation).toBe("function");

    await act(async () => {
      openScheduledAutomation?.({
        automationId: automation.id,
        title: automation.name,
      });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(screen.container.querySelector('[data-testid="automations-route-shell"]') !== null).toBe(
      true,
    );
    await waitFor(() => {
      expect(textContent(screen.container).includes("Summary cadence")).toBe(true);
    });
    expect(screen.container.querySelector('[data-testid="automation-detail-rail"]') !== null).toBe(
      true,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Collapse details" }));
      await Promise.resolve();
    });
    await settleAsyncRender();
    expect(screen.container.querySelector('[data-testid="automation-detail-rail"]')).toBe(null);
    expect(screen.container.querySelector('[data-thread-stage="true"]')).toBe(null);
  });

  test("summary scheduled automation proposal opens and saves from the side panel", async () => {
    installTerminalEventApiMock();
    const screen = renderWorkbench({
      projects: [makeProject("alpha", "Alpha", "/tmp/project")],
      sessionsByProject: {
        alpha: [makeAttachedSession({ id: "session:alpha:automation-proposal" })],
      },
      scheduledAutomations: [],
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const actions = getLastThreadStageActions();
    const openScheduledAutomation = actions.onOpenSummaryScheduledAutomation as
      | ((input: {
          createInput: CodexScheduledAutomationCreateInput;
          mode: "suggested-create";
          title: string;
        }) => void)
      | undefined;
    expect(typeof openScheduledAutomation).toBe("function");

    await act(async () => {
      openScheduledAutomation?.({
        mode: "suggested-create",
        title: "Review release notes",
        createInput: {
          kind: "cron",
          name: "Review release notes",
          prompt: "Review release notes and summarize risks.",
          rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
          cwds: ["/tmp/project"],
          executionEnvironment: "worktree",
          localEnvironmentConfigPath: null,
          model: "gpt-5.5",
          reasoningEffort: "medium",
        },
      });
      await Promise.resolve();
    });
    await settleAsyncRender();

    const sidePanel = screen.container.querySelector(
      '[data-automation-side-panel-tab="true"]',
    ) as HTMLElement | null;
    expect(sidePanel !== null).toBe(true);
    if (!sidePanel) throw new Error("Expected automation side panel");
    expect(screen.container.querySelector('[data-testid="automations-route-shell"]')).toBe(null);
    expect(textContent(sidePanel).includes("Review release notes")).toBe(true);

    await act(async () => {
      fireEvent.click(within(sidePanel).getByRole("button", { name: "Create scheduled task" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getScheduledAutomations().length).toBe(1);
    });
    expect(screen.getScheduledAutomations()[0]?.name).toBe("Review release notes");
    await waitFor(() => {
      const currentSidePanel = screen.container.querySelector(
        '[data-automation-side-panel-tab="true"]',
      ) as HTMLElement | null;
      expect(currentSidePanel !== null).toBe(true);
      expect(
        within(currentSidePanel as HTMLElement).getByRole("button", {
          name: "Open in Scheduled",
        }) !== null,
      ).toBe(true);
    });
  });

  test("summary scheduled automation proposal reports create failures with the scheduled task toast title", async () => {
    installTerminalEventApiMock();
    const screen = renderWorkbench({
      projects: [makeProject("alpha", "Alpha", "/tmp/project")],
      sessionsByProject: {
        alpha: [makeAttachedSession({ id: "session:alpha:automation-proposal-failure" })],
      },
      scheduledAutomations: [],
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const actions = getLastThreadStageActions();
    const openScheduledAutomation = actions.onOpenSummaryScheduledAutomation as
      | ((input: {
          createInput: CodexScheduledAutomationCreateInput;
          mode: "suggested-create";
          title: string;
        }) => void)
      | undefined;
    expect(typeof openScheduledAutomation).toBe("function");

    await act(async () => {
      openScheduledAutomation?.({
        mode: "suggested-create",
        title: "Broken proposal",
        createInput: {
          kind: "cron",
          name: "Broken proposal",
          prompt: "Try to create and fail.",
          rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
          cwds: ["/tmp/project"],
          executionEnvironment: "worktree",
          localEnvironmentConfigPath: null,
          model: "gpt-5.5",
          reasoningEffort: "medium",
        },
      });
      await Promise.resolve();
    });
    await settleAsyncRender();

    const sidePanel = screen.container.querySelector(
      '[data-automation-side-panel-tab="true"]',
    ) as HTMLElement | null;
    expect(sidePanel !== null).toBe(true);
    if (!sidePanel) throw new Error("Expected automation side panel");
    const baseMockInvokeImpl = mockInvokeImpl;
    setMockInvokeImpl(async (channel, ...args) => {
      if (channel === "codex:scheduled-automations:create") {
        throw new Error("Create bridge failed");
      }
      return baseMockInvokeImpl?.(channel, ...args) ?? null;
    });

    await act(async () => {
      fireEvent.click(within(sidePanel).getByRole("button", { name: "Create scheduled task" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        __getNodexToastSnapshotForTests().some(
          (record) =>
            record.kind === "plain" &&
            record.level === "danger" &&
            record.title === "Could not create scheduled task" &&
            record.description === "Create bridge failed",
        ),
      ).toBe(true);
    });
    expect(screen.getScheduledAutomations().length).toBe(0);
    expect(textContent(sidePanel).includes("Create bridge failed")).toBe(true);
  });
});
