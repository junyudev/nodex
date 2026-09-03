import "./workbench-testkit/workbench-shell-harness";
import { describe, test, expect, vi } from "vite-plus/test";
import { settleAsyncRender, textContent } from "../../test/dom";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { splitWorkbenchPanelLeaf } from "../../../shared/workbench-panel-layout";
import { isUuidV7 } from "../../../shared/uuid-v7";
import {
  makeAttachedSession,
  makeBlankSession,
  makePanelLayout,
  makePanels,
  makeProject,
  makeSession,
  makeSessionTab,
} from "./workbench-testkit/workbench-shell-fixtures";
import {
  TITLEBAR_NEW_CHAT_ICON_PREFIX,
  executeCommandPaletteCommand,
  getHeaderShellSlot,
  getLastTerminalPanelProps,
  getThreadRow,
  installMotionEnabledMatchMediaForTest,
  installReducedMotionMatchMediaForTest,
  invokeCalls,
  moveSidebarPointer,
  openPanelMenu,
  pointerActivate,
  pointerDownAndSettle,
  renderWorkbench,
  rendererCommandPayload,
  startThreadForSessionCalls,
  startTurnCalls,
  setInvokeCalls,
  setPageChatItems,
} from "./workbench-testkit/workbench-shell-harness";

describe("workbench session shell / pages-shell-navigation", () => {
  test("projects migrate retired Calendar tabs to the durable View's Board layout", async () => {
    const session = makeSession({
      tabs: [
        makeSessionTab({
          id: "calendar-db",
          title: "Calendar",
          kind: "db_view",
          config: { projectId: "alpha" },
        }),
      ],
    });
    const screen = renderWorkbench({ sessionsByProject: { alpha: [session] } });
    await settleAsyncRender();
    await settleAsyncRender();

    const props = (globalThis as { __lastDatabaseViewSurfaceProps?: Record<string, unknown> })
      .__lastDatabaseViewSurfaceProps;
    expect(props?.presentationLayout).toBe("board");
    expect(screen.queryByRole("button", { name: "Calendar" })).toBeNull();
    expect(screen.getByText("DB:alpha:board")).toBeTruthy();
  });

  test("opens a Database Page preview without starting a Thread", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();
    await settleAsyncRender();

    const props = (globalThis as { __lastDatabaseViewSurfaceProps?: Record<string, unknown> })
      .__lastDatabaseViewSurfaceProps;
    expect(typeof props?.onOpenPage).toBe("function");
    await act(async () => {
      await (
        props?.onOpenPage as (
          pageId: string,
          titleSnapshot: string,
          openMode: "preview" | "durable",
        ) => Promise<void> | void
      )("card-1", "Card One", "preview");
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(invokeCalls.some((call) => call[0] === "project-sessions:create")).toBe(false);
    expect(startThreadForSessionCalls).toHaveLength(0);
    expect(screen.getByRole("tab", { name: "Card One" }) !== null).toBe(true);
    expect(screen.container.querySelector('[data-app-shell-tab-preview="true"]') !== null).toBe(
      true,
    );
  });

  test("opens a Page in an ordinary Chat without claiming the default-draft slot", async () => {
    const screen = renderWorkbench({ sessionsByProject: { alpha: [] } });
    await settleAsyncRender();
    await settleAsyncRender();

    setInvokeCalls([]);
    const databaseViewSurfaceProps = (
      globalThis as {
        __lastDatabaseViewSurfaceProps?: Record<string, unknown>;
      }
    ).__lastDatabaseViewSurfaceProps;
    const pageActionPort = databaseViewSurfaceProps?.pageActionPort as
      | {
          readonly openInNewChat?: (input: {
            projectId: string;
            pageId: string;
            titleSnapshot?: string;
          }) => Promise<void> | void;
        }
      | undefined;
    const openPageInNewChat = pageActionPort?.openInNewChat as
      | ((input: {
          projectId: string;
          pageId: string;
          titleSnapshot?: string;
        }) => Promise<void> | void)
      | undefined;
    expect(typeof openPageInNewChat).toBe("function");
    await act(async () => {
      await openPageInNewChat?.({
        projectId: "alpha",
        pageId: "card-1",
        titleSnapshot: "Card One",
      });
    });
    await waitFor(() => {
      expect(invokeCalls.some((call) => call[0] === "project-sessions:create")).toBe(true);
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const createPayload = rendererCommandPayload(
      invokeCalls.find((call) => call[0] === "project-sessions:create"),
    );
    expect(createPayload?.input).toEqual({
      projectId: "alpha",
      noThreadFallbackTitle: "Card One",
      initialPageIds: ["card-1"],
    });
    expect(invokeCalls.some((call) => call[0] === "project-sessions:ensure-default-draft")).toBe(
      false,
    );
    const ordinaryTarget = (
      globalThis as {
        __lastConnectedThreadStageProps?: {
          newThreadTarget?: { sessionId?: string };
        };
      }
    ).__lastConnectedThreadStageProps?.newThreadTarget;
    expect(ordinaryTarget?.sessionId).toBe(createPayload?.sessionId);

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Start new chat in Alpha"));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "project-sessions:ensure-default-draft" &&
          rendererCommandPayload(call)?.projectId === "alpha",
      ),
    ).toBe(true);
    const defaultDraftTarget = (
      globalThis as {
        __lastConnectedThreadStageProps?: {
          newThreadTarget?: { sessionId?: string };
        };
      }
    ).__lastConnectedThreadStageProps?.newThreadTarget;
    const defaultDraftPayload = rendererCommandPayload(
      invokeCalls.find((call) => call[0] === "project-sessions:ensure-default-draft"),
    );
    expect(defaultDraftTarget?.sessionId).toBe(defaultDraftPayload?.candidateSessionId);
    expect(defaultDraftTarget?.sessionId).not.toBe(ordinaryTarget?.sessionId);
  });

  test("panel tab menu creates tabs after opening a collapsed right panel", async () => {
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeSession({ rightCollapsed: true })] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Toggle side panel" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    await openPanelMenu(screen, "Open side panel tab");

    await act(async () => {
      fireEvent.click(screen.getByText("Browser"));
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
    expect(screen.getByRole("tab", { name: "Browser" })).not.toBeNull();
    expect(screen.queryAllByRole("tablist").length > 0).toBe(true);
  });

  test("opens full-width single-group database pages as renderer-local previews in a new right group", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();
    await settleAsyncRender();

    const props = (globalThis as { __lastDatabaseViewSurfaceProps?: Record<string, unknown> })
      .__lastDatabaseViewSurfaceProps;
    expect(typeof props?.openPageStage).toBe("function");
    await act(async () => {
      await (
        props?.openPageStage as (
          projectId: string,
          pageId: string,
          title?: string,
        ) => Promise<void> | void
      )("alpha", "card-1", "Card One");
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const tab = screen.getByRole("tab", { name: "Card One" });
    expect(tab.closest('[data-app-shell-tab-preview="true"]') !== null).toBe(true);
    expect(tab.closest("[data-panel-tab-row]")?.getAttribute("data-panel-tab-row")).not.toBe(
      "right:leaf:right",
    );
    expect(
      screen.container.querySelector('[data-app-shell-tabpanel-preview="true"]') !== null,
    ).toBe(true);
    expect(invokeCalls.some((call) => call[0] === "window-session-view:tab-create")).toBe(false);
    expect(invokeCalls.some((call) => call[0] === "window-session-view:ensure-right-leaf")).toBe(
      true,
    );
    expect(
      invokeCalls.some((call) => {
        const input = call[3] as { size?: { fullWidth?: boolean } } | undefined;
        return (
          call[0] === "window-session-view:panel-patch" &&
          call[1] === "session:alpha:database-view" &&
          call[2] === "right" &&
          input?.size?.fullWidth === false
        );
      }),
    ).toBe(false);
  });

  test("opens DB page previews in the active group when the right panel is not full-width", async () => {
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [makeSession({ rightFullWidth: false })],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const props = (globalThis as { __lastDatabaseViewSurfaceProps?: Record<string, unknown> })
      .__lastDatabaseViewSurfaceProps;
    expect(typeof props?.openPageStage).toBe("function");
    await act(async () => {
      await (
        props?.openPageStage as (
          projectId: string,
          pageId: string,
          title?: string,
        ) => Promise<void> | void
      )("alpha", "card-1", "Card One");
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const tab = screen.getByRole("tab", { name: "Card One" });
    expect(tab.closest('[data-app-shell-tab-preview="true"]') !== null).toBe(true);
    expect(
      screen.container.querySelector('[data-app-shell-tabpanel-preview="true"]') !== null,
    ).toBe(true);
    expect(invokeCalls.some((call) => call[0] === "window-session-view:tab-create")).toBe(false);
    expect(invokeCalls.some((call) => call[0] === "window-session-view:ensure-right-leaf")).toBe(
      false,
    );
  });

  test("creates a right group before opening a preview from a full-width DB tab", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();
    await settleAsyncRender();

    const props = (globalThis as { __lastDatabaseViewSurfaceProps?: Record<string, unknown> })
      .__lastDatabaseViewSurfaceProps;
    expect(typeof props?.openPageStage).toBe("function");
    await act(async () => {
      await (
        props?.openPageStage as (
          projectId: string,
          pageId: string,
          title?: string,
        ) => Promise<void> | void
      )("alpha", "card-1", "Card One");
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const ensureCall = invokeCalls.find(
      (call) => call[0] === "window-session-view:ensure-right-leaf",
    );
    expect(ensureCall !== undefined).toBe(true);
    const tab = screen.getByRole("tab", { name: "Card One" });
    expect(tab.closest('[data-app-shell-tab-preview="true"]') !== null).toBe(true);
    expect(tab.closest("[data-panel-tab-row]")?.getAttribute("data-panel-tab-row")).not.toBe(
      "right:leaf:right",
    );
    expect(invokeCalls.some((call) => call[0] === "window-session-view:tab-create")).toBe(false);
  });

  test("pins page-stage previews after panel interaction", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();
    await settleAsyncRender();

    const props = (globalThis as { __lastDatabaseViewSurfaceProps?: Record<string, unknown> })
      .__lastDatabaseViewSurfaceProps;
    expect(typeof props?.openPageStage).toBe("function");
    await act(async () => {
      await (
        props?.openPageStage as (
          projectId: string,
          pageId: string,
          title?: string,
        ) => Promise<void> | void
      )("alpha", "card-1", "Card One");
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const previewTab = screen.getByRole("tab", { name: "Card One" });
    const previewTabId = previewTab
      .closest("[data-panel-tab-id]")
      ?.getAttribute("data-panel-tab-id");
    const previewLeafId = previewTab
      .closest("[data-panel-tab-row]")
      ?.getAttribute("data-panel-tab-row")
      ?.replace("right:", "");
    expect(typeof previewTabId).toBe("string");
    expect(typeof previewLeafId).toBe("string");

    setInvokeCalls([]);
    const editor = screen.container.querySelector(".nfm-editor .ProseMirror");
    if (!(editor instanceof HTMLElement)) throw new Error("Expected page stage editor preview");
    editor.focus();
    expect(document.activeElement).toBe(editor);
    expect((globalThis as { __mockPageStageMounts?: number }).__mockPageStageMounts).toBe(1);
    expect((globalThis as { __mockPageStageUnmounts?: number }).__mockPageStageUnmounts ?? 0).toBe(
      0,
    );
    await pointerDownAndSettle(editor);

    await waitFor(() => {
      const createCall = invokeCalls.find((call) => call[0] === "window-session-view:tab-create");
      expect(createCall !== undefined).toBe(true);
      const input = createCall?.[1] as Record<string, unknown> | undefined;
      expect(input?.sessionId).toBe("session:alpha:database-view");
      expect("projectId" in (input ?? {})).toBe(false);
      expect(input?.panelId).toBe("right");
      expect(input?.targetLeafId).toBe(previewLeafId);
      expect(input?.clientTabId).toBe(previewTabId);
      expect(input?.kind).toBe("page_stage");
      expect(input?.title).toBe("Card One");
      expect(JSON.stringify(input?.config)).toBe(
        JSON.stringify({
          accessContext: { kind: "project", projectId: "alpha" },
          pageId: "card-1",
          titleSnapshot: "Card One",
        }),
      );
    });
    expect(screen.container.querySelector(".nfm-editor .ProseMirror")).toBe(editor);
    expect(document.activeElement).toBe(editor);
    expect((globalThis as { __mockPageStageMounts?: number }).__mockPageStageMounts).toBe(1);
    expect((globalThis as { __mockPageStageUnmounts?: number }).__mockPageStageUnmounts ?? 0).toBe(
      0,
    );
  });

  test("double-clicking a page-stage preview tab label pins it without remounting", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();
    await settleAsyncRender();

    const props = (globalThis as { __lastDatabaseViewSurfaceProps?: Record<string, unknown> })
      .__lastDatabaseViewSurfaceProps;
    expect(typeof props?.openPageStage).toBe("function");
    await act(async () => {
      await (
        props?.openPageStage as (
          projectId: string,
          pageId: string,
          title?: string,
        ) => Promise<void> | void
      )("alpha", "card-1", "Card One");
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const previewTab = screen.getByRole("tab", { name: "Card One" });
    const previewTabId = previewTab
      .closest("[data-panel-tab-id]")
      ?.getAttribute("data-panel-tab-id");
    expect(typeof previewTabId).toBe("string");
    expect((globalThis as { __mockPageStageMounts?: number }).__mockPageStageMounts).toBe(1);
    expect((globalThis as { __mockPageStageUnmounts?: number }).__mockPageStageUnmounts ?? 0).toBe(
      0,
    );
    const previewPageStageProps = (
      globalThis as {
        __lastPageStageProps?: Record<string, unknown>;
      }
    ).__lastPageStageProps;
    expect(previewPageStageProps?.editorSessionKey).toBe(
      `session:alpha:database-view\u0000${previewTabId ?? ""}`,
    );
    expect(previewPageStageProps?.retainEditorSession).toBe(false);

    setInvokeCalls([]);
    await act(async () => {
      fireEvent.doubleClick(previewTab);
      await Promise.resolve();
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await waitFor(() => {
      const createCall = invokeCalls.find((call) => call[0] === "window-session-view:tab-create");
      expect(createCall !== undefined).toBe(true);
      const input = createCall?.[1] as Record<string, unknown> | undefined;
      expect(input?.clientTabId).toBe(previewTabId);
      expect(input?.kind).toBe("page_stage");
    });

    const durableTab = screen.getByRole("tab", { name: "Card One" });
    expect(durableTab.closest("[data-panel-tab-id]")?.getAttribute("data-panel-tab-id")).toBe(
      previewTabId,
    );
    expect(durableTab.closest('[data-app-shell-tab-preview="true"]')).toBe(null);
    expect(screen.container.querySelector('[data-app-shell-tabpanel-preview="true"]')).toBe(null);
    expect((globalThis as { __mockPageStageMounts?: number }).__mockPageStageMounts).toBe(1);
    expect((globalThis as { __mockPageStageUnmounts?: number }).__mockPageStageUnmounts ?? 0).toBe(
      0,
    );
    const durablePageStageProps = (
      globalThis as {
        __lastPageStageProps?: Record<string, unknown>;
      }
    ).__lastPageStageProps;
    expect(durablePageStageProps?.editorSessionKey).toBe(previewPageStageProps?.editorSessionKey);
    expect(durablePageStageProps?.retainEditorSession).toBe(true);
  });

  test("page-stage preview close control does not pin before closing", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();
    await settleAsyncRender();

    const props = (globalThis as { __lastDatabaseViewSurfaceProps?: Record<string, unknown> })
      .__lastDatabaseViewSurfaceProps;
    expect(typeof props?.openPageStage).toBe("function");
    await act(async () => {
      await (
        props?.openPageStage as (
          projectId: string,
          pageId: string,
          title?: string,
        ) => Promise<void> | void
      )("alpha", "card-1", "Card One");
    });
    await settleAsyncRender();
    await settleAsyncRender();
    expect(
      screen.container.querySelector('[data-app-shell-tabpanel-preview="true"]') !== null,
    ).toBe(true);

    setInvokeCalls([]);
    await pointerActivate(screen.getByRole("button", { name: "Close" }));
    expect(invokeCalls.some((call) => call[0] === "window-session-view:tab-create")).toBe(false);
  });

  test("page-stage preview delete control does not pin before deleting", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();
    await settleAsyncRender();

    const props = (globalThis as { __lastDatabaseViewSurfaceProps?: Record<string, unknown> })
      .__lastDatabaseViewSurfaceProps;
    expect(typeof props?.openPageStage).toBe("function");
    await act(async () => {
      await (
        props?.openPageStage as (
          projectId: string,
          pageId: string,
          title?: string,
        ) => Promise<void> | void
      )("alpha", "card-1", "Card One");
    });
    await settleAsyncRender();
    await settleAsyncRender();
    expect(
      screen.container.querySelector('[data-app-shell-tabpanel-preview="true"]') !== null,
    ).toBe(true);

    setInvokeCalls([]);
    await pointerActivate(screen.getByRole("button", { name: "Delete" }));
    expect(invokeCalls.some((call) => call[0] === "window-session-view:tab-create")).toBe(false);
    expect(
      (globalThis as { __mockPageStageDeleteClicks?: number }).__mockPageStageDeleteClicks,
    ).toBe(1);
  });

  test("replaces the current page-stage preview when another DB card opens", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();
    await settleAsyncRender();

    const props = (globalThis as { __lastDatabaseViewSurfaceProps?: Record<string, unknown> })
      .__lastDatabaseViewSurfaceProps;
    expect(typeof props?.openPageStage).toBe("function");
    await act(async () => {
      await (
        props?.openPageStage as (
          projectId: string,
          pageId: string,
          title?: string,
        ) => Promise<void> | void
      )("alpha", "card-1", "Card One");
    });
    await settleAsyncRender();

    await act(async () => {
      await (
        props?.openPageStage as (
          projectId: string,
          pageId: string,
          title?: string,
        ) => Promise<void> | void
      )("alpha", "card-2", "Card Two");
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await waitFor(() => {
      expect(screen.queryByRole("tab", { name: "Card One" })).toBe(null);
    });
    const tab = screen.getByRole("tab", { name: "Card Two" });
    expect(tab.closest('[data-app-shell-tab-preview="true"]') !== null).toBe(true);
    expect(invokeCalls.some((call) => call[0] === "window-session-view:tab-create")).toBe(false);
  });

  test("renders cross-project page-stage tabs from their target project", async () => {
    const session = makeSession({
      rightLayout: makePanelLayout(["db-tab", "card-tab"], "card-tab"),
      tabs: [
        {
          id: "db-tab",
          sessionId: "session:alpha:database-view",
          projectId: "alpha",
          kind: "db_view",
          title: "DB View",
          panelId: "right",
          config: { projectId: "alpha" },
        },
        {
          id: "card-tab",
          sessionId: "session:alpha:database-view",
          projectId: "alpha",
          kind: "page_stage",
          title: "Beta Card",
          panelId: "right",
          config: { projectId: "beta", pageId: "card-beta", titleSnapshot: "Beta Card" },
        },
      ],
    });

    renderWorkbench({
      projects: [
        makeProject("alpha", "Alpha", "/Users/asc/repo/alpha"),
        makeProject("beta", "Beta", "/Users/asc/repo/beta"),
      ],
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const pageStageProps = (globalThis as { __lastPageStageProps?: Record<string, unknown> })
      .__lastPageStageProps;
    const pageModel = pageStageProps?.page as
      | {
          page?: { id?: string };
        }
      | undefined;
    const documentAuthority = pageStageProps?.documentAuthority as
      | {
          kind?: string;
          descriptor?: {
            accessContext?: { kind: string; projectId?: string };
            ownerBlockId?: string;
          };
        }
      | undefined;
    expect(pageModel?.page?.id).toBe("card-beta");
    expect(documentAuthority?.kind).toBe("yjs");
    expect(documentAuthority?.descriptor?.accessContext).toEqual({
      kind: "project",
      projectId: "beta",
    });
    expect(documentAuthority?.descriptor?.ownerBlockId).toBe("card-beta");
  });

  test("page-stage editor can start a new thread in the current blank session", async () => {
    const session = makeBlankSession({
      id: "session:alpha:card-empty",
      tabs: [
        {
          id: "card-tab",
          sessionId: "session:alpha:card-empty",
          projectId: "alpha",
          kind: "page_stage",
          title: "Card One",
          panelId: "right",
          config: { projectId: "alpha", pageId: "card-1", titleSnapshot: "Card One" },
        },
      ],
      panels: makePanels({
        rightTabIds: ["card-tab"],
        rightActiveTabId: "card-tab",
      }),
    });

    renderWorkbench({
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const pageStageProps = (globalThis as { __lastPageStageProps?: Record<string, unknown> })
      .__lastPageStageProps;
    expect(pageStageProps?.sessionId).toBe("session:alpha:card-empty");
    expect(pageStageProps?.canStartThreadInSession).toBe(true);
    const startThread = pageStageProps?.onStartNewSessionThreadFromEditor as
      | ((input: {
          projectId: string;
          targetSessionId?: string;
          prompt: string;
        }) => Promise<{ threadId: string; sessionId?: string }>)
      | undefined;
    if (!startThread) {
      throw new Error("missing page-stage start-thread callback");
    }

    let result: { threadId: string; sessionId?: string } | null = null;
    await act(async () => {
      result = await startThread({
        projectId: "alpha",
        targetSessionId: "session:alpha:card-empty",
        prompt: "Send selected blocks",
      });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(JSON.stringify(result)).toBe(
      JSON.stringify({
        threadId: "thread-started",
        sessionId: "session:alpha:card-empty",
      }),
    );
    expect(startThreadForSessionCalls.length).toBe(1);
    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "page-chats:link" &&
          call[1] === "session:alpha:card-empty" &&
          JSON.stringify(call[2]) ===
            JSON.stringify({ pageAccessProjectId: "alpha", pageId: "card-1" }),
      ),
    ).toBe(true);
    const startInput = startThreadForSessionCalls[0] as {
      readonly firstSubmission?: {
        readonly launchId?: string;
        readonly clientUserMessageId?: string;
      };
    };
    expect(isUuidV7(startInput.firstSubmission?.launchId ?? "")).toBe(true);
    expect(isUuidV7(startInput.firstSubmission?.clientUserMessageId ?? "")).toBe(true);
    expect(startInput).toMatchObject({
      projectId: "alpha",
      sessionId: "session:alpha:card-empty",
      prompt: "Send selected blocks",
      skipAutoTitleGeneration: false,
      runInTarget: "localProject",
    });
    expect(invokeCalls.some((call) => call[0] === "project-sessions:create")).toBe(false);
  });

  test("projects Session-anchored Linked chats into Page Stage and unlinks explicitly", async () => {
    const session = makeBlankSession({
      id: "session:alpha:page-related-chats",
      tabs: [
        {
          id: "card-tab",
          sessionId: "session:alpha:page-related-chats",
          projectId: "alpha",
          kind: "page_stage",
          title: "Card One",
          panelId: "right",
          config: { projectId: "alpha", pageId: "card-1", titleSnapshot: "Card One" },
        },
      ],
      panels: makePanels({ rightTabIds: ["card-tab"], rightActiveTabId: "card-tab" }),
    });
    setPageChatItems([
      {
        sessionId: "session:alpha:related-threadless",
        projectId: "alpha",
        projectName: "Alpha",
        displayTitle: "Research follow-up",
        threadId: null,
        threadPreview: "",
        threadStatus: null,
        threadArchived: false,
        unread: false,
        sessionArchived: false,
        conversationRecencyAt: null,
        linkedAt: "2026-08-24T00:00:00Z",
      },
    ]);
    renderWorkbench({
      sessionsByProject: {
        alpha: [session, makeBlankSession({ id: "session:alpha:related-threadless" })],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const pageStageProps = (globalThis as { __lastPageStageProps?: Record<string, unknown> })
      .__lastPageStageProps;
    await waitFor(() => {
      expect(pageStageProps?.relatedChats).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: "session:alpha:related-threadless",
            threadId: null,
          }),
        ]),
      );
    });
    const remove = pageStageProps?.onRemoveRelatedChat as
      | ((sessionId: string) => Promise<void>)
      | undefined;
    if (!remove) throw new Error("missing Page Stage unlink callback");
    setInvokeCalls([]);
    await act(async () => {
      await remove("session:alpha:related-threadless");
      await Promise.resolve();
    });
    expect(invokeCalls[0]).toEqual([
      "page-chats:unlink",
      "session:alpha:related-threadless",
      { pageAccessProjectId: "alpha", pageId: "card-1" },
    ]);
  });

  test("page-stage thread sections durably relate their target Chat before sending", async () => {
    const session = makeAttachedSession({
      id: "session:alpha:card-thread-section",
      threadId: "thread-section-target",
      tabs: [
        {
          id: "card-tab",
          sessionId: "session:alpha:card-thread-section",
          projectId: "alpha",
          kind: "page_stage",
          title: "Card One",
          panelId: "right",
          config: { projectId: "alpha", pageId: "card-1", titleSnapshot: "Card One" },
        },
      ],
      panels: makePanels({ rightTabIds: ["card-tab"], rightActiveTabId: "card-tab" }),
    });
    renderWorkbench({ sessionsByProject: { alpha: [session] } });
    await settleAsyncRender();
    await settleAsyncRender();

    const pageStageProps = (globalThis as { __lastPageStageProps?: Record<string, unknown> })
      .__lastPageStageProps;
    const sendSection = pageStageProps?.onSendThreadSectionPrompt as
      | ((input: {
          projectId: string;
          threadId: string;
          prompt: string;
          promptInput?: { text: string };
        }) => Promise<void>)
      | undefined;
    if (!sendSection) throw new Error("missing page-stage section send callback");
    setInvokeCalls([]);

    await act(async () => {
      await sendSection({
        projectId: "alpha",
        threadId: "thread-section-target",
        prompt: "Run this section",
        promptInput: { text: "Run this section" },
      });
      await Promise.resolve();
    });

    expect(invokeCalls[0]).toEqual([
      "page-chats:link",
      "session:alpha:card-thread-section",
      { pageAccessProjectId: "alpha", pageId: "card-1" },
    ]);
    expect(startTurnCalls).toEqual([
      [
        "thread-section-target",
        "Run this section",
        { projectId: "alpha", promptInput: { text: "Run this section" } },
      ],
    ]);
  });

  test("page-stage editor can open a mentioned thread session", async () => {
    const session = makeAttachedSession({
      id: "session:alpha:card-open-source",
      threadId: "thread-source",
      tabs: [
        {
          id: "card-tab",
          sessionId: "session:alpha:card-open-source",
          projectId: "alpha",
          kind: "page_stage",
          title: "Card One",
          panelId: "right",
          config: { projectId: "alpha", pageId: "card-1", titleSnapshot: "Card One" },
        },
      ],
      panels: makePanels({
        rightTabIds: ["card-tab"],
        rightActiveTabId: "card-tab",
      }),
    });

    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const pageStageProps = (globalThis as { __lastPageStageProps?: Record<string, unknown> })
      .__lastPageStageProps;
    const openThread = pageStageProps?.onOpenCodexThread as
      | ((threadId: string) => Promise<void>)
      | undefined;
    expect(typeof openThread).toBe("function");
    if (!openThread) return;

    await act(async () => {
      await openThread("thread-mentioned");
      await Promise.resolve();
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(
      invokeCalls.some(
        (call) => call[0] === "codex:thread:ensure-session" && call[1] === "thread-mentioned",
      ),
    ).toBe(true);
    expect(
      getThreadRow(screen.container, "Mention target").getAttribute(
        "data-app-action-sidebar-thread-active",
      ),
    ).toBe("true");
  });

  test("labels cross-project page-stage tabs with their target project", async () => {
    const session = makeSession({
      tabs: [
        {
          id: "db-tab",
          sessionId: "session:alpha:database-view",
          projectId: "alpha",
          kind: "db_view",
          title: "DB View",
          panelId: "right",
          config: { projectId: "alpha" },
        },
        {
          id: "card-tab",
          sessionId: "session:alpha:database-view",
          projectId: "alpha",
          kind: "page_stage",
          title: "Stale Beta Card",
          panelId: "right",
          config: { projectId: "beta", pageId: "card-beta", titleSnapshot: "Stale Beta Card" },
        },
      ],
      rightLayout: makePanelLayout(["db-tab", "card-tab"], "card-tab"),
    });

    const screen = renderWorkbench({
      projects: [
        makeProject("alpha", "Alpha", "/Users/asc/repo/alpha"),
        makeProject("beta", "Beta", "/Users/asc/repo/beta"),
      ],
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(screen.getByRole("tab", { name: "Beta project, Beta Card" }) !== null).toBe(true);
    expect(
      screen.container.querySelector('[data-app-shell-tab-context-label="card-tab"]')?.textContent,
    ).toBe("Beta");
    expect(screen.getByLabelText("Close Beta project, Beta Card tab") !== null).toBe(true);

    const pageStageProps = (
      globalThis as {
        __mockPageStagePropsByPageId?: Record<string, Record<string, unknown>>;
      }
    ).__mockPageStagePropsByPageId?.["card-beta"];
    const publishLiveTitle = pageStageProps?.__publishPageTitle as
      | ((title: string) => void)
      | undefined;
    const disposeLiveTitle = pageStageProps?.__disposePageTitlePublisher as
      | (() => void)
      | undefined;
    expect(typeof publishLiveTitle).toBe("function");
    expect(typeof disposeLiveTitle).toBe("function");
    if (!publishLiveTitle || !disposeLiveTitle) return;

    setInvokeCalls([]);
    await act(async () => {
      publishLiveTitle("Renamed card");
      await Promise.resolve();
    });

    expect(screen.getByRole("tab", { name: "Beta project, Renamed card" }) !== null).toBe(true);
    expect(screen.getByLabelText("Close Beta project, Renamed card tab") !== null).toBe(true);
    const renamedTitle = screen.container.querySelector('[data-app-shell-tab-title="card-tab"]');
    expect(renamedTitle?.textContent).toBe("Renamed card");
    if (!(renamedTitle instanceof HTMLElement)) throw new Error("Expected renamed card tab title");
    if (!(renamedTitle.parentElement instanceof HTMLElement)) {
      throw new Error("Expected renamed card tooltip trigger");
    }
    vi.useFakeTimers();
    try {
      fireEvent.pointerMove(renamedTitle.parentElement, { pointerType: "mouse" });
      fireEvent.mouseEnter(renamedTitle.parentElement);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
    } finally {
      vi.useRealTimers();
    }
    const renamedTooltip = screen.container.ownerDocument.body.querySelector('[role="tooltip"]');
    expect(renamedTooltip?.textContent).toContain("Renamed card");
    expect(renamedTooltip?.textContent).toContain("Project: Beta");

    await act(async () => {
      disposeLiveTitle();
      await Promise.resolve();
    });
    expect(screen.getByRole("tab", { name: "Beta project, Renamed card" }) !== null).toBe(true);

    await act(async () => {
      publishLiveTitle("   ");
      await Promise.resolve();
    });
    expect(screen.getByRole("tab", { name: "Beta project, Untitled" }) !== null).toBe(true);
    expect(
      screen.container.querySelector('[data-app-shell-tab-title="card-tab"]')?.textContent,
    ).toBe("Untitled");
    await act(async () => {
      disposeLiveTitle();
      await Promise.resolve();
    });
    expect(screen.getByRole("tab", { name: "Beta project, Untitled" }) !== null).toBe(true);
    expect(invokeCalls.some((call) => call[0] === "window-session-view:tab-update")).toBe(false);
  });

  test("projects one live Page title across every matching tab and the Pages sidebar", async () => {
    const session = makeSession({
      tabs: [
        {
          id: "page-tab:first",
          sessionId: "session:alpha:database-view",
          projectId: "alpha",
          kind: "page_stage",
          title: "Card One",
          panelId: "right",
          config: {
            projectId: "alpha",
            pageId: "card-1",
            titleSnapshot: "Card One",
          },
        },
        {
          id: "page-tab:second",
          sessionId: "session:alpha:database-view",
          projectId: "alpha",
          kind: "page_stage",
          title: "Stale duplicate",
          panelId: "right",
          config: {
            projectId: "alpha",
            pageId: "card-1",
            titleSnapshot: "Stale duplicate",
          },
        },
      ],
      rightLayout: makePanelLayout(["page-tab:first", "page-tab:second"], "page-tab:second"),
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
      libraryRoots: [
        {
          kind: "page",
          pageId: "card-1",
          title: "Card One",
          hasChildren: false,
          parentRevision: 1,
          metadataRevision: 1,
          documentGeneration: 1,
          documentHeadSeq: 1,
          updatedAt: "2026-08-11T00:00:00.000Z",
        },
      ],
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const pageStageProps = (
      globalThis as {
        __mockPageStagePropsByPageId?: Record<string, Record<string, unknown>>;
      }
    ).__mockPageStagePropsByPageId?.["card-1"];
    const publishLiveTitle = pageStageProps?.__publishPageTitle as
      | ((title: string) => void)
      | undefined;
    expect(typeof publishLiveTitle).toBe("function");
    if (!publishLiveTitle) return;

    await act(async () => {
      publishLiveTitle("Renamed everywhere");
      await Promise.resolve();
    });

    expect(
      screen.container.querySelector('[data-app-shell-tab-title="page-tab:first"]')?.textContent,
    ).toBe("Renamed everywhere");
    expect(
      screen.container.querySelector('[data-app-shell-tab-title="page-tab:second"]')?.textContent,
    ).toBe("Renamed everywhere");
    expect(
      within(screen.getByRole("list", { name: "Pages" })).getByText("Renamed everywhere"),
    ).not.toBeNull();
  });

  test("keeps the observed Page title when tab switching unmounts the editor body", async () => {
    const session = makeSession({
      tabs: [
        {
          id: "db-tab",
          sessionId: "session:alpha:database-view",
          projectId: "alpha",
          kind: "db_view",
          title: "DB View",
          panelId: "right",
          config: { projectId: "alpha" },
        },
        {
          id: "page-tab",
          sessionId: "session:alpha:database-view",
          projectId: "alpha",
          kind: "page_stage",
          title: "Card One",
          panelId: "right",
          config: { projectId: "alpha", pageId: "card-1", titleSnapshot: "Card One" },
        },
      ],
      rightLayout: makePanelLayout(["db-tab", "page-tab"], "page-tab"),
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const pageStageProps = (
      globalThis as {
        __mockPageStagePropsByPageId?: Record<string, Record<string, unknown>>;
      }
    ).__mockPageStagePropsByPageId?.["card-1"];
    const publishLiveTitle = pageStageProps?.__publishPageTitle as
      | ((title: string) => void)
      | undefined;
    if (!publishLiveTitle) throw new Error("Expected live Page title publisher");

    await act(async () => {
      publishLiveTitle("Renamed while open");
      await Promise.resolve();
    });
    expect(screen.getByRole("tab", { name: "Renamed while open", selected: true })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "DB View" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(screen.getByRole("tab", { name: "DB View", selected: true })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Renamed while open" })).toBeTruthy();
    expect(
      (globalThis as { __mockPageStageUnmountsByPageId?: Record<string, number> })
        .__mockPageStageUnmountsByPageId?.["card-1"],
    ).toBeGreaterThan(0);
  });

  test("keeps same-project page-stage tabs unprefixed while preserving default title tooltips", async () => {
    const session = makeSession({
      tabs: [
        {
          id: "card-tab",
          sessionId: "session:alpha:database-view",
          projectId: "alpha",
          kind: "page_stage",
          title: "Card One",
          panelId: "right",
          config: { projectId: "alpha", pageId: "card-1", titleSnapshot: "Card One" },
        },
      ],
    });

    const screen = renderWorkbench({
      projects: [makeProject("alpha", "Alpha", "/Users/asc/repo/alpha")],
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(screen.getByRole("tab", { name: "Card One" }) !== null).toBe(true);
    expect(
      screen.container.querySelector('[data-app-shell-tab-context-label="card-tab"]') === null,
    ).toBe(true);

    const tabTitle = screen.container.querySelector('[data-app-shell-tab-title="card-tab"]');
    if (!(tabTitle instanceof HTMLElement)) throw new Error("Expected card tab title");
    if (!(tabTitle.parentElement instanceof HTMLElement)) {
      throw new Error("Expected card tooltip trigger");
    }
    vi.useFakeTimers();
    try {
      fireEvent.pointerMove(tabTitle.parentElement, { pointerType: "mouse" });
      fireEvent.mouseEnter(tabTitle.parentElement);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
    } finally {
      vi.useRealTimers();
    }

    const tooltip = screen.container.ownerDocument.body.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toBe("Card One");
  });

  test("opens terminals from cross-project card tabs in the owning session workspace", async () => {
    const session = makeSession({
      tabs: [
        {
          id: "card-tab",
          sessionId: "session:alpha:database-view",
          projectId: "alpha",
          kind: "page_stage",
          title: "Beta Card",
          panelId: "right",
          config: { projectId: "beta", pageId: "card-beta", titleSnapshot: "Beta Card" },
        },
      ],
    });
    const screen = renderWorkbench({
      projects: [
        makeProject("alpha", "Alpha", "/Users/asc/repo/alpha"),
        makeProject("beta", "Beta", "/Users/asc/repo/beta"),
      ],
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(
      invokeCalls.some((call) => {
        const input = call[1] as
          | {
              sessionId?: string;
              panelId?: string;
              kind?: string;
              config?: { terminalSessionId?: string };
            }
          | undefined;
        return (
          call[0] === "window-session-view:tab-create" &&
          input?.sessionId === "session:alpha:database-view" &&
          !("projectId" in input) &&
          input.panelId === "bottom" &&
          input.kind === "terminal" &&
          input.config !== undefined &&
          !("projectId" in input.config) &&
          typeof input.config.terminalSessionId === "string" &&
          input.config.terminalSessionId.startsWith("session:session:alpha:database-view:terminal:")
        );
      }),
    ).toBe(true);
    expect(getLastTerminalPanelProps()?.cwd).toBe("/Users/asc/repo/alpha");
  });

  test("shows a page-stage skeleton while card detail hydration is pending", async () => {
    let resolveCardDetail!: (value: unknown) => void;
    const pendingCardDetail = new Promise<unknown>((resolve) => {
      resolveCardDetail = resolve;
    });
    const session = makeSession({
      tabs: [
        {
          id: "card-tab",
          sessionId: "session:alpha:database-view",
          projectId: "alpha",
          kind: "page_stage",
          title: "Card One",
          panelId: "right",
          config: { projectId: "alpha", pageId: "card-1", titleSnapshot: "Card One" },
        },
      ],
    });
    const screen = renderWorkbench({
      projects: [makeProject("alpha", "Alpha")],
      sessionsByProject: { alpha: [session] },
      cardGetOverride: (_projectId, pageId) =>
        pageId === "card-1" ? pendingCardDetail : undefined,
    });
    await settleAsyncRender();

    const loadingShell = await screen.findByRole("status", {
      name: "Loading Card One",
    });
    expect(loadingShell !== null).toBe(true);
    expect(within(loadingShell).queryByRole("button", { name: "Close" })).toBeNull();
    expect(
      within(loadingShell).getByRole("button", { name: "Page actions" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      within(loadingShell).getByRole("button", { name: "History" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.queryByText("Page not found") === null).toBe(true);
    expect(screen.queryByText("Page:card-1") === null).toBe(true);

    await act(async () => {
      resolveCardDetail({
        id: "card-1",
        projectId: "alpha",
        status: "build",
        title: "Card One",
        description: "",
        tags: [],
        archived: false,
        created: new Date("2026-06-07T00:00:00.000Z"),
        order: 0,
        revision: 1,
      });
      await pendingCardDetail;
    });
    await settleAsyncRender();

    expect((await screen.findByText("Page:card-1")) !== null).toBe(true);
    await waitFor(() => {
      expect(screen.queryByRole("status", { name: "Loading Card One" })).toBeNull();
    });
    expect(screen.queryByText("Page not found") === null).toBe(true);
  });

  test("opens a Document-parented Card without requiring a Database row", async () => {
    const session = makeSession({
      tabs: [
        {
          id: "nested-card-tab",
          sessionId: "session:alpha:database-view",
          projectId: "alpha",
          kind: "page_stage",
          title: "Nested Card",
          panelId: "right",
          config: {
            projectId: "alpha",
            pageId: "nested-card",
            titleSnapshot: "Nested Card",
          },
        },
      ],
    });
    const screen = renderWorkbench({
      projects: [makeProject("alpha", "Alpha")],
      sessionsByProject: { alpha: [session] },
      cardGetOverride: (_projectId, pageId) =>
        pageId === "nested-card"
          ? {
              id: pageId,
              title: "Nested Card",
              description: "Independent body",
              archived: false,
              created: new Date("2026-07-14T00:00:00.000Z"),
              revision: 2,
              standalone: true,
            }
          : undefined,
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(screen.getByText("Page:nested-card") !== null).toBe(true);
    const props = (
      globalThis as {
        __mockPageStagePropsByPageId?: Record<string, Record<string, unknown>>;
      }
    ).__mockPageStagePropsByPageId?.["nested-card"];
    const model = props?.page as
      | {
          databaseContext?: { kind?: string };
        }
      | undefined;
    expect(model?.databaseContext?.kind).toBe("standalone");
    expect(props?.onDelete).toBeUndefined();
    expect(props?.onMove).toBeUndefined();
  });

  test("projects the current ownership path into the Page Stage breadcrumb", async () => {
    const session = makeSession({
      tabs: [
        {
          id: "nested-page-tab",
          sessionId: "session:alpha:database-view",
          projectId: "alpha",
          kind: "page_stage",
          title: "Nested Page",
          panelId: "right",
          config: {
            projectId: "alpha",
            pageId: "nested-page",
            titleSnapshot: "Nested Page",
          },
        },
      ],
    });
    renderWorkbench({
      projects: [makeProject("alpha", "Alpha")],
      sessionsByProject: { alpha: [session] },
      ownershipPathsByPage: {
        "nested-page": [
          {
            pageId: "actual-parent",
            title: "Actual Parent",
            lifecycle: "active",
          },
        ],
      },
      cardGetOverride: (_projectId, pageId) => ({
        id: pageId,
        title: "Nested Page",
        description: "Page body",
        archived: false,
        agentBlocked: false,
        created: new Date("2026-07-14T00:00:00.000Z"),
        revision: 2,
        standalone: true,
      }),
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await waitFor(() => {
      const props = (
        globalThis as {
          __mockPageStagePropsByPageId?: Record<string, Record<string, unknown>>;
        }
      ).__mockPageStagePropsByPageId?.["nested-page"];
      expect(props?.breadcrumb).toMatchObject({
        ancestors: [
          {
            projectId: "alpha",
            pageId: "actual-parent",
            title: "Actual Parent",
            disabled: false,
          },
        ],
      });
    });
  });

  test("opens a referenced Page without persisting interaction ancestry", async () => {
    const rightLayout = splitWorkbenchPanelLeaf(
      makePanelLayout(["parent-card-tab", "browser-tab"], "parent-card-tab"),
      {
        leafId: "main",
        side: "right",
        tabId: "browser-tab",
        newLeafId: "leaf:browser",
        newBranchId: "branch:root",
      },
    );
    const session = makeSession({
      rightLayout,
      tabs: [
        {
          id: "parent-card-tab",
          sessionId: "session:alpha:database-view",
          projectId: "alpha",
          kind: "page_stage",
          title: "Parent Card",
          panelId: "right",
          config: {
            projectId: "alpha",
            pageId: "parent-card",
            titleSnapshot: "Parent Card",
          },
        },
        {
          id: "browser-tab",
          sessionId: "session:alpha:database-view",
          projectId: "alpha",
          kind: "browser",
          title: "Browser",
          panelId: "right",
          config: { projectId: "alpha" },
        },
      ],
    });
    renderWorkbench({
      projects: [makeProject("alpha", "Alpha")],
      sessionsByProject: { alpha: [session] },
      cardGetOverride: (_projectId, pageId) =>
        ["parent-card", "nested-card"].includes(pageId)
          ? {
              id: pageId,
              title: pageId === "parent-card" ? "Parent Card" : "Nested Card",
              description: "Page body",
              archived: false,
              agentBlocked: false,
              created: new Date("2026-07-14T00:00:00.000Z"),
              revision: 2,
              standalone: true,
            }
          : undefined,
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const props = (
      globalThis as {
        __mockPageStagePropsByPageId?: Record<string, Record<string, unknown>>;
      }
    ).__mockPageStagePropsByPageId?.["parent-card"];
    const onOpenPage = props?.onOpenPage as
      | ((input: {
          accessContext: { kind: "project"; projectId: string };
          pageId: string;
          titleSnapshot?: string;
        }) => void)
      | undefined;
    expect(typeof onOpenPage).toBe("function");

    setInvokeCalls([]);
    await act(async () => {
      onOpenPage?.({
        accessContext: { kind: "project", projectId: "alpha" },
        pageId: "nested-card",
        titleSnapshot: "Nested Card",
      });
      await Promise.resolve();
    });
    await settleAsyncRender();

    const createCall = invokeCalls.find((call) => call[0] === "window-session-view:tab-create");
    const input = createCall?.[1] as
      | {
          config?: {
            accessContext?: {
              kind: "project";
              projectId: string;
            };
            pageId?: string;
          };
          targetLeafId?: string;
        }
      | undefined;
    expect(input?.config).toEqual({
      accessContext: { kind: "project", projectId: "alpha" },
      pageId: "nested-card",
      titleSnapshot: "Nested Card",
    });
    expect(input?.targetLeafId).toBe("main");
    const nestedProps = (
      globalThis as {
        __mockPageStagePropsByPageId?: Record<string, Record<string, unknown>>;
      }
    ).__mockPageStagePropsByPageId?.["nested-card"];
    expect(nestedProps?.breadcrumb).toBeUndefined();
  });

  test("opens a Canvas Page in the Canvas tab group", async () => {
    const rightLayout = splitWorkbenchPanelLeaf(
      makePanelLayout(["canvas-tab", "browser-tab"], "canvas-tab"),
      {
        leafId: "main",
        side: "right",
        tabId: "browser-tab",
        newLeafId: "leaf:browser",
        newBranchId: "branch:root",
      },
    );
    const session = makeSession({
      rightLayout,
      tabs: [
        {
          id: "canvas-tab",
          sessionId: "session:alpha:database-view",
          projectId: "alpha",
          kind: "canvas_stage",
          title: "Canvas",
          panelId: "right",
          config: {
            projectId: "alpha",
            canvasBlockId: "canvas-1",
            titleSnapshot: "Canvas",
          },
        },
        {
          id: "browser-tab",
          sessionId: "session:alpha:database-view",
          projectId: "alpha",
          kind: "browser",
          title: "Browser",
          panelId: "right",
          config: { projectId: "alpha" },
        },
      ],
    });
    renderWorkbench({ sessionsByProject: { alpha: [session] } });
    await settleAsyncRender();
    await settleAsyncRender();

    const canvasProps = (
      globalThis as {
        __lastWorkbenchCanvasStagePanelProps?: Record<string, unknown>;
      }
    ).__lastWorkbenchCanvasStagePanelProps;
    const onOpenPage = canvasProps?.onOpenPage as
      | ((input: { pageId: string; titleSnapshot?: string }) => void)
      | undefined;
    expect(typeof onOpenPage).toBe("function");

    setInvokeCalls([]);
    await act(async () => {
      onOpenPage?.({ pageId: "canvas-page", titleSnapshot: "Canvas Page" });
      await Promise.resolve();
    });
    await settleAsyncRender();

    const createCall = invokeCalls.find((call) => call[0] === "window-session-view:tab-create");
    const input = createCall?.[1] as
      | { targetLeafId?: string; config?: { pageId?: string } }
      | undefined;
    expect(input?.targetLeafId).toBe("main");
    expect(input?.config?.pageId).toBe("canvas-page");
  });

  test("renders Page detail load failures as load errors instead of missing pages", async () => {
    const session = makeSession({
      tabs: [
        {
          id: "card-tab",
          sessionId: "session:alpha:database-view",
          projectId: "alpha",
          kind: "page_stage",
          title: "Card One",
          panelId: "right",
          config: { projectId: "alpha", pageId: "card-1", titleSnapshot: "Card One" },
        },
      ],
    });
    const screen = renderWorkbench({
      projects: [makeProject("alpha", "Alpha")],
      sessionsByProject: { alpha: [session] },
      cardGetOverride: (_projectId, pageId) => {
        if (pageId !== "card-1") return undefined;
        throw new Error("Database is unavailable");
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(screen.getByText("Could not load Page") !== null).toBe(true);
    expect(screen.getByText(/Database is unavailable/) !== null).toBe(true);
    expect(screen.queryByText("Page not found") === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Close tab" }) === null).toBe(true);
  });

  test("renders a missing page-stage state instead of a blank tab", async () => {
    const session = makeSession({
      tabs: [
        {
          id: "card-tab",
          sessionId: "session:alpha:database-view",
          projectId: "alpha",
          kind: "page_stage",
          title: "Missing Beta Card",
          panelId: "right",
          config: { projectId: "beta", pageId: "missing-card", titleSnapshot: "Missing Beta Card" },
        },
      ],
    });
    const screen = renderWorkbench({
      projects: [makeProject("alpha", "Alpha"), makeProject("beta", "Beta")],
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(screen.getByText("Page not found") !== null).toBe(true);
    expect(screen.getByRole("button", { name: "Close tab" }) !== null).toBe(true);
    expect(screen.queryByText("Page:missing") === null).toBe(true);
  });

  test("falls back to the content project id when a cross-project Page tab project is missing", async () => {
    const session = makeSession({
      tabs: [
        {
          id: "card-tab",
          sessionId: "session:alpha:database-view",
          projectId: "alpha",
          kind: "page_stage",
          title: "Beta Card",
          panelId: "right",
          config: { projectId: "beta", pageId: "card-beta", titleSnapshot: "Beta Card" },
        },
      ],
    });

    const screen = renderWorkbench({
      projects: [makeProject("alpha", "Alpha")],
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(screen.getByRole("tab", { name: "beta project, Beta Card" }) !== null).toBe(true);
    expect(
      screen.container.querySelector('[data-app-shell-tab-context-label="card-tab"]')?.textContent,
    ).toBe("beta");
  });

  test("marks pages active in the database view when selected Page Stage tabs are visible", async () => {
    const rightLayout = splitWorkbenchPanelLeaf(makePanelLayout(["db-tab", "card-tab"], "db-tab"), {
      leafId: "main",
      side: "right",
      tabId: "card-tab",
      newLeafId: "leaf:card",
      newBranchId: "branch:root",
    });
    const panels = makePanels({
      rightTabIds: ["db-tab", "card-tab"],
      rightActiveTabId: "db-tab",
      rightFullWidth: false,
    });

    renderWorkbench({
      sessionsByProject: {
        alpha: [
          makeSession({
            panels: {
              ...panels,
              right: {
                ...panels.right,
                layout: rightLayout,
              },
            },
            tabs: [
              {
                id: "db-tab",
                sessionId: "session:alpha:database-view",
                projectId: "alpha",
                kind: "db_view",
                title: "DB View",
                panelId: "right",
                config: { projectId: "alpha" },
              },
              {
                id: "card-tab",
                sessionId: "session:alpha:database-view",
                projectId: "alpha",
                kind: "page_stage",
                title: "Card One",
                panelId: "right",
                config: { projectId: "alpha", pageId: "card-1", titleSnapshot: "Card One" },
              },
            ],
          }),
        ],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const props = (globalThis as { __lastDatabaseViewSurfaceProps?: Record<string, unknown> })
      .__lastDatabaseViewSurfaceProps;
    const activePageIds = props?.presentedPageIds as ReadonlySet<string> | undefined;
    expect(activePageIds?.has("card-1") ?? false).toBe(true);
  });

  test("marks pages active in the database view when a Page Stage preview is visible", async () => {
    const rightLayout = splitWorkbenchPanelLeaf(
      makePanelLayout(["db-tab", "browser-tab"], "db-tab"),
      {
        leafId: "main",
        side: "right",
        tabId: "browser-tab",
        newLeafId: "leaf:browser",
        newBranchId: "branch:root",
      },
    );
    const panels = makePanels({
      rightTabIds: ["db-tab", "browser-tab"],
      rightActiveTabId: "db-tab",
      rightFullWidth: false,
    });

    renderWorkbench({
      sessionsByProject: {
        alpha: [
          makeSession({
            panels: {
              ...panels,
              right: {
                ...panels.right,
                layout: rightLayout,
              },
            },
            tabs: [
              {
                id: "db-tab",
                sessionId: "session:alpha:database-view",
                projectId: "alpha",
                kind: "db_view",
                title: "DB View",
                panelId: "right",
                config: { projectId: "alpha" },
              },
              {
                id: "browser-tab",
                sessionId: "session:alpha:database-view",
                projectId: "alpha",
                kind: "browser",
                title: "Browser",
                panelId: "right",
                config: { projectId: "alpha" },
              },
            ],
          }),
        ],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const props = (globalThis as { __lastDatabaseViewSurfaceProps?: Record<string, unknown> })
      .__lastDatabaseViewSurfaceProps;
    expect(typeof props?.openPageStage).toBe("function");
    await act(async () => {
      await (
        props?.openPageStage as (
          projectId: string,
          pageId: string,
          title?: string,
        ) => Promise<void> | void
      )("alpha", "card-1", "Card One");
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const nextProps = (globalThis as { __lastDatabaseViewSurfaceProps?: Record<string, unknown> })
      .__lastDatabaseViewSurfaceProps;
    const activePageIds = nextProps?.presentedPageIds as ReadonlySet<string> | undefined;
    expect(activePageIds?.has("card-1") ?? false).toBe(true);
  });

  test("does not mark pages active from selected Page Stage tabs in collapsed panels", async () => {
    const panels = makePanels({
      rightTabIds: ["db-tab"],
      rightActiveTabId: "db-tab",
      bottomTabIds: ["card-tab"],
      bottomActiveTabId: "card-tab",
      bottomCollapsed: true,
    });

    renderWorkbench({
      sessionsByProject: {
        alpha: [
          makeSession({
            panels,
            tabs: [
              {
                id: "db-tab",
                sessionId: "session:alpha:database-view",
                projectId: "alpha",
                kind: "db_view",
                title: "DB View",
                panelId: "right",
                config: { projectId: "alpha" },
              },
              {
                id: "card-tab",
                sessionId: "session:alpha:database-view",
                projectId: "alpha",
                kind: "page_stage",
                title: "Card One",
                panelId: "bottom",
                config: { projectId: "alpha", pageId: "card-1", titleSnapshot: "Card One" },
              },
            ],
          }),
        ],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const props = (globalThis as { __lastDatabaseViewSurfaceProps?: Record<string, unknown> })
      .__lastDatabaseViewSurfaceProps;
    const activePageIds = props?.presentedPageIds as ReadonlySet<string> | undefined;
    expect(activePageIds?.has("card-1") ?? false).toBe(false);
  });

  test("focusing an existing Page tab from the database tab preserves full-width right panel mode", async () => {
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [
          makeSession({
            tabs: [
              {
                id: "session:alpha:database-view:db",
                sessionId: "session:alpha:database-view",
                projectId: "alpha",
                kind: "db_view",
                title: "DB View",
                panelId: "right",
                config: { projectId: "alpha" },
              },
              {
                id: "card-tab",
                sessionId: "session:alpha:database-view",
                projectId: "alpha",
                kind: "page_stage",
                title: "Card One",
                panelId: "right",
                config: { projectId: "alpha", pageId: "card-1", titleSnapshot: "Card One" },
              },
            ],
            rightLayout: makePanelLayout(
              ["session:alpha:database-view:db", "card-tab"],
              "session:alpha:database-view:db",
            ),
          }),
        ],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const props = (globalThis as { __lastDatabaseViewSurfaceProps?: Record<string, unknown> })
      .__lastDatabaseViewSurfaceProps;
    expect(typeof props?.openPageStage).toBe("function");
    await act(async () => {
      await (
        props?.openPageStage as (
          projectId: string,
          pageId: string,
          title?: string,
        ) => Promise<void> | void
      )("alpha", "card-1", "Card One");
    });
    await settleAsyncRender();

    expect(invokeCalls.some((call) => call[0] === "window-session-view:tab-create")).toBe(false);
    expect(invokeCalls.some((call) => call[0] === "window-session-view:ensure-right-leaf")).toBe(
      false,
    );
    expect(
      invokeCalls.some((call) => {
        const input = call[3] as { size?: { fullWidth?: boolean } } | undefined;
        return (
          call[0] === "window-session-view:panel-patch" &&
          call[1] === "session:alpha:database-view" &&
          call[2] === "right" &&
          input?.size?.fullWidth === false
        );
      }),
    ).toBe(false);
    expect(screen.queryByRole("button", { name: "Restore panel width" }) !== null).toBe(true);
  });

  test("opens pages from a split database tab in the nearest right tab group", async () => {
    const rightLayout = splitWorkbenchPanelLeaf(
      makePanelLayout(["db-tab", "browser-tab"], "db-tab"),
      {
        leafId: "main",
        side: "right",
        tabId: "browser-tab",
        newLeafId: "leaf:browser",
        newBranchId: "branch:root",
      },
    );
    const panels = makePanels({
      rightTabIds: ["db-tab", "browser-tab"],
      rightActiveTabId: "db-tab",
      rightFullWidth: false,
    });
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [
          makeSession({
            panels: {
              ...panels,
              right: {
                ...panels.right,
                layout: rightLayout,
              },
            },
            tabs: [
              {
                id: "db-tab",
                sessionId: "session:alpha:database-view",
                projectId: "alpha",
                kind: "db_view",
                title: "DB View",
                panelId: "right",
                config: { projectId: "alpha" },
              },
              {
                id: "browser-tab",
                sessionId: "session:alpha:database-view",
                projectId: "alpha",
                kind: "browser",
                title: "Browser",
                panelId: "right",
                config: { projectId: "alpha" },
              },
            ],
          }),
        ],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const props = (globalThis as { __lastDatabaseViewSurfaceProps?: Record<string, unknown> })
      .__lastDatabaseViewSurfaceProps;
    expect(typeof props?.openPageStage).toBe("function");
    await act(async () => {
      await (
        props?.openPageStage as (
          projectId: string,
          pageId: string,
          title?: string,
        ) => Promise<void> | void
      )("alpha", "card-1", "Card One");
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const tab = screen.getByRole("tab", { name: "Card One" });
    expect(tab.closest('[data-app-shell-tab-preview="true"]') !== null).toBe(true);
    expect(tab.closest("[data-panel-tab-row]")?.getAttribute("data-panel-tab-row")).toBe(
      "right:leaf:browser",
    );
    expect(invokeCalls.some((call) => call[0] === "window-session-view:tab-create")).toBe(false);
    expect(invokeCalls.some((call) => call[0] === "window-session-view:ensure-right-leaf")).toBe(
      false,
    );
  });

  test("persists active tab changes through the session API", async () => {
    const session = makeSession({
      tabs: [
        {
          id: "db-tab",
          sessionId: "session-1",
          projectId: "alpha",
          kind: "db_view",
          title: "DB View",
          order: 0,
          config: { projectId: "alpha" },
          createdAt: "2026-06-07T00:00:00.000Z",
          updatedAt: "2026-06-07T00:00:00.000Z",
        },
        {
          id: "terminal-tab",
          sessionId: "session-1",
          projectId: "alpha",
          kind: "terminal",
          title: "Terminal",
          order: 1,
          config: { terminalSessionId: "terminal-1" },
          createdAt: "2026-06-07T00:00:00.000Z",
          updatedAt: "2026-06-07T00:00:00.000Z",
        },
      ],
      id: "session-1",
    });
    const screen = renderWorkbench({ sessionsByProject: { alpha: [session] } });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.mouseDown(screen.getByRole("tab", { name: "Terminal 1" }), { button: 0 });
      await Promise.resolve();
    });

    expect(
      invokeCalls.some((call) => {
        if (call[0] !== "window-session-view:panel-activate") return false;
        const input = call[1] as { sessionId?: string; panelId?: string; tabId?: string };
        return (
          input.sessionId === "session-1" &&
          input.panelId === "bottom" &&
          input.tabId === "terminal-tab"
        );
      }),
    ).toBe(true);
  });

  test("another Project's disclosure expands its chats without switching Session", async () => {
    const beta = makeProject("beta", "Beta");
    const betaSession = makeSession({
      id: "session:beta:database-view",
      projectId: "beta",
      title: "Beta Database View",
      tabs: [
        {
          id: "session:beta:database-view:db",
          sessionId: "session:beta:database-view",
          projectId: "beta",
          kind: "db_view",
          title: "DB View",
          order: 0,
          config: { projectId: "beta" },
          createdAt: "2026-06-07T00:00:00.000Z",
          updatedAt: "2026-06-07T00:00:00.000Z",
        },
      ],
      rightLayout: makePanelLayout(
        ["session:beta:database-view:db"],
        "session:beta:database-view:db",
      ),
    });
    const screen = renderWorkbench({
      projects: [makeProject(), beta],
      sessionsByProject: { alpha: [makeSession()], beta: [betaSession] },
      sidebar: { collapsed: false, width: 300 },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const betaRow = screen.container.querySelector('[data-app-action-sidebar-project-id="beta"]');
    if (!(betaRow instanceof HTMLElement)) {
      throw new Error("Expected Beta project row");
    }
    await act(async () => {
      fireEvent.click(
        within(betaRow).getByRole("button", {
          name: "Expand project",
        }),
      );
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(textContent(screen.container).includes("Beta Database View")).toBe(true);
    expect(textContent(screen.container).includes("DB:beta:board")).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByText("Beta Database View"));
      await Promise.resolve();
    });
    await settleAsyncRender();

    await waitFor(() => {
      expect(textContent(screen.container).includes("DB:beta:board")).toBe(true);
    });
  });

  test("clicking Hide sidebar suppresses immediate edge auto-reveal", async () => {
    const restoreMatchMedia = installMotionEnabledMatchMediaForTest();
    try {
      const screen = renderWorkbench({ sidebar: { collapsed: false, width: 300 } });
      await settleAsyncRender();
      await settleAsyncRender();

      expect(
        screen.container.querySelector('[data-testid="project-session-sidebar"]') !== null,
      ).toBe(true);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
        await Promise.resolve();
      });
      await settleAsyncRender();

      expect(
        screen.container.querySelector('[data-testid="project-session-sidebar"]') !== null,
      ).toBe(true);
      await moveSidebarPointer(12);

      expect(screen.getByRole("button", { name: "Show sidebar" }) !== null).toBe(true);
      expect(screen.container.querySelector('[data-sidebar-hover-trigger="true"]')).toBe(null);
      expect(screen.container.querySelector('[data-testid="app-shell-floating-left-panel"]')).toBe(
        null,
      );
    } finally {
      restoreMatchMedia();
    }
  });

  test("clicking Show sidebar mounts the real sidebar in the first settled render", async () => {
    const screen = renderWorkbench({ sidebar: { collapsed: true, width: 300 } });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(screen.container.querySelector('[data-testid="project-session-sidebar"]')).toBe(null);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(screen.container.querySelector('[data-testid="project-session-sidebar"]') !== null).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: "Hide sidebar" }) !== null).toBe(true);
  });

  test("registered menu and command palette sidebar toggles use the same sidebar motion action", async () => {
    const restoreMatchMedia = installMotionEnabledMatchMediaForTest();
    try {
      const screen = renderWorkbench({ sidebar: { collapsed: false, width: 300 } });
      await settleAsyncRender();
      await settleAsyncRender();

      await act(async () => {
        screen.requestSidebarToggle("menu");
        await Promise.resolve();
      });
      await settleAsyncRender();

      expect(screen.getByRole("button", { name: "Show sidebar" }) !== null).toBe(true);
      expect(
        screen.container.querySelector('[data-testid="project-session-sidebar"]') !== null,
      ).toBe(true);
      expect(
        screen.container.querySelector('[data-testid="floating-project-session-sidebar-shell"]'),
      ).toBe(null);

      await executeCommandPaletteCommand(screen, "toggle sidebar", "Toggle sidebar");

      expect(screen.getByRole("button", { name: "Hide sidebar" }) !== null).toBe(true);
      expect(
        screen.container.querySelector('[data-testid="project-session-sidebar"]') !== null,
      ).toBe(true);
    } finally {
      restoreMatchMedia();
    }
  });

  test("left sidebar resize clamps at Codex minimum before the collapse threshold", async () => {
    const screen = renderWorkbench({ sidebar: { collapsed: false, width: 300 } });
    await settleAsyncRender();
    await settleAsyncRender();

    const sidebar = screen.getByTestId("project-session-sidebar");
    const resizeStrip = screen.getByTestId("sidebar-resize-strip");
    await act(async () => {
      fireEvent.pointerDown(resizeStrip, { button: 0, pointerId: 1, clientX: 300 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 200 });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(screen.container.querySelector('[data-testid="project-session-sidebar"]') !== null).toBe(
      true,
    );
    expect(sidebar.getAttribute("style")?.includes("width: 240px")).toBe(true);
    expect(screen.queryAllByRole("button", { name: "Hide sidebar" }).length > 0).toBe(true);

    await act(async () => {
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 200 });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(sidebar.getAttribute("style")?.includes("width: 240px")).toBe(true);
  });

  test("left sidebar resize closes only past the Codex half-minimum threshold", async () => {
    const restoreMatchMedia = installReducedMotionMatchMediaForTest();
    try {
      const screen = renderWorkbench({ sidebar: { collapsed: false, width: 300 } });
      await settleAsyncRender();
      await settleAsyncRender();

      const resizeStrip = screen.getByTestId("sidebar-resize-strip");
      await act(async () => {
        fireEvent.pointerDown(resizeStrip, { button: 0, pointerId: 2, clientX: 300 });
        fireEvent.pointerMove(window, { pointerId: 2, clientX: 100 });
        await Promise.resolve();
      });
      await settleAsyncRender();

      expect(screen.queryAllByRole("button", { name: "Show sidebar" }).length > 0).toBe(true);

      await act(async () => {
        fireEvent.pointerUp(window, { pointerId: 2, clientX: 100 });
        await Promise.resolve();
      });
      await waitFor(() => {
        if (screen.container.querySelector('[data-testid="project-session-sidebar"]') !== null) {
          throw new Error("Expected project session sidebar to unmount after collapse");
        }
      });
    } finally {
      restoreMatchMedia();
    }
  });

  test("left sidebar resize normalizes pointer drag deltas by the Codex window zoom", async () => {
    const screen = renderWorkbench({ sidebar: { collapsed: false, width: 300 } });
    await settleAsyncRender();
    await settleAsyncRender();

    const workbenchRoot = screen.getByTestId("workbench-global-header")
      .parentElement as HTMLElement | null;
    workbenchRoot?.style.setProperty("--codex-window-zoom", "2");
    const sidebar = screen.getByTestId("project-session-sidebar");
    const resizeStrip = screen.getByTestId("sidebar-resize-strip");

    await act(async () => {
      fireEvent.pointerDown(resizeStrip, { button: 0, pointerId: 1, clientX: 600 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 720 });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(sidebar.getAttribute("style")?.includes("width: 360px")).toBe(true);

    await act(async () => {
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 720 });
      await Promise.resolve();
    });
  });

  test("left sidebar resize double-click resets to the Codex default width", async () => {
    const screen = renderWorkbench({ sidebar: { collapsed: false, width: 420 } });
    await settleAsyncRender();
    await settleAsyncRender();

    const sidebar = screen.getByTestId("project-session-sidebar");
    const resizeStrip = screen.getByTestId("sidebar-resize-strip");

    await act(async () => {
      fireEvent.click(resizeStrip, { detail: 2 });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(sidebar.getAttribute("style")?.includes("width: 300px")).toBe(true);
  });

  test("collapsed sidebar renders Codex-parity left titlebar chrome on macOS", async () => {
    const restoreMatchMedia = installReducedMotionMatchMediaForTest();
    const originalPlatform = navigator.platform;
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    try {
      const screen = renderWorkbench({ sidebar: { collapsed: true, width: 300 } });
      await settleAsyncRender();
      await settleAsyncRender();

      expect(screen.container.querySelector('[data-testid="project-session-sidebar"]')).toBe(null);
      expect(screen.container.querySelector('[data-sidebar-hover-trigger="true"]')).toBe(null);
      expect(
        screen.container.querySelector('[data-testid="floating-project-session-sidebar-shell"]'),
      ).toBe(null);

      const globalHeader = screen.getByTestId("workbench-global-header");
      const leftSlot = getHeaderShellSlot(screen, "left");
      const collapseButton = within(leftSlot).getByRole("button", { name: "Show sidebar" });
      const backButton = within(leftSlot).getByRole("button", { name: "Back" });
      const forwardButton = within(leftSlot).getByRole("button", { name: "Forward" });
      const compactNewChatButton = within(leftSlot).getByRole("button", { name: "New chat" });
      const visibleLeftLabels = Array.from(leftSlot.querySelectorAll("button"))
        .map((button) => button.getAttribute("aria-label"))
        .join(",");

      expect(globalHeader.contains(leftSlot)).toBe(true);
      expect(globalHeader.contains(collapseButton)).toBe(true);
      expect(visibleLeftLabels).toBe("Show sidebar,Back,Forward,New chat");
      expect(
        leftSlot.className.includes("ps-[max(var(--spacing-token-safe-header-left),0.5rem)]"),
      ).toBe(true);
      expect(leftSlot.getAttribute("style")?.includes("width: 0px")).toBe(true);
      expect(leftSlot.getAttribute("style")?.includes("min-width: 208px")).toBe(true);
      expect(collapseButton.parentElement?.className.includes("fixed")).toBe(false);
      expect(collapseButton.hasAttribute("title")).toBe(false);
      expect(backButton.hasAttribute("disabled")).toBe(true);
      expect(forwardButton.hasAttribute("disabled")).toBe(true);
      expect(
        compactNewChatButton
          .querySelector("path")
          ?.getAttribute("d")
          ?.startsWith(TITLEBAR_NEW_CHAT_ICON_PREFIX),
      ).toBe(true);
      expect(collapseButton.className.includes("no-drag")).toBe(true);

      await moveSidebarPointer(12);

      const floatingShell = screen.container.querySelector(
        '[data-testid="floating-project-session-sidebar-shell"]',
      ) as HTMLElement | null;
      const floatingAside = screen.container.querySelector(
        '[data-testid="app-shell-floating-left-panel"]',
      ) as HTMLElement | null;
      const floatingHeader = floatingAside?.querySelector(".app-header-tint") as HTMLElement | null;
      expect(floatingShell !== null).toBe(true);
      expect(floatingShell?.getAttribute("data-sidebar-floating-focus-area")).toBe("true");
      expect(floatingShell?.getAttribute("style")?.includes("width: 300px")).toBe(true);
      expect(floatingAside !== null).toBe(true);
      expect(floatingHeader !== null).toBe(true);
      expect(screen.getByTestId("sidebar-resize-strip").parentElement).toBe(floatingShell);

      const floatingFocusButton = Array.from(floatingShell?.querySelectorAll("button") ?? []).find(
        (button) => !button.disabled,
      ) as HTMLButtonElement | undefined;
      if (!floatingFocusButton) throw new Error("Expected a focusable floating sidebar button");
      await act(async () => {
        floatingFocusButton.focus();
        await Promise.resolve();
      });
      await settleAsyncRender();

      await moveSidebarPointer(301);
      expect(
        screen.container.querySelector('[data-testid="floating-project-session-sidebar-shell"]') !==
          null,
      ).toBe(true);

      await act(async () => {
        floatingFocusButton.blur();
        await Promise.resolve();
      });
      await settleAsyncRender();
      await moveSidebarPointer(301);
      await act(async () => {
        await Promise.resolve();
      });
      await settleAsyncRender();

      expect(screen.container.querySelector('[data-testid="app-shell-floating-left-panel"]')).toBe(
        null,
      );

      await act(async () => {
        fireEvent.click(compactNewChatButton);
        await Promise.resolve();
      });
      await settleAsyncRender();

      expect(invokeCalls.some((call) => call[0] === "project-sessions:create")).toBe(false);
      expect(screen.getByRole("button", { name: "Show sidebar" }) !== null).toBe(true);
    } finally {
      restoreMatchMedia();
      Object.defineProperty(navigator, "platform", { configurable: true, value: originalPlatform });
    }
  });

  test("floating sidebar resize uses the Codex clamp-only sash behavior", async () => {
    const screen = renderWorkbench({ sidebar: { collapsed: true, width: 300 } });
    await settleAsyncRender();
    await settleAsyncRender();
    await moveSidebarPointer(12);

    const expandStrip = screen.getByTestId("sidebar-resize-strip");

    await act(async () => {
      fireEvent.pointerDown(expandStrip, { button: 0, pointerId: 8, clientX: 300 });
      fireEvent.pointerMove(window, { pointerId: 8, clientX: 360 });
      await Promise.resolve();
    });
    await settleAsyncRender();

    const expandedFloatingShell = screen.container.querySelector(
      '[data-testid="floating-project-session-sidebar-shell"]',
    ) as HTMLElement | null;
    expect(expandedFloatingShell !== null).toBe(true);
    expect(expandedFloatingShell?.getAttribute("style")?.includes("width: 360px")).toBe(true);

    await act(async () => {
      fireEvent.pointerUp(window, { pointerId: 8, clientX: 360 });
      await Promise.resolve();
    });
    await settleAsyncRender();

    const resizeStrip = screen.getByTestId("sidebar-resize-strip");
    let capturedPointerId: number | null = null;
    resizeStrip.setPointerCapture = (pointerId: number) => {
      capturedPointerId = pointerId;
    };

    await act(async () => {
      fireEvent.pointerDown(resizeStrip, { button: 0, pointerId: 9, clientX: 360 });
      fireEvent.pointerMove(window, { pointerId: 9, clientX: 100 });
      await Promise.resolve();
    });
    await settleAsyncRender();

    const floatingShell = screen.container.querySelector(
      '[data-testid="floating-project-session-sidebar-shell"]',
    ) as HTMLElement | null;
    expect(capturedPointerId).toBe(9);
    expect(floatingShell !== null).toBe(true);
    expect(floatingShell?.getAttribute("style")?.includes("width: 240px")).toBe(true);
    expect(screen.container.querySelector('[data-testid="project-session-sidebar"]')).toBe(null);
    expect(screen.queryAllByRole("button", { name: "Show sidebar" }).length > 0).toBe(true);

    await act(async () => {
      fireEvent.pointerUp(window, { pointerId: 9, clientX: 100 });
      await Promise.resolve();
    });
    await settleAsyncRender();

    const persistedFloatingShell = screen.container.querySelector(
      '[data-testid="floating-project-session-sidebar-shell"]',
    ) as HTMLElement | null;
    expect(persistedFloatingShell?.getAttribute("style")?.includes("width: 240px")).toBe(true);
    expect(screen.container.querySelector('[data-testid="project-session-sidebar"]')).toBe(null);
  });

  test("window navigation chrome restores prior and next active sessions", async () => {
    const overviewSession = makeSession();
    const workSession = makeSession({
      id: "session:alpha:work",
      title: "Work",
      order: 1,
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
    const screen = renderWorkbench({
      sidebar: { collapsed: false, width: 300 },
      sessionsByProject: { alpha: [overviewSession, workSession] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const leftSlot = getHeaderShellSlot(screen, "left");
    const backButton = within(leftSlot).getByRole("button", { name: "Back" });
    const forwardButton = within(leftSlot).getByRole("button", { name: "Forward" });

    expect(backButton.hasAttribute("disabled")).toBe(true);
    expect(textContent(screen.container).includes("DB:alpha:board")).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByText("Work"));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(backButton.hasAttribute("disabled")).toBe(false);
    expect(forwardButton.hasAttribute("disabled")).toBe(true);
    await waitFor(() => {
      expect(textContent(screen.container).includes("DB:alpha:board")).toBe(true);
    });

    await act(async () => {
      fireEvent.click(backButton);
      await Promise.resolve();
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(textContent(screen.container).includes("DB:alpha:board")).toBe(true);
    expect(backButton.hasAttribute("disabled")).toBe(true);
    expect(forwardButton.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      fireEvent.click(forwardButton);
      await Promise.resolve();
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await waitFor(() => {
      expect(textContent(screen.container).includes("DB:alpha:board")).toBe(true);
    });
  });

  test("projectless chat selection and navigation use the same explicit no-Project state", async () => {
    const projectSession = makeAttachedSession({
      id: "session:alpha:work",
      title: "Project work",
      threadId: "thread-project-work",
    });
    const projectlessSession = makeAttachedSession({
      id: "session:projectless:loose",
      projectId: null,
      title: "Loose chat",
      threadId: "thread-projectless-loose",
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [projectSession] },
      projectlessSessions: [projectlessSession],
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByText("Loose chat"));
      await Promise.resolve();
    });
    await settleAsyncRender();
    expect(textContent(screen.container).includes("Thread:thread-projectless-loose")).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByText("Project work"));
      await Promise.resolve();
    });
    await settleAsyncRender();
    expect(textContent(screen.container).includes("Thread:thread-project-work")).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      await Promise.resolve();
    });
    await settleAsyncRender();
    expect(textContent(screen.container).includes("Thread:thread-projectless-loose")).toBe(true);
  });

  test("window navigation command requests use the same shell history path", async () => {
    const overviewSession = makeSession();
    const workSession = makeSession({
      id: "session:alpha:work",
      title: "Work",
      order: 1,
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
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [overviewSession, workSession] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByText("Work"));
      await Promise.resolve();
    });
    await settleAsyncRender();

    await act(async () => {
      screen.requestWorkbenchNavigation("back", "command_palette");
      await Promise.resolve();
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(textContent(screen.container).includes("DB:alpha:board")).toBe(true);

    await act(async () => {
      screen.requestWorkbenchNavigation("forward", "menu");
      await Promise.resolve();
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await waitFor(() => {
      expect(textContent(screen.container).includes("DB:alpha:board")).toBe(true);
    });
  });

  test("window navigation restores right-panel tab selection", async () => {
    const browserTab = makeSessionTab({
      id: "session:alpha:database-view:browser",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "browser",
      title: "Browser",
      order: 1,
      config: { projectId: "alpha" },
    });
    const session = makeSession({
      tabs: [...makeSession().tabs, browserTab],
      rightLayout: makePanelLayout(
        ["session:alpha:database-view:db", browserTab.id],
        "session:alpha:database-view:db",
      ),
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(textContent(screen.container).includes("DB:alpha:board")).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Browser" }));
      await Promise.resolve();
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(screen.getByRole("tab", { name: "Browser" }).getAttribute("aria-selected")).toBe("true");

    const navigationChrome = screen
      .getAllByTestId("workbench-window-navigation-chrome")
      .find((element) => element.closest('[aria-hidden="true"]') === null);
    expect(navigationChrome).toBeDefined();
    await act(async () => {
      fireEvent.click(within(navigationChrome!).getByRole("button", { name: "Back" }));
      await Promise.resolve();
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(textContent(screen.container).includes("DB:alpha:board")).toBe(true);
  });

  test("window navigation restores right-panel collapsed state", async () => {
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeSession({ rightCollapsed: false })] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const toggleButton = screen.getByRole("button", { name: "Toggle side panel" });
    expect(screen.queryByTestId("session-right-panel") !== null).toBe(true);
    expect(toggleButton.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      fireEvent.click(toggleButton);
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(toggleButton.getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      await Promise.resolve();
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(screen.queryByTestId("session-right-panel") !== null).toBe(true);
    expect(toggleButton.getAttribute("aria-pressed")).toBe("true");
  });
});
