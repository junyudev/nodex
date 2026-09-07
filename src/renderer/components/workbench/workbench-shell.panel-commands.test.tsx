import "./workbench-testkit/workbench-shell-harness";
import { describe, test, expect } from "vite-plus/test";
import { settleAsyncRender, textContent, textContentIncludingShadowRoots } from "../../test/dom";
import { fireEvent, within, act, waitFor } from "@testing-library/react";
import { splitWorkbenchPanelLeaf } from "../../../shared/workbench-panel-layout";
import { primaryCanvasBlockId } from "../../../shared/block-documents/canvas-document-identity";
import {
  makeAttachedSession,
  makePanelLayout,
  makePanels,
  makeProject,
  makeSession,
  makeSessionTab,
} from "./workbench-testkit/workbench-shell-fixtures";
import {
  appendMockNfmEditor,
  executeCommandPaletteCommand,
  getLastTerminalPanelProps,
  getPanelTabById,
  getPanelTabChromeById,
  getWorkbenchPanelActivateCalls,
  getWorkbenchTabDeleteInputs,
  getWorkbenchTabProjectionDeleteTabIds,
  invokeCalls,
  listBackgroundProcessesCalls,
  openBottomPanel,
  openPanelMenu,
  pointerDownAndSettle,
  renderWorkbench,
  sideChatConversations,
  startSideChatCalls,
  setInvokeCalls,
  setStartSideChatCalls,
} from "./workbench-testkit/workbench-shell-harness";

describe("workbench session shell / panel-commands", () => {
  test("plus menu keeps DB and Browser available while hiding singleton Review", async () => {
    const browserTab = makeSessionTab({
      id: "session:alpha:database-view:browser",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "browser",
      title: "Browser",
      order: 1,
      config: { projectId: "alpha" },
    });
    const reviewTab = makeSessionTab({
      id: "session:alpha:database-view:review",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "review",
      title: "Review",
      order: 2,
      config: { projectId: "alpha" },
    });
    const session = makeAttachedSession({
      tabs: [...makeSession().tabs, browserTab, reviewTab],
      rightLayout: makePanelLayout(
        ["session:alpha:database-view:db", browserTab.id, reviewTab.id],
        "session:alpha:database-view:db",
      ),
    });
    const screen = renderWorkbench({
      projects: [makeProject("alpha", "Alpha", "/Users/asc/repo/project-workspace")],
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const menu = await openPanelMenu(screen, "Open side panel tab");
    expect(within(menu).getByText("DB View") !== null).toBe(true);
    expect(within(menu).getByText("Page") !== null).toBe(true);
    expect(within(menu).getByText("Canvas") !== null).toBe(true);
    expect(within(menu).getByText("Browser") !== null).toBe(true);
    expect(within(menu).queryByText("Review")).toBe(null);
    expect(within(menu).getByText("Files") !== null).toBe(true);
    expect(within(menu).getByText("Terminal") !== null).toBe(true);
  });

  test("Canvas action opens the primary Canvas as a Canvas Stage tab", async () => {
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeAttachedSession()] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const menu = await openPanelMenu(screen, "Open side panel tab");
    setInvokeCalls([]);
    fireEvent.click(within(menu).getByText("Canvas"));
    await settleAsyncRender();

    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:tab-create" &&
          JSON.stringify(call[1]).includes('"kind":"canvas_stage"') &&
          JSON.stringify(call[1]).includes(`"canvasBlockId":"${primaryCanvasBlockId("alpha")}"`),
      ),
    ).toBe(true);
  });

  test("bottom plus menu keeps Browser multi-tab and hides singleton Review tabs from either panel", async () => {
    const browserTab = makeSessionTab({
      id: "session:alpha:database-view:browser",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "browser",
      title: "Browser",
      order: 1,
      config: { projectId: "alpha" },
    });
    const reviewTab = makeSessionTab({
      id: "session:alpha:database-view:review",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "review",
      title: "Review",
      order: 2,
      config: { projectId: "alpha" },
    });
    const session = makeAttachedSession({
      tabs: [...makeSession().tabs, browserTab, reviewTab],
      rightLayout: makePanelLayout(
        ["session:alpha:database-view:db", browserTab.id, reviewTab.id],
        "session:alpha:database-view:db",
      ),
    });
    const screen = renderWorkbench({
      projects: [makeProject("alpha", "Alpha", "/Users/asc/repo/project-workspace")],
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();
    await openBottomPanel(screen);

    const menu = await openPanelMenu(screen, "Open bottom panel tab");
    expect(within(menu).getByText("Browser") !== null).toBe(true);
    expect(within(menu).queryByText("Review")).toBe(null);
    expect(within(menu).getByText("Files") !== null).toBe(true);
    expect(within(menu).getByText("Side chat") !== null).toBe(true);
    expect(within(menu).getByText("Terminal") !== null).toBe(true);
  });

  test("review action creates and renders the connected review panel", async () => {
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeAttachedSession()] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const menu = await openPanelMenu(screen, "Open side panel tab");
    fireEvent.click(within(menu).getByText("Review"));
    await settleAsyncRender();
    await settleAsyncRender();

    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:tab-create" &&
          JSON.stringify(call[1]).includes('"kind":"review"'),
      ),
    ).toBe(true);
    expect(screen.container.querySelector("[data-review-diff-panel]") !== null).toBe(true);
  });

  test("summary Changes action opens Review without routing presentation state through props", async () => {
    (
      globalThis as { __lastConnectedReviewDiffPanelProps?: Record<string, unknown> }
    ).__lastConnectedReviewDiffPanelProps = undefined;
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeAttachedSession()] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open staged changes" }));
      await Promise.resolve();
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:tab-create" &&
          JSON.stringify(call[1]).includes('"kind":"review"'),
      ),
    ).toBe(true);
    const props = (globalThis as { __lastConnectedReviewDiffPanelProps?: Record<string, unknown> })
      .__lastConnectedReviewDiffPanelProps;
    expect("initialGitSource" in (props ?? {})).toBe(false);
    expect("initialGitSourceRequestKey" in (props ?? {})).toBe(false);
    expect("selectedTurnDiff" in (props ?? {})).toBe(false);
  });

  test("command palette open tick renders the command palette with the initial query", async () => {
    const project = makeProject("palette-command", "Palette Command");
    const screen = renderWorkbench({
      projects: [project],
      sessionsByProject: {
        [project.id]: [
          makeAttachedSession({
            id: "session:palette-command",
            projectId: project.id,
          }),
        ],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      screen.openCommandPalette("root");
      await Promise.resolve();
    });
    await settleAsyncRender();

    const input = screen.getByLabelText("Command palette search") as HTMLInputElement;
    expect(input.value).toBe("root");
  });

  test("command palette shell commands open Files Browser Review Terminal and DB View tabs", async () => {
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [makeAttachedSession({ id: "session:alpha:commands" })],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await executeCommandPaletteCommand(screen, "files", "Toggle file tree");
    expect(screen.getByRole("tab", { name: "Files" }) !== null).toBe(true);

    await executeCommandPaletteCommand(screen, "browser", "Open browser tab");
    expect(screen.getByRole("tab", { name: "Browser" }) !== null).toBe(true);

    setInvokeCalls([]);
    await executeCommandPaletteCommand(screen, "review", "Open review tab");
    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:tab-create" &&
          JSON.stringify(call[1]).includes('"kind":"review"') &&
          JSON.stringify(call[1]).includes('"panelId":"right"'),
      ),
    ).toBe(true);

    setInvokeCalls([]);
    await executeCommandPaletteCommand(screen, "terminal", "Open terminal");
    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:tab-create" &&
          JSON.stringify(call[1]).includes('"kind":"terminal"') &&
          JSON.stringify(call[1]).includes('"panelId":"bottom"'),
      ),
    ).toBe(true);

    setInvokeCalls([]);
    await executeCommandPaletteCommand(screen, "db", "Open DB View tab");
    // The session already owns its project DB tab, so the command focuses it
    // instead of creating a duplicate.
    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:tab-create" &&
          JSON.stringify(call[1]).includes('"kind":"db_view"'),
      ),
    ).toBe(false);
    expect(screen.getByRole("tab", { name: "DB View", selected: true }) !== null).toBe(true);
  });

  test("command palette opens shortcut help before customization", async () => {
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [makeAttachedSession({ id: "session:alpha:keyboard" })],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await executeCommandPaletteCommand(screen, "keyboard", "Keyboard shortcuts");

    const shortcutDialog = screen.getByRole("dialog", {
      name: "Keyboard shortcuts",
    });
    await act(async () => {
      fireEvent.click(
        within(shortcutDialog).getByRole("button", {
          name: "Customize shortcuts",
        }),
      );
      await Promise.resolve();
    });
    await settleAsyncRender();

    const routeShell = screen.container.querySelector('[data-testid="settings-route-shell"]');
    expect(routeShell !== null).toBe(true);
  });

  test("command palette opens scheduled task management", async () => {
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [makeAttachedSession({ id: "session:alpha:automation-command" })],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await executeCommandPaletteCommand(screen, "automation", "Manage automations");

    expect(screen.container.querySelector('[data-testid="automations-route-shell"]') !== null).toBe(
      true,
    );
    expect(screen.container.querySelector('[data-thread-stage="true"]')).toBe(null);
  });

  test("command palette opens the process manager dialog", async () => {
    sideChatConversations["thread-alpha"] = {
      threadId: "thread-alpha",
      projectId: "alpha",
      source: null,
      threadName: "Alpha thread",
      threadPreview: "",
      modelProvider: "openai",
      cwd: "/Users/asc/repo/nodex",
      statusType: "idle",
      statusActiveFlags: [],
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      linkedAt: "",
      resumeState: "resumed",
      turns: [
        {
          turnId: "turn-process",
          status: "completed",
          userMessages: [],
          assistantText: "",
          createdAt: 1,
          updatedAt: 1,
          items: [
            {
              threadId: "thread-alpha",
              turnId: "turn-process",
              itemId: "item-process",
              type: "commandExecution",
              kind: "commandExecution",
              status: "inProgress",
              command: "bun run dev",
              cwd: "/Users/asc/repo/nodex",
              aggregatedOutput: "ready in 421ms\n",
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
      ],
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
    };
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [makeAttachedSession({ id: "session:alpha:process-manager" })],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await executeCommandPaletteCommand(screen, "process", "Process Manager");

    await waitFor(() => {
      expect(textContent(document.body).includes("Process Manager")).toBe(true);
      expect(textContent(document.body).includes("bun run dev")).toBe(true);
    });
    expect(listBackgroundProcessesCalls.includes("thread-alpha")).toBe(true);
    expect(textContent(document.body).includes("12.5%")).toBe(true);
    expect(textContent(document.body).includes("1.5 MB")).toBe(true);

    fireEvent.click(screen.getByText("bun run dev"));
    await waitFor(() => {
      expect(screen.container.querySelector("[data-process-output-panel-tab]") !== null).toBe(true);
      expect(textContentIncludingShadowRoots(screen.container).includes("ready in 421ms")).toBe(
        true,
      );
    });
  });

  test("Files shortcut uses Ctrl+Shift+E and leaves Ctrl+P for the command palette", async () => {
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeAttachedSession()] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    setInvokeCalls([]);
    await act(async () => {
      fireEvent.keyDown(document, { key: "p", ctrlKey: true });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(screen.queryByRole("tab", { name: "Files" })).toBe(null);
    expect(invokeCalls.some((call) => call[0] === "window-session-view:tab-create")).toBe(false);

    const input = document.createElement("input");
    document.body.appendChild(input);
    await act(async () => {
      fireEvent.keyDown(input, { key: "E", ctrlKey: true, shiftKey: true });
      await Promise.resolve();
    });
    input.remove();
    await settleAsyncRender();

    expect(screen.queryByRole("tab", { name: "Files" })).toBe(null);

    await act(async () => {
      fireEvent.keyDown(document, { key: "E", ctrlKey: true, shiftKey: true });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(screen.getByRole("tab", { name: "Files" }) !== null).toBe(true);
    expect(screen.container.querySelector('[data-app-shell-tabpanel-preview="true"]')).toBe(null);
    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:tab-create" &&
          JSON.stringify(call[1]).includes('"kind":"files"'),
      ),
    ).toBe(true);
  });

  test("right-panel shortcuts create tabs and ignore editable targets", async () => {
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeAttachedSession()] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.keyDown(document, { key: "G", ctrlKey: true, shiftKey: true });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:tab-create" &&
          JSON.stringify(call[1]).includes('"kind":"review"'),
      ),
    ).toBe(true);

    setInvokeCalls([]);
    await act(async () => {
      fireEvent.keyDown(document, { key: "`", code: "Backquote", ctrlKey: true });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "window-session-view:tab-create" &&
          JSON.stringify(call[1]).includes('"panelId":"bottom"') &&
          JSON.stringify(call[1]).includes('"kind":"terminal"'),
      ),
    ).toBe(true);

    setInvokeCalls([]);
    setStartSideChatCalls([]);
    await act(async () => {
      fireEvent.keyDown(document, { key: "s", altKey: true, ctrlKey: true });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(String(startSideChatCalls.length)).toBe("1");
    await waitFor(() => {
      expect(screen.queryAllByRole("tab", { name: "Side chat" }).length).toBe(1);
    });
    expect(screen.getByRole("tab", { name: "Side chat" }) !== null).toBe(true);

    setInvokeCalls([]);
    const input = document.createElement("input");
    document.body.appendChild(input);
    await act(async () => {
      fireEvent.keyDown(input, { key: "`", code: "Backquote", ctrlKey: true });
      await Promise.resolve();
    });
    input.remove();
    await settleAsyncRender();

    expect(invokeCalls.some((call) => call[0] === "window-session-view:tab-create")).toBe(false);
  });

  test("Ctrl+Shift+] selects the next right-panel tab in the focused tab group", async () => {
    const browserTab = makeSessionTab({
      id: "session:alpha:database-view:browser",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "browser",
      title: "Browser",
      order: 1,
      config: { projectId: "alpha" },
    });
    const reviewTab = makeSessionTab({
      id: "session:alpha:database-view:review",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "review",
      title: "Review",
      order: 2,
      config: { projectId: "alpha" },
    });
    const session = makeAttachedSession({
      tabs: [...makeSession().tabs, browserTab, reviewTab],
      rightLayout: makePanelLayout(
        ["session:alpha:database-view:db", browserTab.id, reviewTab.id],
        "session:alpha:database-view:db",
      ),
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    setInvokeCalls([]);
    await act(async () => {
      fireEvent.keyDown(getPanelTabById(screen.container, "session:alpha:database-view:db"), {
        key: "]",
        code: "BracketRight",
        ctrlKey: true,
        shiftKey: true,
      });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(
      getWorkbenchPanelActivateCalls().some(
        (input) =>
          input.sessionId === "session:alpha:database-view" &&
          input.panelId === "right" &&
          input.leafId === "main" &&
          input.tabId === browserTab.id,
      ),
    ).toBe(true);
  });

  test("Ctrl+Shift+[ wraps from the first right-panel tab to the last tab in the focused tab group", async () => {
    const browserTab = makeSessionTab({
      id: "session:alpha:database-view:browser",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "browser",
      title: "Browser",
      order: 1,
      config: { projectId: "alpha" },
    });
    const reviewTab = makeSessionTab({
      id: "session:alpha:database-view:review",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "review",
      title: "Review",
      order: 2,
      config: { projectId: "alpha" },
    });
    const session = makeAttachedSession({
      tabs: [...makeSession().tabs, browserTab, reviewTab],
      rightLayout: makePanelLayout(
        ["session:alpha:database-view:db", browserTab.id, reviewTab.id],
        "session:alpha:database-view:db",
      ),
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    setInvokeCalls([]);
    await act(async () => {
      fireEvent.keyDown(getPanelTabById(screen.container, "session:alpha:database-view:db"), {
        key: "[",
        code: "BracketLeft",
        ctrlKey: true,
        shiftKey: true,
      });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(
      getWorkbenchPanelActivateCalls().some(
        (input) =>
          input.sessionId === "session:alpha:database-view" &&
          input.panelId === "right" &&
          input.leafId === "main" &&
          input.tabId === reviewTab.id,
      ),
    ).toBe(true);
  });

  test("panel tab cycling stays inside the focused split tab group", async () => {
    const rightLayout = splitWorkbenchPanelLeaf(
      makePanelLayout(["db-tab", "browser-tab", "review-tab"], "browser-tab"),
      {
        leafId: "main",
        side: "right",
        tabId: "review-tab",
        newLeafId: "leaf:review",
        newBranchId: "branch:root",
      },
    );
    const panels = makePanels({
      rightTabIds: ["db-tab", "browser-tab", "review-tab"],
      rightActiveTabId: "browser-tab",
      rightFullWidth: false,
    });
    const session = makeAttachedSession({
      id: "session:alpha:split-cycle",
      title: "Split cycle",
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
          sessionId: "session:alpha:split-cycle",
          projectId: "alpha",
          kind: "db_view",
          title: "DB View",
          panelId: "right",
          config: { accessContext: { kind: "project", projectId: "alpha" } },
        },
        {
          id: "browser-tab",
          sessionId: "session:alpha:split-cycle",
          projectId: "alpha",
          kind: "browser",
          title: "Browser",
          panelId: "right",
          config: { projectId: "alpha" },
        },
        {
          id: "review-tab",
          sessionId: "session:alpha:split-cycle",
          projectId: "alpha",
          kind: "review",
          title: "Review",
          panelId: "right",
          config: { projectId: "alpha" },
        },
      ],
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.mouseDown(getPanelTabById(screen.container, "browser-tab"), { button: 0 });
      await Promise.resolve();
    });
    await settleAsyncRender();
    await settleAsyncRender();

    setInvokeCalls([]);
    await act(async () => {
      fireEvent.keyDown(getPanelTabById(screen.container, "browser-tab"), {
        key: "]",
        code: "BracketRight",
        ctrlKey: true,
        shiftKey: true,
      });
      await Promise.resolve();
    });
    await settleAsyncRender();

    const activateCalls = getWorkbenchPanelActivateCalls();
    expect(
      activateCalls.some(
        (input) =>
          input.sessionId === "session:alpha:split-cycle" &&
          input.panelId === "right" &&
          input.leafId === "main" &&
          input.tabId === "db-tab",
      ),
    ).toBe(true);
    expect(activateCalls.some((input) => input.tabId === "review-tab")).toBe(false);
  });

  test("panel tab cycling uses the last focused leaf when native routing has no leaf target", async () => {
    const browserTab = makeSessionTab({
      id: "session:alpha:database-view:browser",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "browser",
      title: "Browser",
      order: 1,
      config: { projectId: "alpha" },
    });
    const reviewTab = makeSessionTab({
      id: "session:alpha:database-view:review",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "review",
      title: "Review",
      order: 2,
      config: { projectId: "alpha" },
    });
    const session = makeAttachedSession({
      tabs: [...makeSession().tabs, browserTab, reviewTab],
      rightLayout: makePanelLayout(
        ["session:alpha:database-view:db", browserTab.id, reviewTab.id],
        "session:alpha:database-view:db",
      ),
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await pointerDownAndSettle(getPanelTabById(screen.container, "session:alpha:database-view:db"));

    setInvokeCalls([]);
    await act(async () => {
      fireEvent.keyDown(document.body, {
        key: "]",
        code: "BracketRight",
        ctrlKey: true,
        shiftKey: true,
      });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(
      getWorkbenchPanelActivateCalls().some(
        (input) =>
          input.sessionId === "session:alpha:database-view" &&
          input.panelId === "right" &&
          input.leafId === "main" &&
          input.tabId === browserTab.id,
      ),
    ).toBe(true);
  });

  test("native panel tab cycle requests reuse the focused panel tab group", async () => {
    const browserTab = makeSessionTab({
      id: "session:alpha:database-view:browser",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "browser",
      title: "Browser",
      order: 1,
      config: { projectId: "alpha" },
    });
    const reviewTab = makeSessionTab({
      id: "session:alpha:database-view:review",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "review",
      title: "Review",
      order: 2,
      config: { projectId: "alpha" },
    });
    const session = makeAttachedSession({
      tabs: [...makeSession().tabs, browserTab, reviewTab],
      rightLayout: makePanelLayout(
        ["session:alpha:database-view:db", browserTab.id, reviewTab.id],
        "session:alpha:database-view:db",
      ),
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await pointerDownAndSettle(getPanelTabById(screen.container, "session:alpha:database-view:db"));

    setInvokeCalls([]);
    await act(async () => {
      screen.requestPanelTabCycle("next");
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(
      getWorkbenchPanelActivateCalls().some(
        (input) =>
          input.sessionId === "session:alpha:database-view" &&
          input.panelId === "right" &&
          input.leafId === "main" &&
          input.tabId === browserTab.id,
      ),
    ).toBe(true);
  });

  test("native panel tab cycle requests are ignored while an editable target is focused", async () => {
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

    await pointerDownAndSettle(getPanelTabById(screen.container, "session:alpha:database-view:db"));

    const input = document.createElement("input");
    screen.getByTestId("session-right-panel").appendChild(input);
    setInvokeCalls([]);
    await act(async () => {
      input.focus();
      screen.requestPanelTabCycle("next");
      await Promise.resolve();
    });
    input.remove();
    await settleAsyncRender();

    expect(getWorkbenchPanelActivateCalls().length).toBe(0);
  });

  test("panel tab cycling works from focused NFM editor content", async () => {
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

    const leaf = screen.container.querySelector('[data-panel-group-leaf-id="main"]');
    if (!(leaf instanceof HTMLElement)) {
      throw new Error("Expected main panel leaf");
    }
    const { root: editor, content: editorContent } = appendMockNfmEditor(leaf);

    setInvokeCalls([]);
    await act(async () => {
      editorContent.focus();
      fireEvent.keyDown(editorContent, {
        key: "{",
        ctrlKey: true,
        shiftKey: true,
      });
      await Promise.resolve();
    });
    editor.remove();
    await settleAsyncRender();

    expect(
      getWorkbenchPanelActivateCalls().some(
        (input) =>
          input.sessionId === "session:alpha:database-view" &&
          input.panelId === "right" &&
          input.leafId === "main" &&
          input.tabId === browserTab.id,
      ),
    ).toBe(true);
  });

  test("panel tab cycling mounts only the active durable page stage", async () => {
    const firstPageTab = makeSessionTab({
      id: "session:alpha:database-view:card-1",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "page_stage",
      title: "Card One",
      order: 0,
      config: {
        accessContext: { kind: "project", projectId: "alpha" },
        pageId: "card-1",
        titleSnapshot: "Card One",
      },
    });
    const secondPageTab = makeSessionTab({
      id: "session:alpha:database-view:card-2",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "page_stage",
      title: "Card Two",
      order: 1,
      config: {
        accessContext: { kind: "project", projectId: "alpha" },
        pageId: "card-2",
        titleSnapshot: "Card Two",
      },
    });
    const session = makeSession({
      tabs: [firstPageTab, secondPageTab],
      rightLayout: makePanelLayout([firstPageTab.id, secondPageTab.id], firstPageTab.id),
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const state = globalThis as {
      __mockPageStageMountsByPageId?: Record<string, number>;
      __mockPageStageUnmountsByPageId?: Record<string, number>;
      __mockPageStagePropsByPageId?: Record<string, Record<string, unknown>>;
    };
    expect(state.__mockPageStageMountsByPageId?.["card-1"]).toBe(1);
    expect(state.__mockPageStageMountsByPageId?.["card-2"] ?? 0).toBe(0);
    expect(state.__mockPageStageUnmountsByPageId?.["card-1"] ?? 0).toBe(0);
    expect(state.__mockPageStagePropsByPageId?.["card-1"]?.isActivePanelTab).toBe(true);
    expect(state.__mockPageStagePropsByPageId?.["card-1"]?.editorSessionKey).toBe(
      `${session.id}\u0000${firstPageTab.id}`,
    );
    expect(screen.container.querySelector('[aria-label="Mock editor card-2"]')).toBe(null);

    const firstEditor = screen.container.querySelector('[aria-label="Mock editor card-1"]');
    if (!(firstEditor instanceof HTMLElement)) {
      throw new Error("Expected first page stage editor");
    }

    setInvokeCalls([]);
    await act(async () => {
      firstEditor.focus();
      fireEvent.keyDown(firstEditor, {
        key: "]",
        code: "BracketRight",
        ctrlKey: true,
        shiftKey: true,
      });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(
      getWorkbenchPanelActivateCalls().some(
        (input) =>
          input.sessionId === "session:alpha:database-view" &&
          input.panelId === "right" &&
          input.leafId === "main" &&
          input.tabId === secondPageTab.id,
      ),
    ).toBe(true);
    expect(state.__mockPageStageMountsByPageId?.["card-1"]).toBe(1);
    expect(state.__mockPageStageMountsByPageId?.["card-2"]).toBe(1);
    expect(state.__mockPageStageUnmountsByPageId?.["card-1"]).toBe(1);
    expect(state.__mockPageStageUnmountsByPageId?.["card-2"] ?? 0).toBe(0);
    expect(state.__mockPageStagePropsByPageId?.["card-2"]?.isActivePanelTab).toBe(true);
    expect(state.__mockPageStagePropsByPageId?.["card-2"]?.editorSessionKey).toBe(
      `${session.id}\u0000${secondPageTab.id}`,
    );
    expect(screen.container.querySelector('[aria-label="Mock editor card-1"]')).toBe(null);

    const secondEditor = screen.container.querySelector('[aria-label="Mock editor card-2"]');
    if (!(secondEditor instanceof HTMLElement)) {
      throw new Error("Expected second page stage editor");
    }

    setInvokeCalls([]);
    await act(async () => {
      secondEditor.focus();
      fireEvent.keyDown(secondEditor, {
        key: "[",
        code: "BracketLeft",
        ctrlKey: true,
        shiftKey: true,
      });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(
      getWorkbenchPanelActivateCalls().some(
        (input) =>
          input.sessionId === "session:alpha:database-view" &&
          input.panelId === "right" &&
          input.leafId === "main" &&
          input.tabId === firstPageTab.id,
      ),
    ).toBe(true);
    expect(state.__mockPageStageMountsByPageId?.["card-1"]).toBe(2);
    expect(state.__mockPageStageMountsByPageId?.["card-2"]).toBe(1);
    expect(state.__mockPageStageUnmountsByPageId?.["card-1"]).toBe(1);
    expect(state.__mockPageStageUnmountsByPageId?.["card-2"]).toBe(1);
    expect(state.__mockPageStagePropsByPageId?.["card-1"]?.isActivePanelTab).toBe(true);
    expect(state.__mockPageStagePropsByPageId?.["card-1"]?.editorSessionKey).toBe(
      `${session.id}\u0000${firstPageTab.id}`,
    );
    expect(screen.container.querySelector('[aria-label="Mock editor card-2"]')).toBe(null);
  });

  test("native panel tab cycle requests work while NFM editor content is focused", async () => {
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

    const leaf = screen.container.querySelector('[data-panel-group-leaf-id="main"]');
    if (!(leaf instanceof HTMLElement)) {
      throw new Error("Expected main panel leaf");
    }
    const { root: editor, content: editorContent } = appendMockNfmEditor(leaf);

    await act(async () => {
      editorContent.focus();
      fireEvent.focus(editorContent);
      await Promise.resolve();
    });
    await settleAsyncRender();

    setInvokeCalls([]);
    await act(async () => {
      screen.requestPanelTabCycle("next");
      await Promise.resolve();
    });
    editor.remove();
    await settleAsyncRender();

    expect(
      getWorkbenchPanelActivateCalls().some(
        (input) =>
          input.sessionId === "session:alpha:database-view" &&
          input.panelId === "right" &&
          input.leafId === "main" &&
          input.tabId === browserTab.id,
      ),
    ).toBe(true);
  });

  test("panel tab cycling works in the focused bottom-panel tab group", async () => {
    const panels = makePanels({
      rightCollapsed: true,
      bottomTabIds: ["terminal-tab", "bottom-browser-tab"],
      bottomActiveTabId: "terminal-tab",
      bottomCollapsed: false,
    });
    const session = makeSession({
      id: "session:alpha:bottom-cycle",
      title: "Bottom cycle",
      panels,
      tabs: [
        {
          id: "terminal-tab",
          sessionId: "session:alpha:bottom-cycle",
          projectId: "alpha",
          kind: "terminal",
          title: "Terminal",
          panelId: "bottom",
          config: { terminalSessionId: "terminal-cycle" },
        },
        {
          id: "bottom-browser-tab",
          sessionId: "session:alpha:bottom-cycle",
          projectId: "alpha",
          kind: "browser",
          title: "Browser",
          panelId: "bottom",
          config: { projectId: "alpha" },
        },
      ],
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    setInvokeCalls([]);
    await act(async () => {
      fireEvent.keyDown(getPanelTabById(screen.container, "terminal-tab"), {
        key: "]",
        code: "BracketRight",
        ctrlKey: true,
        shiftKey: true,
      });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(
      getWorkbenchPanelActivateCalls().some(
        (input) =>
          input.sessionId === "session:alpha:bottom-cycle" &&
          input.panelId === "bottom" &&
          input.leafId === "main" &&
          input.tabId === "bottom-browser-tab",
      ),
    ).toBe(true);
  });

  test("panel tab cycling ignores input and dialog targets inside a focused panel", async () => {
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

    const rightPanel = screen.getByTestId("session-right-panel");
    const input = document.createElement("input");
    rightPanel.appendChild(input);
    setInvokeCalls([]);
    await act(async () => {
      fireEvent.keyDown(input, {
        key: "]",
        code: "BracketRight",
        ctrlKey: true,
        shiftKey: true,
      });
      await Promise.resolve();
    });
    input.remove();
    await settleAsyncRender();
    expect(getWorkbenchPanelActivateCalls().length).toBe(0);

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const dialogButton = document.createElement("button");
    dialog.appendChild(dialogButton);
    rightPanel.appendChild(dialog);
    await act(async () => {
      fireEvent.keyDown(dialogButton, {
        key: "]",
        code: "BracketRight",
        ctrlKey: true,
        shiftKey: true,
      });
      await Promise.resolve();
    });
    dialog.remove();
    await settleAsyncRender();
    expect(getWorkbenchPanelActivateCalls().length).toBe(0);
  });

  test("plain Ctrl+Bracket shortcuts bypass focused panel tab cycling", async () => {
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

    setInvokeCalls([]);
    await act(async () => {
      fireEvent.keyDown(getPanelTabById(screen.container, "session:alpha:database-view:db"), {
        key: "[",
        code: "BracketLeft",
        ctrlKey: true,
      });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(getWorkbenchPanelActivateCalls().length).toBe(0);
  });

  test("Ctrl+W closes the active right-panel tab in the focused tab group", async () => {
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
        browserTab.id,
      ),
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    setInvokeCalls([]);
    await act(async () => {
      fireEvent.keyDown(getPanelTabById(screen.container, browserTab.id), {
        key: "w",
        code: "KeyW",
        ctrlKey: true,
      });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(JSON.stringify(getWorkbenchTabProjectionDeleteTabIds())).toBe(
      JSON.stringify([browserTab.id]),
    );
  });

  test("Ctrl+W routes close focus to the same-leaf most recently active tab", async () => {
    const firstTab = makeSessionTab({
      id: "session:alpha:database-view:first",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "db_view",
      title: "First",
      order: 0,
      config: { accessContext: { kind: "project", projectId: "alpha" } },
    });
    const secondTab = makeSessionTab({
      id: "session:alpha:database-view:second",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "browser",
      title: "Second",
      order: 1,
      config: { projectId: "alpha" },
    });
    const thirdTab = makeSessionTab({
      id: "session:alpha:database-view:third",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "review",
      title: "Third",
      order: 2,
      config: { projectId: "alpha" },
    });
    const session = makeAttachedSession({
      tabs: [firstTab, secondTab, thirdTab],
      rightLayout: makePanelLayout([firstTab.id, secondTab.id, thirdTab.id], firstTab.id),
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.mouseDown(getPanelTabById(screen.container, secondTab.id), { button: 0 });
      await Promise.resolve();
    });
    await settleAsyncRender();
    await act(async () => {
      fireEvent.mouseDown(getPanelTabById(screen.container, thirdTab.id), { button: 0 });
      await Promise.resolve();
    });
    await settleAsyncRender();

    setInvokeCalls([]);
    await act(async () => {
      fireEvent.keyDown(getPanelTabById(screen.container, thirdTab.id), {
        key: "w",
        code: "KeyW",
        ctrlKey: true,
      });
      await Promise.resolve();
    });
    await settleAsyncRender();

    const deleteInput = getWorkbenchTabDeleteInputs()[0];
    if (typeof deleteInput === "string" || !deleteInput) {
      throw new Error("Expected structured tab delete input");
    }
    expect(deleteInput.tabId).toBe(thirdTab.id);
    expect(deleteInput.preferredActiveLeafId).toBe("main");
    expect(deleteInput.preferredActiveTabId).toBe(secondTab.id);
    await waitFor(() => {
      expect(getPanelTabById(screen.container, secondTab.id).getAttribute("aria-selected")).toBe(
        "true",
      );
    });
  });

  test("Ctrl+W close routing stays inside the focused split leaf", async () => {
    const firstTab = makeSessionTab({
      id: "session:alpha:database-view:first-split-close",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "db_view",
      title: "First",
      order: 0,
      config: { accessContext: { kind: "project", projectId: "alpha" } },
    });
    const secondTab = makeSessionTab({
      id: "session:alpha:database-view:second-split-close",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "browser",
      title: "Second",
      order: 1,
      config: { projectId: "alpha" },
    });
    const thirdTab = makeSessionTab({
      id: "session:alpha:database-view:third-split-close",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "review",
      title: "Third",
      order: 2,
      config: { projectId: "alpha" },
    });
    const rightLayout = splitWorkbenchPanelLeaf(
      makePanelLayout([firstTab.id, secondTab.id, thirdTab.id], firstTab.id),
      {
        leafId: "main",
        side: "right",
        tabId: thirdTab.id,
        newLeafId: "leaf:review-close",
        newBranchId: "branch:review-close",
      },
    );
    const session = makeAttachedSession({
      tabs: [firstTab, secondTab, thirdTab],
      rightLayout,
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.mouseDown(getPanelTabById(screen.container, secondTab.id), { button: 0 });
      await Promise.resolve();
    });
    await settleAsyncRender();

    setInvokeCalls([]);
    await act(async () => {
      fireEvent.keyDown(getPanelTabById(screen.container, secondTab.id), {
        key: "w",
        code: "KeyW",
        ctrlKey: true,
      });
      await Promise.resolve();
    });
    await settleAsyncRender();

    const deleteInput = getWorkbenchTabDeleteInputs()[0];
    if (typeof deleteInput === "string" || !deleteInput) {
      throw new Error("Expected structured tab delete input");
    }
    expect(deleteInput.tabId).toBe(secondTab.id);
    expect(deleteInput.preferredActiveLeafId).toBe("main");
    expect(deleteInput.preferredActiveTabId).toBe(firstTab.id);
    await waitFor(() => {
      expect(getPanelTabById(screen.container, firstTab.id).getAttribute("aria-selected")).toBe(
        "true",
      );
    });
  });

  test("direct panel tab close routes focus to the same-leaf right neighbor", async () => {
    const firstTab = makeSessionTab({
      id: "session:alpha:database-view:first-direct",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "db_view",
      title: "First",
      order: 0,
      config: { accessContext: { kind: "project", projectId: "alpha" } },
    });
    const secondTab = makeSessionTab({
      id: "session:alpha:database-view:second-direct",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "browser",
      title: "Second",
      order: 1,
      config: { projectId: "alpha" },
    });
    const thirdTab = makeSessionTab({
      id: "session:alpha:database-view:third-direct",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "review",
      title: "Third",
      order: 2,
      config: { projectId: "alpha" },
    });
    const session = makeAttachedSession({
      tabs: [firstTab, secondTab, thirdTab],
      rightLayout: makePanelLayout([firstTab.id, secondTab.id, thirdTab.id], firstTab.id),
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.mouseDown(getPanelTabById(screen.container, secondTab.id), { button: 0 });
      await Promise.resolve();
    });
    await settleAsyncRender();

    setInvokeCalls([]);
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Close Second tab"));
      await Promise.resolve();
    });
    await settleAsyncRender();

    const deleteInput = getWorkbenchTabDeleteInputs()[0];
    if (typeof deleteInput === "string" || !deleteInput) {
      throw new Error("Expected structured tab delete input");
    }
    expect(deleteInput.tabId).toBe(secondTab.id);
    expect(deleteInput.preferredActiveLeafId).toBe("main");
    expect(deleteInput.preferredActiveTabId).toBe(thirdTab.id);
    await waitFor(() => {
      expect(getPanelTabById(screen.container, thirdTab.id).getAttribute("aria-selected")).toBe(
        "true",
      );
    });
  });

  test("closing a Browser child tab returns to its opener before the physical neighbor", async () => {
    const openerTab = makeSessionTab({
      id: "session:alpha:database-view:browser-opener",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "browser",
      title: "Browser opener",
      order: 0,
      config: { projectId: "alpha" },
    });
    const unrelatedTab = makeSessionTab({
      id: "session:alpha:database-view:unrelated-review",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "review",
      title: "Unrelated review",
      order: 1,
      config: { projectId: "alpha" },
    });
    const session = makeAttachedSession({
      tabs: [openerTab, unrelatedTab],
      rightLayout: makePanelLayout([openerTab.id, unrelatedTab.id], openerTab.id),
    });
    const screen = renderWorkbench({ sessionsByProject: { alpha: [session] } });
    await settleAsyncRender();
    await settleAsyncRender();

    fireEvent.contextMenu(getPanelTabChromeById(screen.container, openerTab.id));
    await settleAsyncRender();
    setInvokeCalls([]);
    fireEvent.click(within(screen.getByRole("menu")).getByText("New tab to the right"));
    await settleAsyncRender();
    await settleAsyncRender();

    const createCall = invokeCalls.find((call) => call[0] === "window-session-view:tab-create");
    const createdTabId = (createCall?.[1] as { clientTabId?: string } | undefined)?.clientTabId;
    if (!createdTabId) throw new Error("Expected a created Browser child tab");
    expect(getPanelTabById(screen.container, createdTabId).getAttribute("aria-selected")).toBe(
      "true",
    );

    setInvokeCalls([]);
    const closeButton = getPanelTabChromeById(screen.container, createdTabId).querySelector(
      '[data-app-shell-tab-close-button="true"]',
    );
    if (!closeButton) throw new Error("Expected Browser child close button");
    fireEvent.click(closeButton);
    await settleAsyncRender();

    const deleteInput = getWorkbenchTabDeleteInputs()[0];
    if (typeof deleteInput === "string" || !deleteInput) {
      throw new Error("Expected structured tab delete input");
    }
    expect(deleteInput.preferredActiveTabId).toBe(openerTab.id);
    expect(getPanelTabById(screen.container, openerTab.id).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  test("leaving a Browser opener tree restores physical close selection", async () => {
    const openerTab = makeSessionTab({
      id: "session:alpha:database-view:browser-tree-root",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "browser",
      title: "Browser tree root",
      order: 0,
      config: { projectId: "alpha" },
    });
    const unrelatedTab = makeSessionTab({
      id: "session:alpha:database-view:tree-exit",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "review",
      title: "Tree exit",
      order: 1,
      config: { projectId: "alpha" },
    });
    const session = makeAttachedSession({
      tabs: [openerTab, unrelatedTab],
      rightLayout: makePanelLayout([openerTab.id, unrelatedTab.id], openerTab.id),
    });
    const screen = renderWorkbench({ sessionsByProject: { alpha: [session] } });
    await settleAsyncRender();
    await settleAsyncRender();

    fireEvent.contextMenu(getPanelTabChromeById(screen.container, openerTab.id));
    await settleAsyncRender();
    setInvokeCalls([]);
    fireEvent.click(within(screen.getByRole("menu")).getByText("New tab to the right"));
    await settleAsyncRender();
    await settleAsyncRender();
    const createCall = invokeCalls.find((call) => call[0] === "window-session-view:tab-create");
    const createdTabId = (createCall?.[1] as { clientTabId?: string } | undefined)?.clientTabId;
    if (!createdTabId) throw new Error("Expected a created Browser child tab");

    fireEvent.mouseDown(getPanelTabById(screen.container, unrelatedTab.id), { button: 0 });
    await settleAsyncRender();
    fireEvent.mouseDown(getPanelTabById(screen.container, createdTabId), { button: 0 });
    await settleAsyncRender();

    setInvokeCalls([]);
    const closeButton = getPanelTabChromeById(screen.container, createdTabId).querySelector(
      '[data-app-shell-tab-close-button="true"]',
    );
    if (!closeButton) throw new Error("Expected Browser child close button");
    fireEvent.click(closeButton);
    await settleAsyncRender();

    const deleteInput = getWorkbenchTabDeleteInputs()[0];
    if (typeof deleteInput === "string" || !deleteInput) {
      throw new Error("Expected structured tab delete input");
    }
    expect(deleteInput.preferredActiveTabId).toBe(unrelatedTab.id);
  });

  test("middle-click panel tab close uses same-leaf physical routing", async () => {
    const firstTab = makeSessionTab({
      id: "session:alpha:database-view:first-middle",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "db_view",
      title: "First",
      order: 0,
      config: { accessContext: { kind: "project", projectId: "alpha" } },
    });
    const secondTab = makeSessionTab({
      id: "session:alpha:database-view:second-middle",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "browser",
      title: "Second",
      order: 1,
      config: { projectId: "alpha" },
    });
    const thirdTab = makeSessionTab({
      id: "session:alpha:database-view:third-middle",
      sessionId: "session:alpha:database-view",
      projectId: "alpha",
      kind: "review",
      title: "Third",
      order: 2,
      config: { projectId: "alpha" },
    });
    const session = makeAttachedSession({
      tabs: [firstTab, secondTab, thirdTab],
      rightLayout: makePanelLayout([firstTab.id, secondTab.id, thirdTab.id], firstTab.id),
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.mouseDown(getPanelTabById(screen.container, secondTab.id), { button: 0 });
      await Promise.resolve();
    });
    await settleAsyncRender();

    setInvokeCalls([]);
    await act(async () => {
      fireEvent.mouseDown(getPanelTabChromeById(screen.container, secondTab.id), { button: 1 });
      await Promise.resolve();
    });
    await settleAsyncRender();

    const deleteInput = getWorkbenchTabDeleteInputs()[0];
    if (typeof deleteInput === "string" || !deleteInput) {
      throw new Error("Expected structured tab delete input");
    }
    expect(deleteInput.tabId).toBe(secondTab.id);
    expect(deleteInput.preferredActiveLeafId).toBe("main");
    expect(deleteInput.preferredActiveTabId).toBe(thirdTab.id);
    await waitFor(() => {
      expect(getPanelTabById(screen.container, thirdTab.id).getAttribute("aria-selected")).toBe(
        "true",
      );
    });
  });

  test("a sole durable panel tab exposes and runs its direct close action", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();
    await settleAsyncRender();

    const closeButton = screen.getByRole("button", { name: "Close DB View tab" });
    setInvokeCalls([]);
    await act(async () => {
      fireEvent.click(closeButton);
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(getWorkbenchTabProjectionDeleteTabIds()).toEqual(["session:alpha:database-view:db"]);
  });

  test("Ctrl+W closes a sole durable panel tab", async () => {
    const screen = renderWorkbench();
    await settleAsyncRender();
    await settleAsyncRender();

    setInvokeCalls([]);
    await act(async () => {
      fireEvent.keyDown(getPanelTabById(screen.container, "session:alpha:database-view:db"), {
        key: "w",
        code: "KeyW",
        ctrlKey: true,
      });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(getWorkbenchTabProjectionDeleteTabIds()).toEqual(["session:alpha:database-view:db"]);
  });

  test("native close-panel-tab requests close the active focused panel tab", async () => {
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
        browserTab.id,
      ),
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await pointerDownAndSettle(getPanelTabById(screen.container, browserTab.id));

    setInvokeCalls([]);
    await act(async () => {
      screen.requestPanelTabClose();
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(JSON.stringify(getWorkbenchTabProjectionDeleteTabIds())).toBe(
      JSON.stringify([browserTab.id]),
    );
  });

  test("Ctrl+W closes the active bottom-panel tab in the focused tab group", async () => {
    const panels = makePanels({
      rightCollapsed: true,
      bottomTabIds: ["terminal-tab", "bottom-browser-tab"],
      bottomActiveTabId: "bottom-browser-tab",
      bottomCollapsed: false,
    });
    const session = makeSession({
      id: "session:alpha:bottom-close",
      title: "Bottom close",
      panels,
      tabs: [
        {
          id: "terminal-tab",
          sessionId: "session:alpha:bottom-close",
          projectId: "alpha",
          kind: "terminal",
          title: "Terminal",
          panelId: "bottom",
          config: { terminalSessionId: "terminal-close" },
        },
        {
          id: "bottom-browser-tab",
          sessionId: "session:alpha:bottom-close",
          projectId: "alpha",
          kind: "browser",
          title: "Browser",
          panelId: "bottom",
          config: { projectId: "alpha" },
        },
      ],
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    setInvokeCalls([]);
    await act(async () => {
      fireEvent.keyDown(getPanelTabById(screen.container, "bottom-browser-tab"), {
        key: "w",
        code: "KeyW",
        ctrlKey: true,
      });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(JSON.stringify(getWorkbenchTabProjectionDeleteTabIds())).toBe(
      JSON.stringify(["bottom-browser-tab"]),
    );
  });

  test("Ctrl+W closes the active panel tab from focused NFM editor content", async () => {
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
        browserTab.id,
      ),
    });
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [session] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const leaf = screen.container.querySelector('[data-panel-group-leaf-id="main"]');
    if (!(leaf instanceof HTMLElement)) {
      throw new Error("Expected main panel leaf");
    }
    const { root: editor, content: editorContent } = appendMockNfmEditor(leaf);

    setInvokeCalls([]);
    await act(async () => {
      editorContent.focus();
      fireEvent.keyDown(editorContent, {
        key: "w",
        code: "KeyW",
        ctrlKey: true,
      });
      await Promise.resolve();
    });
    editor.remove();
    await settleAsyncRender();

    expect(JSON.stringify(getWorkbenchTabProjectionDeleteTabIds())).toBe(
      JSON.stringify([browserTab.id]),
    );
  });

  test("terminal tab default cwd prefers the attached thread cwd", async () => {
    const terminalSession = makeAttachedSession({
      id: "session:alpha:terminal-thread",
      title: "Terminal thread",
      tabs: [
        {
          id: "terminal-tab",
          kind: "terminal",
          title: "Terminal",
          panelId: "bottom",
          config: { terminalSessionId: "terminal-thread" },
        },
      ],
    });

    renderWorkbench({
      projects: [makeProject("alpha", "Alpha", "/Users/asc/repo/project-workspace")],
      sessionsByProject: { alpha: [terminalSession] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(getLastTerminalPanelProps()).toMatchObject({
      cwd: "/Users/asc/repo/nodex",
      conversationId: "thread-alpha",
      projectSessionId: "session:alpha:terminal-thread",
    });
  });

  test("terminal tab default cwd falls back to the owning project workspace path", async () => {
    const terminalSession = makeSession({
      id: "session:alpha:terminal-project",
      title: "Project terminal",
      tabs: [
        {
          id: "terminal-tab",
          kind: "terminal",
          title: "Terminal",
          panelId: "bottom",
          config: { terminalSessionId: "terminal-project" },
        },
      ],
    });

    renderWorkbench({
      projects: [makeProject("alpha", "Alpha", "/Users/asc/repo/project-workspace")],
      sessionsByProject: { alpha: [terminalSession] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(getLastTerminalPanelProps()).toMatchObject({
      cwd: "/Users/asc/repo/project-workspace",
      conversationId: null,
      projectSessionId: "session:alpha:terminal-project",
    });
  });

  test("terminal tab does not fall back to the process cwd without a conversation workspace", async () => {
    delete (globalThis as { __lastTerminalPanelProps?: Record<string, unknown> })
      .__lastTerminalPanelProps;
    const terminalSession = makeSession({
      id: "session:alpha:terminal-pty-default",
      title: "Default terminal",
      tabs: [
        {
          id: "terminal-tab",
          kind: "terminal",
          title: "Terminal",
          panelId: "bottom",
          config: { terminalSessionId: "terminal-default" },
        },
      ],
    });

    const screen = renderWorkbench({
      projects: [makeProject()],
      sessionsByProject: { alpha: [terminalSession] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(screen.getByText("Terminal workspace is unavailable") !== null).toBe(true);
    expect(
      (globalThis as { __lastTerminalPanelProps?: Record<string, unknown> })
        .__lastTerminalPanelProps,
    ).toBeUndefined();
  });
});
