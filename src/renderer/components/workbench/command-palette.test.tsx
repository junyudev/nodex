import { describe, expect, vi, test } from "vite-plus/test";
import { createElement, createRef } from "react";
import { act, fireEvent } from "@testing-library/react";
import type {
  CommandPalettePage,
  CommandPaletteCommand,
  CommandPaletteThread,
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
import { render, settleAsyncRender, textContent } from "../../test/dom";
import { createCommandKeymapState } from "../../../shared/command-keybindings";
import {
  RENAME_THREAD_COMMAND_ID,
  TOGGLE_SIDEBAR_COMMAND_ID,
} from "../../../shared/window-navigation";
import { TOGGLE_BOTTOM_PANEL_COMMAND_ID } from "../../../shared/workbench-commands";
import { DEFAULT_PROJECT_APPEARANCE } from "../../../shared/project-appearance";
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
} = vi.hoisted(() => ({
  invokeImplementation: async () => [],
}));

vi.mock("../../lib/api", () => ({
  searchPages: (input: unknown) =>
    apiMock.invokeImplementation("pages:search", "test-request", input),
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
    expect(ids.includes("searchFiles")).toBe(false);
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
  test("lets the dialog consume a non-empty query before closing", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const surfaceRef = createRef<CommandPaletteSurfaceHandle>();
    const { getByLabelText } = render(
      <CommandPaletteSurface
        ref={surfaceRef}
        open
        openTriggerTick={1}
        mode="root"
        initialQuery="settings"
        commands={[]}
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
    expect(input.value).toBe("settings");

    let consumed = false;
    await act(async () => {
      consumed = surfaceRef.current?.consumeEscape() ?? false;
      await Promise.resolve();
    });

    expect(consumed).toBe(true);
    expect(input.value).toBe("");
    expect(surfaceRef.current?.consumeEscape()).toBe(false);
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
        onExecute={(item: CommandPalettePage | CommandPaletteCommand | CommandPaletteThread) => {
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
    fireEvent.click(topResult as HTMLElement);

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

  test("fills the root discovery budget with Pages without an independent Page cap", async () => {
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
    expect(pageButtons).toHaveLength(7);
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

  test("uses only the root budget remaining after commands and chats for Pages", async () => {
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
    expect(container.querySelectorAll("button[cmdk-item]")).toHaveLength(7);
    expect(pageButtons).toHaveLength(3);
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
        onExecute={(item: CommandPalettePage | CommandPaletteCommand | CommandPaletteThread) => {
          if (item.kind === "thread") executedItems.push(item);
        }}
      />,
    );

    await settleAsyncRender();

    const topResult = container.querySelector('button[cmdk-item][data-selected="true"]');
    expect(textContent(container).includes("Chats")).toBe(true);
    expect(textContent(container).includes("Thread transcript search")).toBe(true);
    expect(topResult).not.toBeNull();
    fireEvent.click(topResult as HTMLElement);

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

  test("reserves the ninth root chat slot for current-query loading state", async () => {
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

    expect(container.querySelectorAll("button[cmdk-item]")).toHaveLength(8);
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
    apiMock.invokeImplementation = async (channel: unknown, ...args: unknown[]) => {
      if (channel === "pages:search") {
        const input = args[1];
        const query =
          typeof input === "object" && input !== null && "query" in input
            ? String((input as { query?: unknown }).query ?? "")
            : "";
        searchedQueries.push(query);
        return [];
      }
      return [];
    };
    await Promise.all([
      searchCommandPalettePages({ projectIds: ["default"], query: "page cache" }),
      searchCommandPalettePages({ projectIds: ["default"], query: "page cache" }),
    ]);
    await searchCommandPalettePages({ projectIds: ["default"], query: "page cache" });

    expect(searchedQueries).toEqual(["page cache", "page cache"]);
    apiMock.invokeImplementation = async () => [];
  });

  test("skips disabled commands and updates aria-activedescendant during keyboard navigation", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const executedItems: CommandPaletteCommand[] = [];
    const { container, getByLabelText } = render(
      <CommandPaletteSurface
        open
        openTriggerTick={4}
        mode="root"
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
        onExecute={(item: CommandPalettePage | CommandPaletteCommand | CommandPaletteThread) => {
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

    fireEvent.keyDown(input, { key: "ArrowDown" });
    await settleAsyncRender();

    const nextActiveId = input.getAttribute("aria-activedescendant");
    const nextActive = nextActiveId ? container.querySelector(`[id="${nextActiveId}"]`) : null;

    expect(nextActiveId !== firstActiveId).toBe(true);
    expect(nextActive?.textContent?.includes("Settings")).toBe(true);
    expect(textContent(container).includes("Mock")).toBe(false);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(executedItems.length).toBe(1);
    expect(executedItems[0]?.id).toBe("settings");
  });

  test("marks mock commands with a visible badge and keeps them inert", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const executedItems: CommandPaletteCommand[] = [];
    const closeCalls: number[] = [];
    const { container } = render(
      <CommandPaletteSurface
        open
        openTriggerTick={5}
        mode="root"
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
        onExecute={(item: CommandPalettePage | CommandPaletteCommand | CommandPaletteThread) => {
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
      fireEvent.click(mockButton);
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
