import { createFileSearchFixture } from "../../test/file-search-fixture";
import { installWindowApi } from "../../test/browser-globals";
import { describe, expect, vi, test } from "vite-plus/test";
import { createElement, createRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { NodexModalHost } from "@/lib/modal-registry";
import type {
  CommandPalettePage,
  CommandPaletteCommand,
  CommandPaletteThread,
  CommandMenuMode,
} from "@/lib/command-palette";
import { getDefaultCommandPalettePageFilters } from "@/lib/command-palette";
import {
  buildCommandPaletteCommands,
  OPEN_DB_VIEW_TAB_COMMAND_ID,
  type CommandPaletteShellCommandContext,
} from "@/lib/command-palette-commands";
import type { DatabasePageSummary, PageSearchResult } from "@/lib/types";
import { plainTextToPortableRichText } from "../../../shared/block-documents/portable-rich-text";
import type { CommandPalettePageSearchBatch } from "../../lib/command-palette-page-results";
import { createCommandPaletteThreadSearchIndex } from "../../lib/command-palette-thread-search";
import { openNodexMenu, settleAsyncRender, textContent } from "../../test/dom";
import { renderWithAppMaitai as render } from "../../test/app-maitai";
import { createCommandKeymapState } from "../../../shared/command-keybindings";
import {
  RENAME_THREAD_COMMAND_ID,
  TOGGLE_SIDEBAR_COMMAND_ID,
} from "../../../shared/window-navigation";
import { TOGGLE_BOTTOM_PANEL_COMMAND_ID } from "../../../shared/workbench-commands";
import { DEFAULT_PROJECT_APPEARANCE } from "../../../shared/project-appearance";
import type { CommandPaletteWorkspaceSelection } from "@/lib/command-palette-workspace-selection";
import type { CommandPaletteSurfaceHandle } from "./command-palette-surface";

vi.mock("./threads-icon", () => ({
  ThreadsIcon: ({ className }: { className?: string }) => createElement("span", { className }, "T"),
}));

vi.mock("./toggle-list-icon", () => ({
  ToggleListIcon: ({ className }: { className?: string }) =>
    createElement("span", { className }, "L"),
}));

const apiMock: {
  invokeImplementation: (...args: unknown[]) => Promise<unknown>;
  searchPages: ReturnType<typeof vi.fn<typeof import("../../lib/api").searchPages>>;
} = vi.hoisted(() => ({
  invokeImplementation: async () => [],
  searchPages: vi.fn<typeof import("../../lib/api").searchPages>(async () => ({
    libraryId: "palette-test-library",
    storeEpoch: "palette-test-epoch",
    commitSeq: 0,
    results: [],
  })),
}));

vi.mock("../../lib/api", () => ({
  searchPages: apiMock.searchPages,
  subscribeLibraryChanges: () => () => undefined,
}));

vi.mock("../../lib/renderer-command", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/renderer-command")>()),
  invokeRendererQuery: (...args: unknown[]) => apiMock.invokeImplementation(...args),
}));

function makeCommandContext(
  overrides: Partial<CommandPaletteShellCommandContext> = {},
): CommandPaletteShellCommandContext {
  return {
    canGoBack: true,
    canGoForward: true,
    canStartNewChat: true,
    canStartNewChatInProject: true,
    pageCreateUnavailableReason: null,
    showMockCommands: false,
    hasActiveSession: true,
    activeSessionPinned: false,
    hasAttachedThread: true,
    canExportConversationMarkdown: true,
    panelActionAvailability: {
      db_view: true,
      page_stage: true,
      canvas_stage: true,
      terminal: true,
      browser: true,
      review: true,
      files: true,
      side_chat: true,
    },
    canOpenSessionInNewWindow: true,
    isMac: true,
    ...overrides,
  };
}

describe("buildCommandPaletteCommands", () => {
  test("offers skill reload only when the selected conversation has a discovery action", () => {
    const commands = (canReloadSkills?: boolean) =>
      buildCommandPaletteCommands(makeCommandContext({ canReloadSkills })).filter(
        (command) => command.id === "forceReloadSkills",
      );
    expect(commands(true)).toHaveLength(1);
    expect(commands(true)[0]?.disabled).not.toBe(true);
    expect(commands(false)).toEqual([]);
    expect(commands()).toEqual([]);
  });

  test("exposes Create Page with contextual availability", () => {
    const available = buildCommandPaletteCommands(makeCommandContext()).find(
      (command) => command.id === "createPage",
    );
    const unavailable = buildCommandPaletteCommands(
      makeCommandContext({
        pageCreateUnavailableReason: "Focus a Board before creating a Page.",
      }),
    ).find((command) => command.id === "createPage");

    expect(available?.shortcut).toBe("C");
    expect(Boolean(available?.disabled)).toBe(false);
    expect(unavailable?.disabled).toBe(true);
    expect(unavailable?.disabledReason).toBe("Focus a Board before creating a Page.");
    expect(unavailable?.mockReason).toBeUndefined();
  });

  test("includes the Codex toggleSidebar command with Cmd+B shortcut", async () => {
    const commands = buildCommandPaletteCommands(makeCommandContext());
    const sidebarCommand = commands.find((command) => command.id === TOGGLE_SIDEBAR_COMMAND_ID);

    expect(sidebarCommand?.title).toBe("Toggle sidebar");
    expect(sidebarCommand?.shortcut).toBe("⌘B");
  });

  test("includes find as a real shell command", () => {
    const commands = buildCommandPaletteCommands(makeCommandContext());
    const findCommand = commands.find((command) => command.id === "findInThread");

    expect(findCommand?.title).toBe("Find");
    expect(Boolean(findCommand?.disabled)).toBe(false);
    expect(Boolean(findCommand?.mockReason)).toBe(false);
  });

  test("includes Manage automations as a real shell command", () => {
    const commands = buildCommandPaletteCommands(makeCommandContext());
    const manageTasksCommand = commands.find((command) => command.id === "manageTasks");

    expect(manageTasksCommand?.title).toBe("Manage automations");
    expect(Boolean(manageTasksCommand?.disabled)).toBe(false);
    expect(Boolean(manageTasksCommand?.mockReason)).toBe(false);
  });

  test("includes Process Manager as a real shell command", () => {
    const commands = buildCommandPaletteCommands(makeCommandContext());
    const processManagerCommand = commands.find((command) => command.id === "openProcessManager");

    expect(processManagerCommand?.title).toBe("Process Manager");
    expect(processManagerCommand?.shortcut).toBe("⌃⌥M");
    expect(Boolean(processManagerCommand?.disabled)).toBe(false);
    expect(Boolean(processManagerCommand?.mockReason)).toBe(false);
  });

  test("omits legacy stage and DB view-switch commands", () => {
    const commands = buildCommandPaletteCommands(makeCommandContext());
    const ids = commands.map((command) => command.id).join(",");

    expect(ids.includes("focus-views-stage")).toBe(false);
    expect(ids.includes("focus-pages-stage")).toBe(false);
    expect(ids.includes("focus-threads-stage")).toBe(false);
    expect(ids.includes("focus-diff-stage")).toBe(false);
    expect(ids.includes("view-board")).toBe(false);
    expect(ids.includes("view-list")).toBe(false);
    expect(ids.includes("view-toggle-list")).toBe(false);
    expect(ids.includes("view-canvas")).toBe(false);
    expect(ids.includes("view-calendar")).toBe(false);
    expect(ids.includes("open-project-picker")).toBe(false);
    expect(ids.includes("search-current-project")).toBe(false);
  });

  test("omits dev-only mock commands and removed redundant commands in production contexts", () => {
    const commands = buildCommandPaletteCommands(
      makeCommandContext({
        showMockCommands: false,
      }),
    );
    const ids = commands.map((command) => command.id).join(",");

    expect(commands.some((command) => command.mockReason !== undefined)).toBe(false);
    expect(commands.find((command) => command.id === "searchFiles")?.disabled).toBe(false);
    expect(ids.includes("git.commit")).toBe(false);
    expect(ids.includes("toggleBrowserPanel")).toBe(false);
    expect(ids.includes("openPageStage")).toBe(false);
  });

  test("keeps unsupported parity commands as disabled mock rows in dev contexts", () => {
    const commands = buildCommandPaletteCommands(
      makeCommandContext({
        showMockCommands: true,
      }),
    );
    const libraryFiles = commands.find((command) => command.id === "openLibraryFiles");
    const gitCommit = commands.find((command) => command.id === "git.commit");
    const ids = commands.map((command) => command.id).join(",");

    expect(libraryFiles?.disabled).not.toBe(true);
    expect(libraryFiles?.mockReason).toBeUndefined();
    expect(gitCommit?.disabled).toBe(true);
    expect(Boolean(gitCommit?.mockReason)).toBe(true);
    expect(ids.includes("toggleBrowserPanel")).toBe(false);
    expect(ids.includes("openPageStage")).toBe(false);
  });

  test("uses custom command-keymap labels for shell commands", () => {
    const commands = buildCommandPaletteCommands(
      makeCommandContext({
        commandKeymapState: createCommandKeymapState(
          {
            toggleSidebar: ["CmdOrCtrl+Alt+B"],
          },
          "macOS",
        ),
      }),
    );
    const sidebarCommand = commands.find((command) => command.id === TOGGLE_SIDEBAR_COMMAND_ID);

    expect(sidebarCommand?.shortcut).toBe("⌘⌥B");
  });

  test("omits the shortcut label when a shell command is explicitly unassigned", () => {
    const commands = buildCommandPaletteCommands(
      makeCommandContext({
        commandKeymapState: createCommandKeymapState(
          {
            [TOGGLE_BOTTOM_PANEL_COMMAND_ID]: [],
          },
          "macOS",
        ),
      }),
    );
    const bottomPanelCommand = commands.find(
      (command) => command.id === TOGGLE_BOTTOM_PANEL_COMMAND_ID,
    );

    expect(bottomPanelCommand?.shortcut).toBeUndefined();
  });

  test("disables unavailable session and side-chat commands", () => {
    const commands = buildCommandPaletteCommands(
      makeCommandContext({
        hasActiveSession: false,
        hasAttachedThread: false,
        panelActionAvailability: {
          db_view: false,
          page_stage: false,
          canvas_stage: false,
          terminal: false,
          browser: false,
          review: false,
          files: false,
          side_chat: false,
        },
      }),
    );
    const renameCommand = commands.find((command) => command.id === RENAME_THREAD_COMMAND_ID);
    const archiveCommand = commands.find((command) => command.id === "archiveThread");
    const sideChatCommand = commands.find((command) => command.id === "openSideChat");
    const dbViewCommand = commands.find((command) => command.id === OPEN_DB_VIEW_TAB_COMMAND_ID);

    expect(renameCommand?.disabled).toBe(true);
    expect(archiveCommand?.disabled).toBe(true);
    expect(sideChatCommand?.disabled).toBe(true);
    expect(dbViewCommand?.disabled).toBe(true);
  });

  test("keeps general New chat available without an active Project", () => {
    const commands = buildCommandPaletteCommands(
      makeCommandContext({
        canStartNewChat: true,
        canStartNewChatInProject: false,
      }),
    );

    expect(commands.find((command) => command.id === "newThread")?.disabled).toBe(false);
    expect(commands.find((command) => command.id === "newThreadInProject")?.disabled).toBe(true);
  });

  test("keeps Codex transcript export unavailable for another attached backend", () => {
    const commands = buildCommandPaletteCommands(
      makeCommandContext({
        hasAttachedThread: true,
        canExportConversationMarkdown: false,
      }),
    );

    expect(commands.find((command) => command.id === "copyConversationMarkdown")).toBeUndefined();
  });

  test("uses the shared panel eligibility for attached projectless chats", () => {
    const commands = buildCommandPaletteCommands(
      makeCommandContext({
        panelActionAvailability: {
          db_view: false,
          page_stage: false,
          canvas_stage: false,
          terminal: true,
          browser: true,
          review: false,
          files: false,
          side_chat: true,
        },
      }),
    );

    const disabledById = Object.fromEntries(
      commands.map((command) => [command.id, command.disabled]),
    );
    expect(disabledById.openSideChat).toBe(false);
    expect(disabledById.openBrowserTab).toBe(false);
    expect(disabledById.toggleTerminal).toBe(false);
    expect(disabledById.toggleFileTreePanel).toBe(true);
    expect(disabledById.openReviewTab).toBe(true);
    expect(disabledById.openDbViewTab).toBe(true);
  });
});

function makePage(overrides: Partial<DatabasePageSummary> = {}): DatabasePageSummary {
  const descriptionPreview =
    overrides.descriptionPreview ?? "Rebuild the fuzzy search indxer for the palette.";
  const title = overrides.title ?? "Misc task";
  return {
    id: overrides.id ?? "page-1",
    pageKey: overrides.pageKey ?? null,
    title,
    richTitle: overrides.richTitle ?? plainTextToPortableRichText(title),
    descriptionPreview,
    descriptionLength: overrides.descriptionLength ?? descriptionPreview.length,
    hasDescription: overrides.hasDescription ?? descriptionPreview.length > 0,
    status: overrides.status ?? "build",
    archived: overrides.archived ?? false,
    priority: overrides.priority,
    estimate: overrides.estimate,
    tags: overrides.tags ?? ["search"],
    dueDate: overrides.dueDate,
    scheduledStart: overrides.scheduledStart,
    scheduledEnd: overrides.scheduledEnd,
    isAllDay: overrides.isAllDay ?? false,
    recurrence: overrides.recurrence,
    reminders: overrides.reminders ?? [],
    scheduleTimezone: overrides.scheduleTimezone,
    assignee: overrides.assignee,
    runInTarget: overrides.runInTarget ?? "localProject",
    runInLocalPath: overrides.runInLocalPath,
    runInBaseBranch: overrides.runInBaseBranch,
    runInWorktreePath: overrides.runInWorktreePath,
    runInEnvironmentPath: overrides.runInEnvironmentPath,
    revision: overrides.revision ?? 1,
    created: overrides.created ?? new Date("2026-03-14T00:00:00.000Z"),
    order: overrides.order ?? 0,
  };
}

function makePalettePage(overrides: Partial<CommandPalettePage> = {}): CommandPalettePage {
  const page = overrides.page ?? makePage();
  return {
    kind: "page",
    id: overrides.id ?? `${overrides.projectId ?? "default"}:${page.id}`,
    projectId: overrides.projectId ?? "default",
    projectName: overrides.projectName ?? "Default",
    projectAppearance: overrides.projectAppearance ?? DEFAULT_PROJECT_APPEARANCE,
    columnName: overrides.columnName ?? "In progress",
    page,
    tagLabels: overrides.tagLabels ?? page.tags,
    inActiveProject: overrides.inActiveProject ?? true,
    recentIndex: overrides.recentIndex ?? null,
    boardIndex: overrides.boardIndex ?? 0,
  };
}

function makePaletteThread(overrides: Partial<CommandPaletteThread> = {}): CommandPaletteThread {
  return {
    kind: "thread",
    id: overrides.id ?? "thread:thr-palette",
    threadId: overrides.threadId ?? "thr-palette",
    sessionId: overrides.sessionId === undefined ? "session-palette" : overrides.sessionId,
    projectId: overrides.projectId === undefined ? "default" : overrides.projectId,
    projectName: overrides.projectName === undefined ? "Default" : overrides.projectName,
    title: overrides.title ?? "Thread transcript search",
    preview: overrides.preview ?? "Search previous assistant messages from the command palette.",
    cwd: overrides.cwd ?? "/tmp/default",
    gitBranch: overrides.gitBranch ?? null,
    projectless: overrides.projectless ?? false,
    pinned: overrides.pinned ?? false,
    pinnedOrder: overrides.pinnedOrder ?? null,
    statusType: overrides.statusType ?? "notLoaded",
    statusActiveFlags: overrides.statusActiveFlags ?? [],
    createdAt: overrides.createdAt ?? 1_781_990_400,
    updatedAt: overrides.updatedAt ?? 1_781_990_400,
    inActiveProject: overrides.inActiveProject ?? true,
    searchPreview: overrides.searchPreview,
    searchDecorations: overrides.searchDecorations,
  };
}

function makePaletteCommand(overrides: Partial<CommandPaletteCommand> = {}): CommandPaletteCommand {
  return {
    kind: "command",
    id: overrides.id ?? "settings",
    group: overrides.group ?? "Configure",
    title: overrides.title ?? "Settings",
    subtitle: overrides.subtitle ?? "Open settings",
    keywords: overrides.keywords ?? ["settings"],
    shortcut: overrides.shortcut,
    active: overrides.active,
    disabled: overrides.disabled,
    disabledReason: overrides.disabledReason,
    mockReason: overrides.mockReason,
    priority: overrides.priority ?? 100,
  };
}

function makePageSearchBatch(
  overrides: Partial<CommandPalettePageSearchBatch> = {},
): CommandPalettePageSearchBatch {
  return {
    query: overrides.query ?? "page",
    scopeKey: overrides.scopeKey ?? "default",
    results: overrides.results ?? [],
    status: overrides.status ?? "success",
    error: overrides.error ?? null,
  };
}

function makePageSearchResult(
  item: CommandPalettePage,
  overrides: Partial<PageSearchResult> = {},
): PageSearchResult {
  const page = item.page as DatabasePageSummary;
  return {
    projectId: item.projectId,
    pageId: page.id,
    pageKey: page.pageKey,
    title: page.title,
    status: page.status,
    priority: page.priority ?? null,
    tags: page.tags.map((label) => ({
      dataSourceId: `source:${item.projectId}`,
      propertyId: "tags",
      optionId: label,
      label,
    })),
    assignee: page.assignee ?? null,
    locationLabel: `${item.projectName} / ${item.columnName}`,
    titleParts: [],
    excerpt: page.descriptionPreview || null,
    excerptParts: page.descriptionPreview
      ? [{ text: page.descriptionPreview, highlighted: false }]
      : [],
    matches: [],
    updatedAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("CommandPaletteSurface", () => {
  test("closes on Escape without replacing the live query", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const close = vi.fn();
    const view = render(
      <CommandPaletteSurface
        open
        openTriggerTick={1}
        mode="actions"
        initialQuery="settings"
        commands={[]}
        loading={false}
        pagesLoading={false}
        chatsLoading={false}
        onChangeMode={() => undefined}
        onRequestClose={close}
        onExecute={() => undefined}
      />,
    );
    await settleAsyncRender();
    const input = view.getByRole("combobox");
    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
      await Promise.resolve();
    });
    expect(close).toHaveBeenCalledOnce();
    expect(input).toHaveProperty("value", "settings");
  });

  test("preserves the query and input focus when switching scopes by click or Tab", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    function Harness() {
      const [mode, setMode] = useState<CommandMenuMode>("root");
      return (
        <CommandPaletteSurface
          open
          openTriggerTick={1}
          mode={mode}
          initialQuery="settings"
          commands={[makePaletteCommand()]}
          loading={false}
          pagesLoading={false}
          chatsLoading={false}
          onChangeMode={setMode}
          onRequestClose={() => undefined}
          onExecute={() => undefined}
        />
      );
    }
    const view = render(<Harness />);
    const input = view.getByRole("combobox");
    await waitFor(() => expect(document.activeElement).toBe(input));
    await act(async () => {
      fireEvent.mouseDown(view.getByRole("tab", { name: "Actions" }));
      fireEvent.click(view.getByRole("tab", { name: "Actions" }));
      await Promise.resolve();
    });
    expect(view.getByRole("tab", { name: "Actions" }).getAttribute("aria-selected")).toBe("true");
    expect(input).toHaveProperty("value", "settings");
    expect(document.activeElement).toBe(input);
    await act(async () => {
      fireEvent.keyDown(input, { key: "Tab" });
      await Promise.resolve();
    });
    expect(view.getByRole("tab", { name: "Chats" }).getAttribute("aria-selected")).toBe("true");
    expect(input).toHaveProperty("value", "settings");
    expect(document.activeElement).toBe(input);
    await act(async () => {
      fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
      await Promise.resolve();
    });
    expect(view.getByRole("tab", { name: "Actions" }).getAttribute("aria-selected")).toBe("true");
    expect(input).toHaveProperty("value", "settings");
    expect(document.activeElement).toBe(input);
    expect(view.queryByRole("tab", { name: "Files" })).not.toBeNull();
    expect(view.queryByRole("tab", { name: "Text" })).not.toBeNull();
    await act(async () => {
      for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
        expect(fireEvent.keyDown(input, { key: "Tab", ...modifier })).toBe(true);
      }
      await Promise.resolve();
    });
    expect(view.getByRole("tab", { name: "Actions" }).getAttribute("aria-selected")).toBe("true");

    await act(async () => {
      fireEvent.keyDown(input, { key: "F6" });
      await Promise.resolve();
    });
    const activeScope = view.getByRole("tab", { name: "Actions" });
    expect(document.activeElement).toBe(activeScope);
    await act(async () => {
      fireEvent.keyDown(activeScope, { key: "F6" });
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(input);
    await act(async () => {
      fireEvent.click(view.getByRole("tab", { name: "Pages" }));
      await Promise.resolve();
    });
    const filter = view.getByRole("button", { name: "Filter pages" });
    await act(async () => {
      fireEvent.keyDown(input, { key: "F6" });
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(filter);
    await act(async () => {
      fireEvent.keyDown(filter, { key: "F6" });
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(input);
  });

  test("leaves IME acceptance and navigation with the composition owner", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const surfaceRef = createRef<CommandPaletteSurfaceHandle>();
    const execute = vi.fn();
    const changeMode = vi.fn();
    const close = vi.fn();
    const view = render(
      <CommandPaletteSurface
        ref={surfaceRef}
        open
        openTriggerTick={1}
        mode="actions"
        commands={[makePaletteCommand(), makePaletteCommand({ id: "other", title: "Other" })]}
        loading={false}
        pagesLoading={false}
        chatsLoading={false}
        onChangeMode={changeMode}
        onRequestClose={close}
        onExecute={execute}
      />,
    );
    await settleAsyncRender();
    const input = view.getByRole("combobox");
    const selected = input.getAttribute("aria-activedescendant");
    await act(async () => {
      fireEvent.compositionStart(input);
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.keyDown(input, { key: "Tab" });
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "Escape" });
      await Promise.resolve();
    });
    expect(surfaceRef.current?.isComposing()).toBe(true);
    expect(input.getAttribute("aria-activedescendant")).toBe(selected);
    await act(async () => {
      fireEvent.compositionEnd(input);
      fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
      fireEvent.keyDown(input, { key: "Tab", keyCode: 229 });
      fireEvent.keyDown(input, { key: "Enter", isComposing: true });
      fireEvent.keyDown(input, { key: "Tab", isComposing: true });
      await Promise.resolve();
    });
    expect(surfaceRef.current?.isComposing()).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(changeMode).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  test("opens All with quick actions and recent content, and Actions with the complete catalog", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const pages = Array.from({ length: 8 }, (_, index) =>
      makePalettePage({
        id: `default:recent-page-${index}`,
        page: makePage({ id: `recent-page-${index}`, title: `Recent page ${index}` }),
      }),
    );
    const threads = Array.from({ length: 8 }, (_, index) =>
      makePaletteThread({
        id: `thread:recent-${index}`,
        threadId: `recent-${index}`,
        title: `Recent chat ${index}`,
      }),
    );
    function Harness() {
      const [mode, setMode] = useState<CommandMenuMode>("root");
      return (
        <CommandPaletteSurface
          open
          openTriggerTick={1}
          mode={mode}
          commands={[
            makePaletteCommand({ id: "newThread", title: "New chat" }),
            makePaletteCommand({ id: "openFolder", title: "Open folder" }),
            makePaletteCommand(),
          ]}
          pages={pages}
          threads={threads}
          pageSearchBatch={makePageSearchBatch({
            query: "",
            results: pages.map((page) => makePageSearchResult(page)),
          })}
          loading={false}
          pagesLoading={false}
          chatsLoading={false}
          onChangeMode={setMode}
          onRequestClose={() => undefined}
          onExecute={() => undefined}
        />
      );
    }
    const view = render(<Harness />);
    await settleAsyncRender();
    expect(view.getByRole("group", { name: "Quick actions" })).toBeTruthy();
    expect(view.getByRole("option", { name: "New chat" })).toBeTruthy();
    expect(view.getByRole("option", { name: "Open folder" })).toBeTruthy();
    expect(view.queryByRole("option", { name: "Settings" })).toBeNull();
    expect(view.getAllByRole("option", { name: /Recent chat/u })).toHaveLength(5);
    expect(view.getAllByRole("option", { name: /Recent page/u })).toHaveLength(5);
    await act(async () => {
      fireEvent.click(view.getByRole("tab", { name: "Actions" }));
      await Promise.resolve();
    });
    expect(view.getAllByRole("option")).toHaveLength(3);
    expect(view.getByRole("option", { name: "Settings" })).toBeTruthy();
    expect(view.queryByRole("option", { name: /Recent/u })).toBeNull();
  });

  test("expands a discovery section without closing, losing the query, or moving selection", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const pages = Array.from({ length: 12 }, (_, index) =>
      makePalettePage({
        id: `default:page-${index}`,
        page: makePage({ id: `page-${index}`, title: `Page result ${index}` }),
      }),
    );
    const close = vi.fn();
    const execute = vi.fn();
    function Harness() {
      const [mode, setMode] = useState<CommandMenuMode>("root");
      return (
        <CommandPaletteSurface
          open
          openTriggerTick={1}
          mode={mode}
          initialQuery="page"
          commands={[]}
          pages={pages}
          pageSearchBatch={makePageSearchBatch({
            results: pages.map((page) => makePageSearchResult(page)),
          })}
          threadSearchBatch={{ query: "page", results: [], loading: false, error: null }}
          loading={false}
          pagesLoading={false}
          chatsLoading={false}
          onChangeMode={setMode}
          onRequestClose={close}
          onExecute={execute}
        />
      );
    }
    const view = render(<Harness />);
    await settleAsyncRender();
    const input = view.getByRole("combobox");
    expect(view.getAllByRole("option", { name: /Page result/u })).toHaveLength(5);
    await act(async () => {
      fireEvent.keyDown(input, { key: "End" });
      await Promise.resolve();
    });
    const more = view.getByRole("option", { name: "Show more" });
    expect(input.getAttribute("aria-activedescendant")).toBe(more.id);
    const insertionId = more.id;
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });
    expect(view.getAllByRole("option", { name: /Page result/u })).toHaveLength(10);
    expect(input).toHaveProperty("value", "page");
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-activedescendant")).toBe(insertionId);
    expect(view.getByRole("option", { name: /Page result 5/u }).id).toBe(insertionId);
    const nextMore = view.getByRole("option", { name: "Show more" });
    await act(async () => {
      fireEvent.click(nextMore);
      await Promise.resolve();
    });
    expect(view.getAllByRole("option", { name: /Page result/u })).toHaveLength(12);
    expect(input.getAttribute("aria-activedescendant")).toBe(
      view.getByRole("option", { name: /Page result 10/u }).id,
    );
    expect(view.queryByRole("option", { name: "Show more" })).toBeNull();
    expect(document.activeElement).toBe(input);
    await act(async () => {
      fireEvent.click(view.getByRole("tab", { name: "Actions" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("tab", { name: "All" }));
      await Promise.resolve();
    });
    expect(input).toHaveProperty("value", "page");
    expect(view.getAllByRole("option", { name: /Page result/u })).toHaveLength(5);
    expect(close).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test("opens the top fuzzy description match when the selected result is activated", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const executedItems: CommandPalettePage[] = [];
    const closeCalls: number[] = [];
    const pages = [
      makePalettePage({
        page: makePage({
          id: "page-1",
          title: "Misc task",
          descriptionPreview: "Rebuild the fuzzy search indxer for the palette.",
        }),
      }),
    ];
    const { container } = render(
      <CommandPaletteSurface
        open
        openTriggerTick={1}
        mode="pages"
        initialQuery="search indexer"
        commands={[]}
        pages={pages}
        pageSearchBatch={makePageSearchBatch({
          query: "search indexer",
          results: [
            makePageSearchResult(pages[0]!, {
              excerptParts: [
                { text: "Rebuild the fuzzy ", highlighted: false },
                { text: "search indxer", highlighted: true },
                { text: " for the palette.", highlighted: false },
              ],
              matches: [
                {
                  source: "body",
                  quality: "fuzzy",
                  blockId: "block:page-1",
                  blockType: "paragraph",
                  parts: [
                    { text: "Rebuild the fuzzy ", highlighted: false },
                    { text: "search indxer", highlighted: true },
                    { text: " for the palette.", highlighted: false },
                  ],
                },
              ],
            }),
          ],
        })}
        loading={false}
        pagesLoading={false}
        chatsLoading={false}
        onChangeMode={() => undefined}
        onRequestClose={() => {
          closeCalls.push(1);
        }}
        onExecute={(item) => {
          if (item.kind !== "page") {
            return;
          }
          executedItems.push(item);
        }}
      />,
    );

    await settleAsyncRender();
    const topResult = container.querySelector('button[cmdk-item][data-selected="true"]');

    expect(textContent(container).includes("fuzzy search indxer")).toBe(true);
    expect(topResult).not.toBeNull();
    await act(async () => {
      fireEvent.click(topResult as HTMLElement);
      await Promise.resolve();
    });

    expect(closeCalls.length).toBe(1);
    expect(executedItems.length).toBe(1);
    expect(executedItems[0]?.page.id).toBe("page-1");
  });

  test("root mode searches commands without the legacy > prefix or unrelated Pages", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const { container, getByLabelText } = render(
      <CommandPaletteSurface
        open
        openTriggerTick={2}
        mode="root"
        initialQuery="settings"
        commands={[
          makePaletteCommand({
            id: "settings",
            title: "Settings",
            subtitle: "App preferences",
            keywords: ["settings", "preferences"],
          }),
        ]}
        pages={[
          makePalettePage({
            page: makePage({
              id: "page-2",
              title: "Misc task",
              descriptionPreview: "Should not appear while command mode is active.",
            }),
          }),
        ]}
        loading={false}
        pagesLoading={false}
        chatsLoading={false}
        onChangeMode={() => undefined}
        onRequestClose={() => undefined}
        onExecute={() => undefined}
      />,
    );

    await settleAsyncRender();

    const input = getByLabelText("Command palette search") as HTMLInputElement;
    const resultButtons = Array.from(container.querySelectorAll("button[cmdk-item]"));
    expect(input.value).toBe("settings");
    expect(resultButtons.length).toBe(1);
    expect(textContent(container).includes("Misc task")).toBe(false);
    expect(textContent(container).includes("Settings")).toBe(true);
  });

  test("runs a result with the query that found it in every scope", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const execute = vi.fn();
    const { container } = render(
      <CommandPaletteSurface
        open
        openTriggerTick={3}
        mode="actions"
        initialQuery="Fast mode"
        commands={[
          makePaletteCommand({
            id: "settings:agent",
            group: "Settings",
            title: "Agents",
            subtitle: "",
            keywords: ["settings", "Fast mode"],
          }),
        ]}
        loading={false}
        pagesLoading={false}
        chatsLoading={false}
        onChangeMode={() => undefined}
        onRequestClose={() => undefined}
        onExecute={execute}
      />,
    );

    await settleAsyncRender();
    const topResult = container.querySelector('button[cmdk-item][data-selected="true"]');
    expect(topResult).not.toBeNull();
    await act(async () => {
      fireEvent.click(topResult as HTMLElement);
      await Promise.resolve();
    });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: "settings:agent" }),
      "Fast mode",
    );
  });

  test("keeps Page search pending instead of flashing a false empty state", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const pages = [
      makePalettePage({
        page: makePage({
          id: "unrelated-page",
          title: "Release checklist",
          descriptionPreview: "Prepare the packaged build.",
        }),
      }),
    ];
    const { container } = render(
      <CommandPaletteSurface
        open
        openTriggerTick={21}
        mode="pages"
        initialQuery="vector clocks"
        commands={[]}
        pages={pages}
        pageSearchBatch={makePageSearchBatch({
          query: "previous query",
        })}
        loading={false}
        pagesLoading={false}
        chatsLoading={false}
        onChangeMode={() => undefined}
        onRequestClose={() => undefined}
        onExecute={() => undefined}
      />,
    );

    await settleAsyncRender();

    expect(textContent(container)).toContain("Loading more Pages…");
    expect(textContent(container)).not.toContain("Release checklist");
    expect(textContent(container)).not.toContain("No matching pages");
  });

  test("surfaces Core Page-search failures without falling back to local Pages", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const pages = [
      makePalettePage({
        page: makePage({
          id: "local-only-page",
          title: "Incomplete local result",
        }),
      }),
    ];
    const { container } = render(
      <CommandPaletteSurface
        open
        openTriggerTick={211}
        mode="pages"
        initialQuery="authority"
        commands={[]}
        pages={pages}
        pageSearchBatch={makePageSearchBatch({
          query: "authority",
          status: "error",
          error: "projection unavailable",
        })}
        loading={false}
        pagesLoading={false}
        chatsLoading={false}
        onChangeMode={() => undefined}
        onRequestClose={() => undefined}
        onExecute={() => undefined}
      />,
    );

    await settleAsyncRender();

    expect(textContent(container)).toContain("Full Page search is unavailable");
    expect(textContent(container)).not.toContain("Incomplete local result");
    expect(textContent(container)).not.toContain("No matching pages");
  });

  test("shows the Page empty state only after the current search settles", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const pages = [
      makePalettePage({
        page: makePage({
          id: "unrelated-page",
          title: "Release checklist",
          descriptionPreview: "Prepare the packaged build.",
        }),
      }),
    ];
    const { container } = render(
      <CommandPaletteSurface
        open
        openTriggerTick={22}
        mode="pages"
        initialQuery="vector clocks"
        commands={[]}
        pages={pages}
        pageSearchBatch={makePageSearchBatch({
          query: "vector clocks",
        })}
        loading={false}
        pagesLoading={false}
        chatsLoading={false}
        onChangeMode={() => undefined}
        onRequestClose={() => undefined}
        onExecute={() => undefined}
      />,
    );

    await settleAsyncRender();

    expect(textContent(container)).toContain("No matching pages");
    expect(textContent(container)).not.toContain("Loading more Pages…");
  });

  test("caps root Page discovery at five results", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const pages = Array.from({ length: 10 }, (_, index) =>
      makePalettePage({
        id: `default:page-result-${index}`,
        boardIndex: index,
        page: makePage({
          id: `page-result-${index}`,
          title: `Page result ${index}`,
          descriptionPreview: "Root discovery result.",
        }),
      }),
    );
    const { container } = render(
      <CommandPaletteSurface
        open
        openTriggerTick={23}
        mode="root"
        initialQuery="page"
        commands={[]}
        pages={pages}
        threads={[]}
        threadSearchIndex={createCommandPaletteThreadSearchIndex([])}
        pageSearchBatch={makePageSearchBatch({
          results: pages.map((page) => makePageSearchResult(page)),
        })}
        threadSearchBatch={{ query: "page", results: [], loading: false, error: null }}
        loading={false}
        pagesLoading={false}
        chatsLoading={false}
        onChangeMode={() => undefined}
        onRequestClose={() => undefined}
        onExecute={() => undefined}
      />,
    );

    await settleAsyncRender();

    const pageButtons = Array.from(container.querySelectorAll("button[cmdk-item]")).filter(
      (button) => button.textContent?.includes("Page result"),
    );
    expect(pageButtons).toHaveLength(5);
    expect(textContent(container)).toContain("Pages");
  });

  test("surfaces Page body-only matches in root mode", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const pages = [
      makePalettePage({
        page: makePage({
          id: "body-only-page",
          title: "Replication design note",
          descriptionPreview: "No local metadata match.",
        }),
      }),
    ];
    const { container } = render(
      <CommandPaletteSurface
        open
        openTriggerTick={231}
        mode="root"
        initialQuery="vector clocks"
        commands={[]}
        pages={pages}
        threads={[]}
        threadSearchIndex={createCommandPaletteThreadSearchIndex([])}
        pageSearchBatch={makePageSearchBatch({
          query: "vector clocks",
          results: [
            {
              projectId: "default",
              pageId: "body-only-page",
              pageKey: null,
              title: "Body-only page",
              status: "build",
              priority: null,
              tags: [],
              assignee: null,
              locationLabel: "Default / Build",
              titleParts: [],
              excerpt: "Document vector clocks and replicated queue recovery.",
              excerptParts: [
                { text: "Document ", highlighted: false },
                { text: "vector clocks", highlighted: true },
                { text: " and replicated queue recovery.", highlighted: false },
              ],
              matches: [
                {
                  source: "body",
                  quality: "exact",
                  blockId: "block:vector-clocks",
                  blockType: "paragraph",
                  parts: [
                    { text: "Document ", highlighted: false },
                    { text: "vector clocks", highlighted: true },
                    { text: " and replicated queue recovery.", highlighted: false },
                  ],
                },
              ],
              updatedAt: "2026-08-17T00:00:00.000Z",
            },
          ],
        })}
        threadSearchBatch={{ query: "vector clocks", results: [], loading: false, error: null }}
        loading={false}
        pagesLoading={false}
        chatsLoading={false}
        onChangeMode={() => undefined}
        onRequestClose={() => undefined}
        onExecute={() => undefined}
      />,
    );

    await settleAsyncRender();

    expect(textContent(container)).toContain("Body-only page");
    expect(textContent(container)).toContain("vector clocks");
    expect(textContent(container)).toContain("Pages");
  });

  test("keeps five Page results alongside independent command and chat sections", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const pages = Array.from({ length: 8 }, (_, index) =>
      makePalettePage({
        id: `default:page-result-${index}`,
        boardIndex: index,
        page: makePage({
          id: `page-result-${index}`,
          title: `Page result ${index}`,
        }),
      }),
    );
    const threads = Array.from({ length: 2 }, (_, index) =>
      makePaletteThread({
        id: `thread:page-chat-${index}`,
        threadId: `page-chat-${index}`,
        title: `Page chat ${index}`,
      }),
    );
    const commands = Array.from({ length: 2 }, (_, index) =>
      makePaletteCommand({
        id: `page-command-${index}`,
        title: `Page command ${index}`,
        keywords: ["page"],
      }),
    );
    const { container } = render(
      <CommandPaletteSurface
        open
        openTriggerTick={24}
        mode="root"
        initialQuery="page"
        commands={commands}
        pages={pages}
        threads={threads}
        threadSearchIndex={createCommandPaletteThreadSearchIndex(threads)}
        pageSearchBatch={makePageSearchBatch({
          results: pages.map((page) => makePageSearchResult(page)),
        })}
        threadSearchBatch={{ query: "page", results: [], loading: false, error: null }}
        loading={false}
        pagesLoading={false}
        chatsLoading={false}
        onChangeMode={() => undefined}
        onRequestClose={() => undefined}
        onExecute={() => undefined}
      />,
    );

    await settleAsyncRender();

    const pageButtons = Array.from(container.querySelectorAll("button[cmdk-item]")).filter(
      (button) => button.textContent?.includes("Page result"),
    );
    expect(container.querySelectorAll("button[cmdk-item]")).toHaveLength(10);
    expect(pageButtons).toHaveLength(5);
  });

  test("renders and executes chat results from chats mode", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const executedItems: CommandPaletteThread[] = [];
    const closeCalls: number[] = [];
    const threads = [
      makePaletteThread({
        threadId: "thr-thread-search",
        id: "thread:thr-thread-search",
        sessionId: null,
        projectId: null,
        projectName: null,
        projectless: true,
        title: "Thread transcript search",
        preview: "Search previous assistant messages from the command palette.",
      }),
    ];
    const { container } = render(
      <CommandPaletteSurface
        open
        openTriggerTick={5}
        mode="chats"
        initialQuery="thread transcript"
        commands={[]}
        pages={[]}
        threads={threads}
        threadSearchIndex={createCommandPaletteThreadSearchIndex(threads)}
        loading={false}
        pagesLoading={false}
        chatsLoading={false}
        onChangeMode={() => undefined}
        onRequestClose={() => {
          closeCalls.push(1);
        }}
        onExecute={(item) => {
          if (item.kind === "thread") executedItems.push(item);
        }}
      />,
    );

    await settleAsyncRender();

    const topResult = container.querySelector('button[cmdk-item][data-selected="true"]');
    expect(textContent(container).includes("Chats")).toBe(true);
    expect(textContent(container).includes("Thread transcript search")).toBe(true);
    expect(topResult).not.toBeNull();
    await act(async () => {
      fireEvent.click(topResult as HTMLElement);
      await Promise.resolve();
    });

    expect(closeCalls.length).toBe(1);
    expect(executedItems.length).toBe(1);
    expect(executedItems[0]?.threadId).toBe("thr-thread-search");
  });

  test("pages mode does not render chat results", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const pages = [
      makePalettePage({
        page: makePage({
          id: "page-thread-search",
          title: "Thread transcript page",
          descriptionPreview: "Page notes about thread transcript search.",
        }),
      }),
    ];
    const threads = [
      makePaletteThread({
        threadId: "thr-thread-search",
        id: "thread:thr-thread-search",
        title: "Thread transcript session",
        preview: "Search previous assistant messages from the command palette.",
      }),
    ];
    const { container } = render(
      <CommandPaletteSurface
        open
        openTriggerTick={6}
        mode="pages"
        initialQuery="thread transcript"
        commands={[]}
        pages={pages}
        threads={threads}
        threadSearchIndex={createCommandPaletteThreadSearchIndex(threads)}
        pageSearchBatch={makePageSearchBatch({
          query: "thread transcript",
          results: pages.map((page) => makePageSearchResult(page)),
        })}
        loading={false}
        pagesLoading={false}
        chatsLoading={false}
        onChangeMode={() => undefined}
        onRequestClose={() => undefined}
        onExecute={() => undefined}
      />,
    );

    await settleAsyncRender();

    const resultButtons = Array.from(container.querySelectorAll("button[cmdk-item]"));
    expect(resultButtons.length).toBe(1);
    expect(textContent(container).includes("Thread transcript session")).toBe(false);
    expect(textContent(container).includes("Thread transcript page")).toBe(true);
  });

  test("renders and highlights an app-server chat content snippet", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const threads = [
      makePaletteThread({
        threadId: "thr-content-hit",
        id: "thread:thr-content-hit",
        title: "Content hit",
        preview: "",
      }),
    ];
    apiMock.invokeImplementation = async (channel: unknown) => {
      if (channel === "codex:threads:palette:search") {
        return [
          {
            thread: {
              threadId: "thr-content-hit",
              sessionId: null,
              projectId: "default",
              projectName: "Default",
              title: "Content hit",
              preview: "",
              cwd: "/tmp/default",
              gitBranch: null,
              projectless: false,
              pinned: false,
              pinnedOrder: null,
              statusType: "notLoaded",
              statusActiveFlags: [],
              createdAt: 1,
              updatedAt: 1,
            },
            snippet: "backend snippet",
          },
        ];
      }
      return [];
    };

    let container!: HTMLElement;
    vi.useFakeTimers();
    try {
      ({ container } = render(
        <CommandPaletteSurface
          open
          openTriggerTick={7}
          mode="chats"
          initialQuery="snippet"
          commands={[]}
          pages={[]}
          threads={threads}
          threadSearchIndex={createCommandPaletteThreadSearchIndex(threads)}
          loading={false}
          pagesLoading={false}
          chatsLoading={false}
          onChangeMode={() => undefined}
          onRequestClose={() => undefined}
          onExecute={() => undefined}
        />,
      ));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(240);
      });
    } finally {
      vi.useRealTimers();
    }
    await settleAsyncRender();

    expect(textContent(container).includes("backend snippet")).toBe(true);
    apiMock.invokeImplementation = async () => [];
  });

  test("keeps commands and metadata chats together in root mode", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const threads = [makePaletteThread({ title: "Open historical chat" })];
    const { container } = render(
      <CommandPaletteSurface
        open
        openTriggerTick={71}
        mode="root"
        initialQuery="open"
        commands={[makePaletteCommand({ title: "Open settings", keywords: ["open"] })]}
        pages={[]}
        threads={threads}
        threadSearchIndex={createCommandPaletteThreadSearchIndex(threads)}
        threadSearchBatch={{ query: "open", results: [], loading: false, error: null }}
        loading={false}
        pagesLoading={false}
        chatsLoading={false}
        onChangeMode={() => undefined}
        onRequestClose={() => undefined}
        onExecute={() => undefined}
      />,
    );

    await settleAsyncRender();

    expect(textContent(container)).toContain("Open settings");
    expect(textContent(container)).toContain("Open historical chat");
    expect(textContent(container)).toContain("Chats");
  });

  test("keeps five root metadata chats interactive while content search is pending", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const threads = Array.from({ length: 9 }, (_, index) =>
      makePaletteThread({
        id: `thread:common-${index}`,
        threadId: `common-${index}`,
        title: `Common chat ${index}`,
      }),
    );
    const { container } = render(
      <CommandPaletteSurface
        open
        openTriggerTick={72}
        mode="root"
        initialQuery="common"
        commands={[]}
        pages={[]}
        threads={threads}
        threadSearchIndex={createCommandPaletteThreadSearchIndex(threads)}
        threadSearchBatch={{ query: "common", results: [], loading: true, error: null }}
        loading={false}
        pagesLoading={false}
        chatsLoading={false}
        onChangeMode={() => undefined}
        onRequestClose={() => undefined}
        onExecute={() => undefined}
      />,
    );

    await settleAsyncRender();

    expect(container.querySelectorAll("button[cmdk-item]")).toHaveLength(6);
    expect(textContent(container)).toContain("Loading chats…");
  });

  test("keeps local chat matches visible when app-server search fails", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const threads = [makePaletteThread({ title: "Fallback metadata chat" })];
    const { container } = render(
      <CommandPaletteSurface
        open
        openTriggerTick={73}
        mode="root"
        initialQuery="fallback"
        commands={[]}
        pages={[]}
        threads={threads}
        threadSearchIndex={createCommandPaletteThreadSearchIndex(threads)}
        threadSearchBatch={{ query: "fallback", results: [], loading: false, error: "offline" }}
        loading={false}
        pagesLoading={false}
        chatsLoading={false}
        onChangeMode={() => undefined}
        onRequestClose={() => undefined}
        onExecute={() => undefined}
      />,
    );

    await settleAsyncRender();

    expect(textContent(container)).toContain("Fallback metadata chat");
    expect(textContent(container)).toContain("Local matches are still shown");
  });

  test("deduplicates concurrent app-server searches and reuses the short-lived cache", async () => {
    const { clearCommandPaletteThreadSearchCacheForTests, searchCommandPaletteThreads } =
      await import("../../lib/command-palette-chat-search");
    const searchedQueries: string[] = [];
    apiMock.invokeImplementation = async (channel: unknown, input: unknown) => {
      if (channel === "codex:threads:palette:search") {
        const query =
          typeof input === "object" && input !== null && "query" in input
            ? String((input as { query?: unknown }).query ?? "")
            : "";
        searchedQueries.push(query);
        return [];
      }
      return [];
    };
    clearCommandPaletteThreadSearchCacheForTests();

    await Promise.all([
      searchCommandPaletteThreads({ query: "refresh" }),
      searchCommandPaletteThreads({ query: "refresh" }),
    ]);
    await searchCommandPaletteThreads({ query: "refresh" });

    expect(searchedQueries).toEqual(["refresh"]);
    apiMock.invokeImplementation = async () => [];
  });

  test("deduplicates only concurrent Page requests and keeps no renderer result cache", async () => {
    const { searchCommandPalettePages } = await import("../../lib/command-palette-page-results");
    const searchedQueries: string[] = [];
    await apiMock.searchPages.withImplementation(
      async (input) => {
        searchedQueries.push(input.query);
        return {
          libraryId: "palette-test-library",
          storeEpoch: "palette-test-epoch",
          commitSeq: 0,
          results: [],
        };
      },
      async () => {
        await Promise.all([
          searchCommandPalettePages({ projectIds: ["default"], query: "page cache" }),
          searchCommandPalettePages({ projectIds: ["default"], query: "page cache" }),
        ]);
        await searchCommandPalettePages({ projectIds: ["default"], query: "page cache" });
        expect(searchedQueries).toEqual(["page cache", "page cache"]);
      },
    );
  });

  test("skips disabled commands and updates aria-activedescendant during keyboard navigation", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const executedItems: CommandPaletteCommand[] = [];
    const { container, getByLabelText } = render(
      <CommandPaletteSurface
        open
        openTriggerTick={4}
        mode="actions"
        initialQuery=""
        commands={[
          makePaletteCommand({
            id: "disabled-command",
            title: "Disabled command",
            subtitle: "Cannot run",
            keywords: ["disabled"],
            disabled: true,
            priority: 300,
          }),
          makePaletteCommand({
            id: "forward-command",
            title: "Forward command",
            subtitle: "Can run",
            keywords: ["forward"],
            priority: 200,
          }),
          makePaletteCommand({
            id: "settings",
            title: "Settings",
            subtitle: "Can run",
            keywords: ["settings"],
            priority: 100,
          }),
        ]}
        pages={[]}
        loading={false}
        pagesLoading={false}
        chatsLoading={false}
        onChangeMode={() => undefined}
        onRequestClose={() => undefined}
        onExecute={(item) => {
          if (item.kind === "command") executedItems.push(item);
        }}
      />,
    );

    await settleAsyncRender();

    const input = getByLabelText("Command palette search") as HTMLInputElement;
    const firstActiveId = input.getAttribute("aria-activedescendant");
    const firstActive = firstActiveId ? container.querySelector(`[id="${firstActiveId}"]`) : null;

    expect(firstActiveId !== null).toBe(true);
    expect(firstActive?.textContent?.includes("Forward command")).toBe(true);

    await act(async () => {
      fireEvent.keyDown(input, { key: "ArrowDown" });
      await Promise.resolve();
    });
    await settleAsyncRender();

    const nextActiveId = input.getAttribute("aria-activedescendant");
    const nextActive = nextActiveId ? container.querySelector(`[id="${nextActiveId}"]`) : null;

    expect(nextActiveId !== firstActiveId).toBe(true);
    expect(nextActive?.textContent?.includes("Settings")).toBe(true);
    expect(textContent(container).includes("Mock")).toBe(false);
    await act(async () => {
      fireEvent.keyDown(input, { key: "ArrowDown" });
      await Promise.resolve();
    });
    expect(input.getAttribute("aria-activedescendant")).toBe(nextActiveId);
    await act(async () => {
      fireEvent.keyDown(input, { key: "Home" });
      await Promise.resolve();
    });
    expect(input.getAttribute("aria-activedescendant")).toBe(firstActiveId);
    await act(async () => {
      fireEvent.keyDown(input, { key: "ArrowUp" });
      await Promise.resolve();
    });
    expect(input.getAttribute("aria-activedescendant")).toBe(firstActiveId);
    await act(async () => {
      fireEvent.keyDown(input, { key: "End" });
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });
    expect(executedItems.length).toBe(1);
    expect(executedItems[0]?.id).toBe("settings");
  });

  test("jumps between enabled section entries and list edges with modified arrows", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const view = render(
      <CommandPaletteSurface
        open
        openTriggerTick={1}
        mode="actions"
        commands={[
          makePaletteCommand({ id: "suggested", title: "Suggested action", group: "Suggested" }),
          makePaletteCommand({
            id: "disabled-nav",
            title: "Disabled navigation",
            group: "Navigation",
            disabled: true,
            priority: 200,
          }),
          makePaletteCommand({ id: "back", title: "Navigate back", group: "Navigation" }),
          makePaletteCommand(),
          makePaletteCommand({
            id: "disabled-app",
            title: "Unavailable app action",
            group: "App",
            disabled: true,
          }),
        ]}
        loading={false}
        pagesLoading={false}
        chatsLoading={false}
        onChangeMode={() => undefined}
        onRequestClose={() => undefined}
        onExecute={() => undefined}
      />,
    );
    await settleAsyncRender();
    const input = view.getByRole("combobox");
    const press = async (key: string, modifiers: { altKey?: boolean; metaKey?: boolean }) => {
      await act(async () => {
        fireEvent.keyDown(input, { key, ...modifiers });
        await Promise.resolve();
      });
    };
    await press("ArrowDown", { altKey: true });
    expect(input.getAttribute("aria-activedescendant")).toBe(
      view.getByRole("option", { name: "Navigate back" }).id,
    );
    await press("ArrowDown", { altKey: true });
    expect(input.getAttribute("aria-activedescendant")).toBe(
      view.getByRole("option", { name: "Settings" }).id,
    );
    await press("ArrowUp", { altKey: true });
    expect(input.getAttribute("aria-activedescendant")).toBe(
      view.getByRole("option", { name: "Navigate back" }).id,
    );
    await press("ArrowDown", { metaKey: true });
    expect(input.getAttribute("aria-activedescendant")).toBe(
      view.getByRole("option", { name: "Settings" }).id,
    );
    await press("ArrowUp", { metaKey: true });
    expect(input.getAttribute("aria-activedescendant")).toBe(
      view.getByRole("option", { name: "Suggested action" }).id,
    );
  });

  test("marks mock commands with a visible badge and keeps them inert", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const executedItems: CommandPaletteCommand[] = [];
    const closeCalls: number[] = [];
    const { container } = render(
      <CommandPaletteSurface
        open
        openTriggerTick={5}
        mode="actions"
        initialQuery=""
        commands={[
          makePaletteCommand({
            id: "searchFiles",
            group: "Suggested",
            title: "Search files",
            subtitle: "Search workspace files",
            keywords: ["files"],
            disabled: true,
            mockReason: "Mock UI only. Not available in Nodex yet.",
            priority: 300,
          }),
          makePaletteCommand({
            id: "settings",
            title: "Settings",
            subtitle: "Can run",
            keywords: ["settings"],
            priority: 100,
          }),
        ]}
        pages={[]}
        loading={false}
        pagesLoading={false}
        chatsLoading={false}
        onChangeMode={() => undefined}
        onRequestClose={() => {
          closeCalls.push(1);
        }}
        onExecute={(item) => {
          if (item.kind === "command") executedItems.push(item);
        }}
      />,
    );

    await settleAsyncRender();

    const mockButton = Array.from(container.querySelectorAll("button[cmdk-item]")).find((button) =>
      button.textContent?.includes("Search files"),
    );

    expect(textContent(container).includes("Mock")).toBe(true);
    expect(mockButton !== undefined).toBe(true);
    expect(mockButton?.getAttribute("aria-disabled")).toBe("true");
    if (mockButton) {
      await act(async () => {
        fireEvent.click(mockButton);
        await Promise.resolve();
      });
    }
    expect(closeCalls.length).toBe(0);
    expect(executedItems.length).toBe(0);
  });

  test("renders the filter button on the search-input row", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const pages = [
      makePalettePage({
        projectId: "ops",
        projectName: "Ops",
        page: makePage({
          id: "ops-page",
          title: "Queue cleanup",
          descriptionPreview: "Executor queue polish.",
          assignee: "Alex",
        }),
      }),
      makePalettePage({
        projectId: "design",
        projectName: "Design",
        page: makePage({
          id: "design-page",
          title: "Queue cleanup",
          descriptionPreview: "Executor queue polish.",
          assignee: "Alex",
        }),
      }),
    ];

    const { container, getByLabelText } = render(
      <CommandPaletteSurface
        open
        openTriggerTick={3}
        mode="pages"
        initialQuery="queue"
        commands={[]}
        pages={pages}
        pageSearchBatch={makePageSearchBatch({
          query: "queue",
          scopeKey: "design\nops",
          results: pages.map((page) => makePageSearchResult(page)),
        })}
        loading={false}
        pagesLoading={false}
        chatsLoading={false}
        onChangeMode={() => undefined}
        onRequestClose={() => undefined}
        onExecute={() => undefined}
      />,
    );

    await settleAsyncRender();

    const filterButton = getByLabelText("Filter pages");
    expect(filterButton.getAttribute("aria-label")).toBe("Filter pages");
    expect(textContent(container).includes("Queue cleanup")).toBe(true);
  });

  test("renders summary chips for active palette filters", async () => {
    const { CommandPalettePageFiltersSummaryRow } = await import("./command-palette-filters");
    const filters = {
      ...getDefaultCommandPalettePageFilters(),
      projectIds: ["ops"],
      assignees: ["Alex"],
    };

    const { container } = render(
      <CommandPalettePageFiltersSummaryRow
        filters={filters}
        projectNameById={new Map([["ops", "Ops"]])}
        onOpenFilter={() => undefined}
      />,
    );

    expect(textContent(container).includes("Project:")).toBe(true);
    expect(textContent(container).includes("Ops")).toBe(true);
    expect(textContent(container).includes("Assignee:")).toBe(true);
    expect(textContent(container).includes("Alex")).toBe(true);
  });
});

describe("buildCommandPaletteCommands navigation", () => {
  test("builds Codex navigation commands with exact ids, labels, shortcuts, and disabled states", async () => {
    const commands = buildCommandPaletteCommands(
      makeCommandContext({
        canGoBack: false,
        canGoForward: true,
        isMac: true,
      }),
    );

    const backCommand = commands.find((command) => command.id === "navigateBack");
    const forwardCommand = commands.find((command) => command.id === "navigateForward");

    expect(backCommand?.id).toBe("navigateBack");
    expect(backCommand?.title).toBe("Back");
    expect(backCommand?.shortcut).toBe("⌘[");
    expect(backCommand?.disabled).toBe(true);
    expect(forwardCommand?.id).toBe("navigateForward");
    expect(forwardCommand?.title).toBe("Forward");
    expect(forwardCommand?.shortcut).toBe("⌘]");
    expect(forwardCommand?.disabled).toBe(false);
  });

  test("builds non-mac navigation shortcut labels", async () => {
    const commands = buildCommandPaletteCommands(
      makeCommandContext({
        canGoBack: true,
        canGoForward: true,
        isMac: false,
      }),
    );

    expect(commands.find((command) => command.id === "navigateBack")?.shortcut).toBe("Ctrl+[");
    expect(commands.find((command) => command.id === "navigateForward")?.shortcut).toBe("Ctrl+]");
  });

  test("builds the Codex renameThread command with shortcut and disabled state", async () => {
    const enabledCommands = buildCommandPaletteCommands(
      makeCommandContext({
        canGoBack: true,
        canGoForward: true,
        isMac: true,
      }),
    );
    const disabledCommands = buildCommandPaletteCommands(
      makeCommandContext({
        canGoBack: true,
        canGoForward: true,
        hasActiveSession: false,
        isMac: false,
      }),
    );
    const enabled = enabledCommands.find((command) => command.id === RENAME_THREAD_COMMAND_ID);
    const disabled = disabledCommands.find((command) => command.id === RENAME_THREAD_COMMAND_ID);

    expect(enabled?.title).toBe("Rename chat");
    expect(enabled?.shortcut).toBe("⌘⌥R");
    expect(enabled?.disabled).toBe(false);
    expect(disabled?.shortcut).toBe("Ctrl+Alt+R");
    expect(disabled?.disabled).toBe(true);
  });
});

test.each(["needle", "/workspace/result.ts"])(
  "Files requires a folder before searching %s",
  async (query) => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const previousApi = window.api;
    const previousQuery = apiMock.invokeImplementation;
    const queryOwner = vi.fn(previousQuery);
    apiMock.invokeImplementation = queryOwner;
    const invoke = vi.fn(async () => undefined);
    installWindowApi({ invoke });
    const execute = vi.fn();
    const close = vi.fn();
    const view = render(
      <CommandPaletteSurface
        open
        openTriggerTick={1}
        mode="files"
        initialQuery={query}
        commands={[]}
        loading={false}
        pagesLoading={false}
        chatsLoading={false}
        onChangeMode={() => undefined}
        onRequestClose={close}
        onExecute={execute}
      />,
    );
    try {
      expect(await view.findByText("Choose a folder to search files")).toBeTruthy();
      expect(view.queryAllByRole("option")).toHaveLength(0);
      expect(view.queryByRole("progressbar")).toBeNull();
      await act(async () => {
        fireEvent.keyDown(view.getByRole("combobox"), { key: "Enter" });
        await Promise.resolve();
      });
      expect(invoke).not.toHaveBeenCalledWith("file-search:start", expect.anything());
      expect(queryOwner).not.toHaveBeenCalledWith("read-file-metadata", expect.anything());
      expect(execute).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      apiMock.invokeImplementation = previousQuery;
      installWindowApi(previousApi);
    }
  },
);

test("Files keeps empty and pending states out of keyboard selection and opens the full result path", async () => {
  const { CommandPaletteSurface } = await import("./command-palette-surface");
  const name = `report-${"🙂".repeat(100)}.ts`;
  const path = `deep/${"nested/".repeat(20)}${name}`;
  const fixture = createFileSearchFixture([{ name, path, type: "file", isSymlink: false }]);
  const updates: unknown[] = [];
  const previousApi = window.api;
  installWindowApi({
    on: fixture.on,
    invoke: async (channel: string, ...args: unknown[]) => {
      if (channel === "file-search:update") {
        updates.push(args[0]);
        return;
      }
      return fixture.invoke(channel, args[0]);
    },
  });
  const execute = vi.fn();
  const close = vi.fn();
  const view = render(
    <CommandPaletteSurface
      open
      openTriggerTick={1}
      mode="files"
      commands={[]}
      fileSearchScope={{ hostId: "remote:files-states", roots: ["/files-states"] }}
      loading={false}
      pagesLoading={false}
      chatsLoading={false}
      onChangeMode={() => undefined}
      onRequestClose={close}
      onExecute={execute}
    />,
  );
  try {
    expect(await view.findByText("Type to search files")).toBeTruthy();
    expect(view.queryAllByRole("option")).toHaveLength(0);
    const input = view.getByRole("combobox");
    await act(async () => {
      fireEvent.change(input, { target: { value: "missing" } });
      await Promise.resolve();
    });
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(view.getByRole("progressbar", { name: "Searching files" })).toBeTruthy();
    expect(view.queryByText("Type to search files")).toBeNull();
    expect(view.queryAllByRole("option")).toHaveLength(0);
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });
    expect(execute).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    await act(async () => {
      fixture.invoke("file-search:update", updates[0]);
      await Promise.resolve();
    });
    expect(await view.findByText("No matching files")).toBeTruthy();
    expect(view.queryByRole("progressbar")).toBeNull();
    expect(view.queryAllByRole("option")).toHaveLength(0);
    await act(async () => {
      fireEvent.change(input, { target: { value: "report" } });
      await Promise.resolve();
    });
    await waitFor(() => expect(updates).toHaveLength(2));
    await act(async () => {
      fixture.invoke("file-search:update", updates[1]);
      await Promise.resolve();
    });
    expect(await view.findByRole("option")).toBeTruthy();
    expect(view.queryByRole("progressbar")).toBeNull();
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "file",
        hostId: "remote:files-states",
        file: expect.objectContaining({ fsPath: `/files-states/${path}`, label: name }),
      }),
      expect.any(String),
    );
    expect(close).toHaveBeenCalledOnce();
  } finally {
    view.unmount();
    installWindowApi(previousApi);
  }
});

test("choosing the current Project folder remains an explicit boundary until context is restored", async () => {
  const { CommandPaletteSurface } = await import("./command-palette-surface");
  const previousQuery = apiMock.invokeImplementation;
  const metadata = vi.fn(async () => ({ isFile: true }));
  apiMock.invokeImplementation = async (...args) => {
    if (args[0] === "read-file-metadata") return metadata();
    if (args[0] !== "workspace-directory-entries") return previousQuery(...args);
    const input = args[1] as import("../../../shared/types").WorkspaceDirectoryEntriesInput;
    return {
      workspaceRoot: input.workspaceRoot,
      directoryPath: input.directoryPath ?? "",
      parentPath: null,
      entries: [],
    };
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() {
    const [selection, setSelection] = useState<CommandPaletteWorkspaceSelection>({
      kind: "context",
    });
    return (
      <CommandPaletteSurface
        open
        openTriggerTick={1}
        mode="files"
        initialQuery="/outside/file.ts"
        commands={[]}
        fileSearchScope={{ hostId: "local", roots: ["/project"] }}
        workspaceSelection={selection}
        onWorkspaceSelectionChange={setSelection}
        loading={false}
        pagesLoading={false}
        chatsLoading={false}
        onChangeMode={() => undefined}
        onRequestClose={() => undefined}
        onExecute={() => undefined}
      />
    );
  }
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Harness />
      <NodexModalHost />
    </QueryClientProvider>,
  );
  try {
    await view.findByRole("option", { name: /file.ts/ });
    expect(metadata).toHaveBeenCalledOnce();
    await openNodexMenu(view.getByRole("button", { name: "Search folder" }));
    const chooseFolder = await view.findByRole("menuitem", { name: "Choose folder" });
    await act(async () => {
      fireEvent.click(chooseFolder);
      await Promise.resolve();
    });
    const current = await view.findByRole("button", { name: "Select current folder" });
    await waitFor(() => expect((current as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(current);
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Choose" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    await view.findByText("In project");
    await view.findByText("No matching files");
    expect(view.queryAllByRole("option")).toHaveLength(0);
    expect(metadata).toHaveBeenCalledOnce();
    expect(view.getByRole("combobox", { name: "Command palette search" })).toHaveProperty(
      "value",
      "/outside/file.ts",
    );
    await openNodexMenu(view.getByRole("button", { name: "Search folder" }));
    const projectFolder = await view.findByRole("menuitem", { name: "Folder: project" });
    await act(async () => {
      fireEvent.click(projectFolder);
      await Promise.resolve();
    });
    await view.findByRole("option", { name: /file.ts/ });
    expect(metadata).toHaveBeenCalledTimes(2);
    expect(view.getByRole("button", { name: "Search folder" }).textContent).toBe("Folder: project");
  } finally {
    view.unmount();
    apiMock.invokeImplementation = previousQuery;
    queryClient.clear();
  }
});

test("All shows progress while only current Text search remains pending and removes it for results", async () => {
  const { CommandPaletteSurface } = await import("./command-palette-surface");
  type Request = import("../../../shared/workspace-text-search").WorkspaceTextSearchRequest;
  type SearchEvent = import("../../../shared/workspace-text-search").WorkspaceTextSearchEvent;
  const requests: Request[] = [];
  const listeners = new Set<(...args: unknown[]) => void>();
  const fixture = createFileSearchFixture([]);
  const previousApi = window.api;
  installWindowApi({
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      if (channel !== "workspace-text-search:event") return fixture.on(channel, listener);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    invoke: async (channel: string, ...args: unknown[]) => {
      if (channel === "workspace-text-search:start") requests.push(args[0] as Request);
      else fixture.invoke(channel, args[0]);
    },
  });
  const view = render(
    <CommandPaletteSurface
      open
      openTriggerTick={1}
      mode="root"
      initialQuery="needle"
      commands={[]}
      fileSearchScope={{ hostId: "local", roots: ["/pending"] }}
      loading={false}
      pagesLoading={false}
      chatsLoading={false}
      onChangeMode={() => undefined}
      onRequestClose={() => undefined}
      onExecute={() => undefined}
    />,
  );
  const emit = async (event: SearchEvent) =>
    act(async () => {
      for (const listener of listeners) listener(event);
      await Promise.resolve();
    });
  try {
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(view.queryByText("Searching files…")).toBeNull();
    expect(view.queryAllByRole("option")).toHaveLength(0);
    expect(view.getByRole("progressbar", { name: "Searching" })).toBeTruthy();
    await act(async () => {
      fireEvent.change(view.getByRole("combobox"), { target: { value: "next" } });
      await Promise.resolve();
    });
    await waitFor(() => expect(requests).toHaveLength(2));
    await emit({ requestId: requests[0]!.requestId, type: "done", limited: false });
    expect(view.getByRole("progressbar", { name: "Searching" })).toBeTruthy();
    await emit({
      requestId: requests[1]!.requestId,
      type: "match",
      match: {
        path: "/pending/file.ts",
        root: "/pending",
        relativePath: "file.ts",
        line: 1,
        column: 1,
        preview: "next",
        matchRanges: [{ start: 0, end: 4 }],
      },
    });
    await view.findByRole("option", { name: "/pending/file.ts:1" });
    expect(view.queryByRole("progressbar", { name: "Searching" })).toBeNull();
  } finally {
    view.unmount();
    installWindowApi(previousApi);
  }
});

test("file search opens directories on the selected host and releases its session", async () => {
  const { CommandPaletteSurface } = await import("./command-palette-surface");
  const fixture = createFileSearchFixture([
    { name: "src", path: "src", type: "directory", isSymlink: false },
    { name: "index.ts", path: "src/index.ts", type: "file", isSymlink: false },
  ]);
  const calls: string[] = [];
  const previousApi = window.api;
  installWindowApi({
    on: fixture.on,
    invoke: async (channel: string, ...args: unknown[]) => {
      calls.push(channel);
      return fixture.invoke(channel, args[0]);
    },
  });
  const execute = vi.fn();
  const close = vi.fn();
  const changeMode = vi.fn();
  const view = render(
    <CommandPaletteSurface
      open
      openTriggerTick={1}
      mode="files"
      initialQuery="sr"
      commands={[]}
      fileSearchScope={{ hostId: "local", roots: ["/workspace"] }}
      loading={false}
      pagesLoading={false}
      chatsLoading={false}
      onChangeMode={changeMode}
      onRequestClose={close}
      onExecute={execute}
    />,
  );
  try {
    await waitFor(() => expect(view.getAllByRole("option")).toHaveLength(2));
    const input = view.getByRole("combobox");
    await act(async () => {
      fireEvent.keyDown(input, { key: "Tab" });
      await Promise.resolve();
    });
    expect(changeMode).toHaveBeenCalledWith("text");
    expect(input).toHaveProperty("value", "sr");
    expect(execute).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "file",
        file: expect.objectContaining({ fsPath: "/workspace/src", kind: "directory" }),
      }),
      expect.any(String),
    );
    expect(close).toHaveBeenCalledOnce();
    view.unmount();
    await waitFor(() =>
      expect(calls.filter((call) => call === "file-search:stop")).toHaveLength(1),
    );
    expect(calls.filter((call) => call === "file-search:start")).toHaveLength(1);
  } finally {
    view.unmount();
    installWindowApi(previousApi);
  }
});

test("Text streams host-scoped matches, filters file types, and fences stale acceptance", async () => {
  const { CommandPaletteSurface } = await import("./command-palette-surface");
  const listeners = new Set<(...args: unknown[]) => void>();
  const requests: import("../../../shared/workspace-text-search").WorkspaceTextSearchRequest[] = [];
  const stopped: string[] = [];
  const previousApi = window.api;
  installWindowApi({
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      if (channel !== "workspace-text-search:event") return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    invoke: async (channel: string, ...args: unknown[]) => {
      if (channel === "workspace-text-search:start")
        requests.push(args[0] as (typeof requests)[number]);
      if (channel === "workspace-text-search:stop")
        stopped.push((args[0] as { requestId: string }).requestId);
      return undefined;
    },
  });
  const execute = vi.fn();
  const close = vi.fn();
  const view = render(
    <CommandPaletteSurface
      open
      openTriggerTick={1}
      mode="text"
      initialQuery="needle"
      commands={[]}
      fileSearchScope={{ hostId: "remote:test", roots: ["/workspace"] }}
      loading={false}
      pagesLoading={false}
      chatsLoading={false}
      onChangeMode={() => undefined}
      onRequestClose={close}
      onExecute={execute}
    />,
  );
  const emit = async (index: number, line: number) =>
    act(async () => {
      const requestId = requests[index]!.requestId;
      for (const listener of listeners) {
        listener({
          requestId,
          type: "match",
          match: {
            path: "/workspace/file.ts",
            root: "/workspace",
            relativePath: "file.ts",
            line,
            column: 4,
            preview: "a needle",
            matchRanges: [{ start: 2, end: 8 }],
          },
        });
        listener({ requestId, type: "done", limited: false });
      }
      await Promise.resolve();
    });
  try {
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      hostId: "remote:test",
      roots: ["/workspace"],
      query: "needle",
    });
    await emit(0, 7);
    const input = view.getByRole("combobox", { name: "Command palette search" });
    await waitFor(() =>
      expect(
        view.getByRole("option", { name: "/workspace/file.ts:7" }).getAttribute("aria-disabled"),
      ).toBeNull(),
    );
    await act(async () => {
      fireEvent.keyDown(input, { key: "F6" });
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(view.getByRole("button", { name: "Search folder" }));
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "F6" });
      fireEvent.change(view.getByRole("textbox", { name: "File types" }), {
        target: { value: "*.ts,!*.test.ts" },
      });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        view.getByRole("option", { name: "/workspace/file.ts:7" }).getAttribute("aria-disabled"),
      ).toBe("true"),
    );
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });
    expect(execute).not.toHaveBeenCalled();
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]?.fileMask).toBe("*.ts,!*.test.ts");
    await emit(0, 99);
    expect(view.queryByRole("option", { name: "/workspace/file.ts:99" })).toBeNull();
    await emit(1, 9);
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });
    expect(close).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "text",
        hostId: "remote:test",
        match: expect.objectContaining({ path: "/workspace/file.ts", line: 9, column: 4 }),
      }),
      expect.any(String),
    );
    view.unmount();
    expect(stopped.length).toBeLessThanOrEqual(2);
  } finally {
    view.unmount();
    installWindowApi(previousApi);
  }
});

test("Text keeps Project query and mask history when choosing a different search folder", async () => {
  const { CommandPaletteSurface } = await import("./command-palette-surface");
  type Request = import("../../../shared/workspace-text-search").WorkspaceTextSearchRequest;
  const requests: Request[] = [];
  const fileRequests: import("../../../shared/file-search").FileSearchStartInput[] = [];
  const previousApi = window.api;
  const previousQuery = apiMock.invokeImplementation;
  apiMock.invokeImplementation = async (...args) => {
    if (args[0] !== "workspace-directory-entries") return previousQuery(...args);
    const input = args[1] as import("../../../shared/types").WorkspaceDirectoryEntriesInput;
    return {
      workspaceRoot: input.workspaceRoot,
      directoryPath: input.directoryPath ?? "",
      parentPath: null,
      entries: [],
    };
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  installWindowApi({
    on: () => () => undefined,
    invoke: async (channel: string, ...args: unknown[]) => {
      if (channel === "workspace-text-search:start") requests.push(args[0] as Request);
      if (channel === "file-search:start")
        fileRequests.push(args[0] as (typeof fileRequests)[number]);
      return undefined;
    },
  });
  function Harness() {
    const [mode, setMode] = useState<CommandMenuMode>("text");
    const [workspaceSelection, setWorkspaceSelection] = useState<CommandPaletteWorkspaceSelection>({
      kind: "context",
    });
    return (
      <CommandPaletteSurface
        open
        openTriggerTick={1}
        mode={mode}
        initialQuery="needle"
        commands={[]}
        fileSearchScope={{
          hostId: "local",
          roots: ["/history-project/first", "/history-project/second"],
        }}
        workspaceSelection={workspaceSelection}
        onWorkspaceSelectionChange={setWorkspaceSelection}
        loading={false}
        pagesLoading={false}
        chatsLoading={false}
        onChangeMode={setMode}
        onRequestClose={() => undefined}
        onExecute={() => undefined}
      />
    );
  }
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Harness />
      <NodexModalHost />
    </QueryClientProvider>,
  );
  try {
    const input = view.getByRole("combobox", { name: "Command palette search" });
    await act(async () => {
      fireEvent.change(view.getByRole("textbox", { name: "File types" }), {
        target: { value: "*.ts,!*.test.ts" },
      });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("tab", { name: "Actions" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("tab", { name: "Text" }));
      fireEvent.change(input, { target: { value: "" } });
      await Promise.resolve();
    });
    await view.findByRole("option", { name: "needle" });
    await openNodexMenu(view.getByRole("button", { name: "Search folder" }));
    const folder = await view.findByRole("menuitem", { name: "Choose folder" });
    await act(async () => {
      fireEvent.click(folder);
      await Promise.resolve();
    });
    const folderPath = await view.findByRole("combobox", { name: "Selected folder path" });
    await act(async () => {
      fireEvent.change(folderPath, { target: { value: "/history-project/second" } });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Choose" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect((view.getByRole("textbox", { name: "File types" }) as HTMLInputElement).value).toBe(
        "*.ts,!*.test.ts",
      ),
    );
    const recalledQuery = await view.findByRole("option", { name: "needle" });
    await act(async () => {
      fireEvent.click(recalledQuery);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(requests).toContainEqual(
        expect.objectContaining({
          hostId: "local",
          roots: ["/history-project/second"],
          query: "needle",
          fileMask: "*.ts,!*.test.ts",
        }),
      ),
    );
    await act(async () => {
      fireEvent.click(view.getByRole("tab", { name: "All" }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(requests.at(-1)).toMatchObject({
        hostId: "local",
        roots: ["/history-project/first", "/history-project/second"],
        fileMask: "",
      }),
    );
    await waitFor(() =>
      expect(fileRequests.at(-1)).toMatchObject({
        hostId: "local",
        roots: ["/history-project/first", "/history-project/second"],
      }),
    );
    await act(async () => {
      fireEvent.click(view.getByRole("tab", { name: "Text" }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(requests.at(-1)).toMatchObject({
        hostId: "local",
        roots: ["/history-project/second"],
        fileMask: "*.ts,!*.test.ts",
      }),
    );
  } finally {
    view.unmount();
    apiMock.invokeImplementation = previousQuery;
    queryClient.clear();
    installWindowApi(previousApi);
  }
});

test("Text recovers after a terminal error without accepting stale results", async () => {
  const { CommandPaletteSurface } = await import("./command-palette-surface");
  type Request = import("../../../shared/workspace-text-search").WorkspaceTextSearchRequest;
  type SearchEvent = import("../../../shared/workspace-text-search").WorkspaceTextSearchEvent;
  const requests: Request[] = [];
  const listeners = new Set<(...args: unknown[]) => void>();
  const previousApi = window.api;
  installWindowApi({
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      if (channel !== "workspace-text-search:event") return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    invoke: async (channel: string, ...args: unknown[]) => {
      if (channel === "workspace-text-search:start") requests.push(args[0] as Request);
      return undefined;
    },
  });
  const execute = vi.fn();
  const close = vi.fn();
  const view = render(
    <CommandPaletteSurface
      open
      openTriggerTick={1}
      mode="text"
      initialQuery="needle"
      commands={[]}
      fileSearchScope={{ hostId: "local", roots: ["/workspace-error"] }}
      loading={false}
      pagesLoading={false}
      chatsLoading={false}
      onChangeMode={() => undefined}
      onRequestClose={close}
      onExecute={execute}
    />,
  );
  const emit = async (event: SearchEvent) =>
    act(async () => {
      for (const listener of listeners) listener(event);
      await Promise.resolve();
    });
  const match = {
    path: "/workspace-error/result.ts",
    root: "/workspace-error",
    relativePath: "result.ts",
    line: 7,
    column: 1,
    preview: "needle",
    matchRanges: [{ start: 0, end: 6 }],
  };
  try {
    await waitFor(() => expect(requests).toHaveLength(1));
    await emit({ requestId: requests[0]!.requestId, type: "match", match });
    const input = view.getByRole("combobox", { name: "Command palette search" });
    const oldResult = view.getByRole("option", { name: "/workspace-error/result.ts:7" });
    await act(async () => {
      fireEvent.change(input, { target: { value: "broken" } });
      await Promise.resolve();
    });
    expect(oldResult.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });
    expect(execute).not.toHaveBeenCalled();
    await waitFor(() => expect(requests).toHaveLength(2));
    await emit({
      requestId: requests[1]!.requestId,
      type: "error",
      code: "search-failed",
      message: "Host disconnected",
    });
    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toBe("Unable to search files. Try again"),
    );
    expect(view.queryAllByRole("option")).toHaveLength(0);
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });
    expect(close).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.change(input, { target: { value: "recovered" } });
      await Promise.resolve();
    });
    await waitFor(() => expect(requests).toHaveLength(3));
    await emit({ requestId: requests[2]!.requestId, type: "match", match: { ...match, line: 9 } });
    expect(view.queryByRole("alert")).toBeNull();
    await emit({
      requestId: requests[2]!.requestId,
      type: "error",
      code: "search-failed",
      message: "Host disconnected after returning a match",
    });
    expect(view.getByRole("alert").textContent).toBe("Unable to search files. Try again");
    expect(
      view
        .getByRole("alert")
        .compareDocumentPosition(
          view.getByRole("option", { name: "/workspace-error/result.ts:9" }),
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      view
        .getByRole("option", { name: "/workspace-error/result.ts:9" })
        .getAttribute("aria-disabled"),
    ).toBeNull();
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "text", match: expect.objectContaining({ line: 9 }) }),
      expect.any(String),
    );
    expect(close).toHaveBeenCalledOnce();
  } finally {
    view.unmount();
    installWindowApi(previousApi);
  }
});
