import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Project } from "@/lib/types";

let resolveSlidingWindowFocusIntentReturn: { direction: "left" | "right" } = {
  direction: "right",
};
let resolveSlidingWindowFocusIntentCalls: Array<[unknown, unknown, unknown, unknown]> = [];
let resolveExpandedStagesReturn: Array<"db" | "cards" | "threads" | "files"> = ["db", "cards"];
let mockInvokeImpl: ((...args: unknown[]) => Promise<unknown>) | null = null;
let invokeCalls: unknown[][] = [];

type SidebarItem = {
  id: string;
  label?: string;
  active?: boolean;
  onSelect?: () => void;
  icon?: unknown;
  updatedAtMs?: number;
};
type SidebarSection = {
  id: string;
  label?: string;
  count?: number;
  collapsible?: boolean;
  items?: SidebarItem[];
};
type SidebarGroup = {
  id: string;
  label?: string;
  active?: boolean;
  icon?: unknown;
  onFocus?: () => void;
  items?: SidebarItem[];
  sections?: SidebarSection[];
  moreActions?: {
    itemLimit?: number;
    canMoveUp?: boolean;
    canMoveDown?: boolean;
  };
};
type StageTabStripProps = {
  activeTabId?: string;
  onSelect?: (tabId: string) => void;
};

mock.module("./card-icon", () => ({
  CardIcon: ({ className }: { className?: string }) => createElement("span", { className }, "C"),
}));

mock.module("./main-view-host", () => ({
  MainViewHost: (props: Record<string, unknown>) => {
    (globalThis as { __lastMainViewHostProps?: Record<string, unknown> }).__lastMainViewHostProps = props;
    return createElement("div", { "data-main-view-host": "true" });
  },
}));

mock.module("./workbench-remote-card-stage-handlers", () => ({
  makeRemoteCardStageHandlers: () => ({
    onUpdate: async () => undefined,
    onPatch: () => undefined,
    onDelete: async () => undefined,
    onMove: async () => undefined,
  }),
}));

mock.module("./workbench-settings-overlay", () => ({
  SettingsOverlay: (props: Record<string, unknown>) => {
    (globalThis as { __lastSettingsOverlayProps?: Record<string, unknown> }).__lastSettingsOverlayProps = props;
    return null;
  },
}));

mock.module("./left-sidebar", () => ({
  LeftSidebar: (props: Record<string, unknown>) => {
    (globalThis as { __lastLeftSidebarProps?: Record<string, unknown> }).__lastLeftSidebarProps = props;
    const stageGroups = (props.stageGroups as Array<{ id: string }> | undefined) ?? [];
    return createElement("div", { "data-stage-groups": stageGroups.map((group) => group.id).join(",") });
  },
}));

mock.module("./stage-threads", () => ({
  StageThreads: (props: Record<string, unknown>) => {
    (globalThis as { __lastStageThreadsProps?: Record<string, unknown> }).__lastStageThreadsProps = props;
    return createElement("div", { "data-stage-threads": "true" });
  },
}));

mock.module("./stage-files-placeholder", () => ({
  StageFilesPlaceholder: () => createElement("div", { "data-diff-placeholder": "true" }),
}));

mock.module("./stage-tab-strip", () => ({
  StageTabStrip: (props: StageTabStripProps) => {
    const globalState = globalThis as { __stageTabStripProps?: StageTabStripProps[] };
    globalState.__stageTabStripProps ??= [];
    globalState.__stageTabStripProps.push(props);
    return createElement("div", { "data-stage-tab-strip": "true" });
  },
}));

mock.module("@/components/kanban/history-panel", () => ({
  HistoryPanel: (props: Record<string, unknown>) => {
    (globalThis as { __lastHistoryPanelProps?: Record<string, unknown> }).__lastHistoryPanelProps = props;
    if (!props.open) return null;
    return createElement("div", { "data-history-panel": "true" });
  },
}));

mock.module("@/components/kanban/card-stage", () => ({
  CardStage: (props: Record<string, unknown>) => {
    (globalThis as { __lastCardStageProps?: Record<string, unknown> }).__lastCardStageProps = props;
    return createElement("div", { "data-card-stage": "true" });
  },
}));

mock.module("@/components/kanban/terminal-panel", () => ({
  TerminalPanel: (props: Record<string, unknown>) => {
    (globalThis as { __lastTerminalPanelProps?: Record<string, unknown> }).__lastTerminalPanelProps = props;
    return createElement("div", { "data-terminal-panel": "true" });
  },
}));

mock.module("@/components/ui/input", () => ({
  Input: (props: Record<string, unknown>) => createElement("input", props),
}));

mock.module("@/lib/api", () => ({
  invoke: async (...args: unknown[]) => {
    invokeCalls.push(args);
    if (!mockInvokeImpl) return null;
    return mockInvokeImpl(...args);
  },
}));

mock.module("@/lib/stage-rail-peek", () => ({
  readNextPanelPeekPx: () => 28,
  writeNextPanelPeekPx: (value: number) => value,
}));

mock.module("@/lib/thread-panel-thinking-visibility", () => ({
  readThreadPanelHideThinkingWhenDone: () => false,
  writeThreadPanelHideThinkingWhenDone: (value: boolean) => value,
}));

mock.module("@/lib/thread-panel-prompt-submit-shortcut", () => ({
  readThreadPromptSubmitShortcut: () => "enter" as const,
  writeThreadPromptSubmitShortcut: (value: "enter" | "mod-enter") => value,
}));

mock.module("@/lib/worktree-start-mode", () => ({
  readWorktreeStartMode: () => "autoBranch" as const,
  writeWorktreeStartMode: (value: "autoBranch" | "detachedHead") => value,
}));

mock.module("@/lib/worktree-branch-prefix", () => ({
  readWorktreeAutoBranchPrefix: () => "nodex/" as const,
  writeWorktreeAutoBranchPrefix: (value: string) => value,
}));

mock.module("@/lib/codex-collaboration-mode-settings", () => ({
  DEFAULT_CODEX_COLLABORATION_MODE: "default" as const,
  getDraftCollaborationModeStorageKey: (projectId: string, cardId: string) => `draft:${projectId}:${cardId}`,
  getThreadCollaborationModeStorageKey: (threadId: string) => `thread:${threadId}`,
  migrateDraftCollaborationModeToThread: () => "default" as const,
  readCollaborationModeForContextKey: () => "default" as const,
  writeCollaborationModeForContextKey: (_contextKey: string, mode: "default" | "plan") => mode,
}));

mock.module("@/lib/smart-prefix-parsing", () => ({
  readSmartPrefixParsingEnabled: () => true,
  readStripSmartPrefixFromTitleEnabled: () => true,
  writeSmartPrefixParsingEnabled: (value: boolean) => value,
  writeStripSmartPrefixFromTitleEnabled: (value: boolean) => value,
}));

mock.module("@/lib/use-codex", () => ({
  useCodex: () => ({
    ...({
      state: {
        connection: {},
        account: null,
        threadDetailsById: {},
      },
      threads: ((globalThis as { __mockCodexThreads?: Array<Record<string, unknown>> }).__mockCodexThreads ?? []),
      availableModels: [],
      threadSettings: {
        model: "gpt-5.3-codex",
        reasoningEffort: "high",
      },
      reasoningEffortOptions: [],
      permissionMode: "sandbox" as const,
      approvalQueue: [],
      userInputQueue: [],
      loadThreads: async () => [],
      loadModels: async () => [],
      listCollaborationModes: async () => [],
      readThread: async () => null,
      startThreadForCard: async () => ({ threadId: "t-1" }),
      startTurn: async () => null,
      steerTurn: async () => null,
      interruptTurn: async () => true,
      respondApproval: async () => true,
      respondUserInput: async () => true,
      refreshAccount: async () => null,
      startChatGptLogin: async () => ({ type: "apiKey" as const }),
      startApiKeyLogin: async () => ({ type: "apiKey" as const }),
      cancelLogin: async () => ({ status: "canceled" as const }),
      logout: async () => true,
      setPermissionMode: async () => undefined,
      setThreadModel: () => undefined,
      setThreadReasoningEffort: () => undefined,
    }),
    ...((globalThis as { __mockUseCodexOverrides?: Record<string, unknown> }).__mockUseCodexOverrides ?? {}),
  }),
}));

mock.module("@/lib/use-kanban", () => ({
  useKanban: () => ({
    board: {
      columns: [
        {
          id: "6-in-progress",
          name: "In Progress",
          cards: [
            {
              id: "card-1",
              title: "Card 1",
              description: "",
              priority: "p2-medium",
              tags: [],
              created: new Date("2026-02-25T00:00:00.000Z"),
              order: 0,
              runInTarget: "newWorktree",
            },
            {
              id: "card-ops-1",
              title: "Ops Card",
              description: "",
              priority: "p2-medium",
              tags: [],
              created: new Date("2026-02-25T00:00:00.000Z"),
              order: 1,
              runInTarget: "newWorktree",
            },
          ],
        },
      ],
    },
    cardIndex: new Map([
      [
        "card-1",
        {
          id: "card-1",
          title: "Card 1",
          description: "",
          priority: "p2-medium",
          tags: [],
          created: new Date("2026-02-25T00:00:00.000Z"),
          order: 0,
          runInTarget: "newWorktree",
          columnId: "6-in-progress",
          columnName: "In Progress",
          boardIndex: 0,
        },
      ],
      [
        "card-ops-1",
        {
          id: "card-ops-1",
          title: "Ops Card",
          description: "",
          priority: "p2-medium",
          tags: [],
          created: new Date("2026-02-25T00:00:00.000Z"),
          order: 1,
          runInTarget: "newWorktree",
          columnId: "6-in-progress",
          columnName: "In Progress",
          boardIndex: 1,
        },
      ],
    ]),
    loading: false,
    error: null,
    updateCard: async () => null,
    patchCard: () => undefined,
    deleteCard: async () => true,
    moveCard: async () => true,
    completeOccurrence: async () => true,
    skipOccurrence: async () => true,
  }),
}));

mock.module("@/lib/kanban-options", () => ({
  KANBAN_STATUS_LABELS: {
    "6-in-progress": "In Progress",
  },
}));

mock.module("@/lib/utils", () => ({
  cn: (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" "),
}));

mock.module("@/lib/use-workbench-state", () => ({
  STAGE_ORDER: ["db", "cards", "threads", "files"],
  NEW_THREAD_STAGE_TAB_ID: "thread:new",
  resolveExpandedStages: () => resolveExpandedStagesReturn,
  resolveSlidingWindowFocusIntent: (...args: [unknown, unknown, unknown, unknown]) => {
    resolveSlidingWindowFocusIntentCalls.push(args);
    return resolveSlidingWindowFocusIntentReturn;
  },
}));

const PROJECTS: Project[] = [
  {
    id: "default",
    name: "Default",
    description: "",
    created: new Date("2026-02-25T00:00:00.000Z"),
  },
];

async function renderShell(
  terminalPanelOpen: boolean,
  layoutMode: "sliding-window" | "full-rail" = "sliding-window",
  overrides: Record<string, unknown> = {},
  mockCodexThreads: Array<Record<string, unknown>> = [],
  invokeImpl: ((...args: unknown[]) => Promise<unknown>) | null = null,
  expandedStages: Array<"db" | "cards" | "threads" | "files"> = ["db", "cards"],
  useCodexOverrides?: Record<string, unknown>,
): Promise<string> {
  (globalThis as { __lastSettingsOverlayProps?: Record<string, unknown> }).__lastSettingsOverlayProps = undefined;
  (globalThis as { __lastLeftSidebarProps?: Record<string, unknown> }).__lastLeftSidebarProps = undefined;
  (globalThis as { __lastMainViewHostProps?: Record<string, unknown> }).__lastMainViewHostProps = undefined;
  (globalThis as { __lastHistoryPanelProps?: Record<string, unknown> }).__lastHistoryPanelProps = undefined;
  (globalThis as { __lastCardStageProps?: Record<string, unknown> }).__lastCardStageProps = undefined;
  (globalThis as { __lastStageThreadsProps?: Record<string, unknown> }).__lastStageThreadsProps = undefined;
  (globalThis as { __lastTerminalPanelProps?: Record<string, unknown> }).__lastTerminalPanelProps = undefined;
  (globalThis as { __stageTabStripProps?: StageTabStripProps[] }).__stageTabStripProps = [];
  (globalThis as { __mockCodexThreads?: Array<Record<string, unknown>> }).__mockCodexThreads = mockCodexThreads;
  (globalThis as { __mockUseCodexOverrides?: Record<string, unknown> }).__mockUseCodexOverrides = useCodexOverrides;
  resolveExpandedStagesReturn = expandedStages;
  mockInvokeImpl = invokeImpl;
  invokeCalls = [];
  const { WorkbenchShell } = await import("./workbench-shell");
  const props: Record<string, unknown> = {
    projects: PROJECTS,
    dbProjectId: "default",
    threadsProjectId: "default",
    activeView: "kanban",
    activeSearchQuery: "",
    spaces: [{ projectId: "default", colorToken: "#2783de", initial: "D" }],
    recentCardSessions: [],
    activeRecentSessionId: null,
    sidebar: {
      collapsed: false,
      width: 280,
      topLevelSectionOrder: ["recents", "cards", "threads", "files"],
      topLevelSections: {
        recents: { visible: true, itemLimit: 10 },
        cards: { visible: true, itemLimit: 10 },
        threads: { visible: true, itemLimit: 10 },
        files: { visible: true, itemLimit: 10 },
      },
    },
    focusedStage: "db",
    stageNavDirection: "right",
    cardsTabs: [{ id: "history", kind: "history", title: "History" }],
    activeCardsTabId: "history",
    threadsTabs: [{ id: "thread:new", title: "New thread", preview: "" }],
    activeThreadsTabId: "thread:new",
    terminalTabs: [{
      id: "project:default",
      kind: "project",
      projectId: "default",
      title: "Project Shell",
      sessionId: "project:default",
    }],
    activeTerminalTabId: "project:default",
    filesTabs: [{ id: "diff", title: "Diff" }],
    activeFilesTabId: "diff",
    stagePanelWidths: {},
    stageRailLayoutMode: layoutMode,
    onStageRailLayoutModeChange: () => undefined,
    slidingWindowPaneCount: 2,
    terminalPanelOpen,
    terminalPanelHeight: 260,
    cardStageState: {
      open: false,
      projectId: "",
      cardId: null,
    },
    cardStageCardId: undefined,
    cardStageCloseRef: { current: null },
    cardStagePersistRef: { current: null },
    pendingReminderOpen: null,
    onReminderHandled: () => undefined,
    openCardStage: () => undefined,
    setDbProject: () => undefined,
    setThreadsProjectId: () => undefined,
    setView: () => undefined,
    setSearchQuery: () => undefined,
    setSidebarCollapsed: () => undefined,
    setSidebarWidth: () => undefined,
    setSidebarTopLevelSectionVisible: () => undefined,
    setSidebarTopLevelSectionItemLimit: () => undefined,
    moveSidebarTopLevelSectionBy: () => undefined,
    setFocusedStage: () => undefined,
    setSidebarStageExpanded: () => undefined,
    isSidebarStageExpanded: () => true,
    setSidebarSectionExpanded: () => undefined,
    isSidebarSectionExpanded: () => false,
    setSidebarSectionShowAll: () => undefined,
    isSidebarSectionShowAll: () => false,
    setActiveCardsTab: () => undefined,
    setActiveThreadsTab: () => undefined,
    setThreadsTabs: () => undefined,
    setActiveTerminalTab: () => undefined,
    setActiveFilesTab: () => undefined,
    setStagePanelWidths: () => undefined,
    stepSlidingWindowPaneCount: () => undefined,
    setTerminalPanelOpen: () => undefined,
    setTerminalPanelHeight: () => undefined,
    openProjectTerminalTab: () => "project:default",
    openCardTerminalTab: () => "card:session",
    closeTerminalTab: () => undefined,
    selectRecentCardSession: () => undefined,
    closeRecentCardSession: () => undefined,
    closeCardStage: () => undefined,
    onLeaveCardStageCard: () => undefined,
    cardStageSessionSnapshotRef: { current: null },
    projectPickerOpenTick: 0,
    taskSearchOpenTick: 0,
    settingsToggleTick: 0,
    onCreateProject: async () => null,
    onDeleteProject: async () => false,
    onRenameProject: async () => null,
    ...overrides,
  };

  const typedProps = props as unknown as Parameters<typeof WorkbenchShell>[0];
  return renderToStaticMarkup(
    createElement(WorkbenchShell, typedProps),
  );
}

describe("WorkbenchShell", () => {
  test("does not render inline task search input by default", async () => {
    const markup = await renderShell(false);
    expect(markup.includes("Search tasks")).toBeFalse();
  });

  test("places pane controls on either side of the minimap", async () => {
    const markup = await renderShell(false, "sliding-window");
    const minusIndex = markup.indexOf("aria-label=\"Decrease visible panes\"");
    const minimapIndex = markup.indexOf("aria-label=\"Database\"");
    const plusIndex = markup.indexOf("aria-label=\"Increase visible panes\"");

    expect(minusIndex >= 0).toBeTrue();
    expect(minimapIndex > minusIndex).toBeTrue();
    expect(plusIndex > minimapIndex).toBeTrue();
  });

  test("renders a left-edge hover trigger when the sidebar is collapsed", async () => {
    const markup = await renderShell(false, "sliding-window", {
      sidebar: {
        collapsed: true,
        width: 280,
        topLevelSectionOrder: ["recents", "cards", "threads", "files"],
        topLevelSections: {
          recents: { visible: true, itemLimit: 10 },
          cards: { visible: true, itemLimit: 10 },
          threads: { visible: true, itemLimit: 10 },
          files: { visible: true, itemLimit: 10 },
        },
      },
    });

    expect(markup.includes("data-sidebar-hover-trigger=\"true\"")).toBeTrue();
    expect(markup.includes("aria-label=\"Expand sidebar\"")).toBeTrue();
    expect(markup.includes("aria-hidden=\"true\"")).toBeTrue();
    expect(markup.includes("data-stage-groups=")).toBeTrue();
  });

  test("opens history as an overlay for the active card-stage card", async () => {
    const markup = await renderShell(false, "sliding-window", {
      cardsTabs: [{ id: "session:s-1", kind: "session", title: "Card 1", sessionId: "s-1" }],
      activeCardsTabId: "history",
      cardStageState: {
        open: true,
        projectId: "default",
        cardId: "card-1",
      },
    });

    expect(markup.includes("data-card-stage=\"true\"")).toBeTrue();
    expect(markup.includes("data-history-panel=\"true\"")).toBeTrue();

    const historyPanelProps = (globalThis as { __lastHistoryPanelProps?: Record<string, unknown> }).__lastHistoryPanelProps;
    const cardStageProps = (globalThis as { __lastCardStageProps?: Record<string, unknown> }).__lastCardStageProps;
    expect(historyPanelProps?.projectId).toBe("default");
    expect(historyPanelProps?.cardId).toBe("card-1");
    expect(historyPanelProps?.open).toBeTrue();
    expect(historyPanelProps?.mode).toBe(undefined);
    expect(cardStageProps?.historyPanelActive).toBeTrue();
  });

  test("keeps the current card visible when active project differs and resolves history by card project", async () => {
    const markup = await renderShell(false, "sliding-window", {
      dbProjectId: "default",
      projects: [
        ...PROJECTS,
        {
          id: "ops",
          name: "Ops",
          description: "",
          created: new Date("2026-02-25T00:00:00.000Z"),
        },
      ],
      spaces: [
        { projectId: "default", colorToken: "#2783de", initial: "D" },
        { projectId: "ops", colorToken: "#de9255", initial: "O" },
      ],
      cardsTabs: [{ id: "history", kind: "history", title: "History" }],
      activeCardsTabId: "history",
      cardStageState: {
        open: true,
        projectId: "ops",
        cardId: "card-ops-1",
      },
    });

    expect(markup.includes("data-card-stage=\"true\"")).toBeTrue();
    expect(markup.includes("data-history-panel=\"true\"")).toBeTrue();

    const historyPanelProps = (globalThis as { __lastHistoryPanelProps?: Record<string, unknown> }).__lastHistoryPanelProps;
    expect(historyPanelProps?.projectId).toBe("ops");
    expect(historyPanelProps?.cardId).toBe("card-ops-1");
    expect(historyPanelProps?.open).toBeTrue();
  });

  test("shows active task filter pill when search query exists", async () => {
    const markup = await renderShell(false, "sliding-window", { activeSearchQuery: "bugfix" });
    expect(markup.includes("Filtering by:")).toBeTrue();
    expect(markup.includes("bugfix")).toBeTrue();
  });

  test("routes db stage host with dbProjectId even when threads project differs", async () => {
    await renderShell(false, "full-rail", {
      dbProjectId: "default",
      threadsProjectId: "ops",
      projects: [
        ...PROJECTS,
        {
          id: "ops",
          name: "Ops",
          description: "",
          created: new Date("2026-02-25T00:00:00.000Z"),
        },
      ],
      spaces: [
        { projectId: "default", colorToken: "#2783de", initial: "D" },
        { projectId: "ops", colorToken: "#de9255", initial: "O" },
      ],
    });

    const mainViewHostProps = (globalThis as { __lastMainViewHostProps?: Record<string, unknown> }).__lastMainViewHostProps;
    expect(mainViewHostProps?.projectId).toBe("default");
  });

  test("threads stage stays on threadsProjectId when db project changes", async () => {
    await renderShell(false, "full-rail", {
      dbProjectId: "default",
      threadsProjectId: "ops",
      projects: [
        ...PROJECTS,
        {
          id: "ops",
          name: "Ops",
          description: "",
          created: new Date("2026-02-25T00:00:00.000Z"),
        },
      ],
      spaces: [
        { projectId: "default", colorToken: "#2783de", initial: "D" },
        { projectId: "ops", colorToken: "#de9255", initial: "O" },
      ],
    });

    const stageThreadsProps = (globalThis as { __lastStageThreadsProps?: Record<string, unknown> }).__lastStageThreadsProps;
    expect(stageThreadsProps?.projectId).toBe("ops");
  });

  test("passes selected collaboration mode into startThreadForCard callback", async () => {
    const startThreadForCardCalls: Array<Record<string, unknown>> = [];
    const useCodexOverrides: Record<string, unknown> = {
      startThreadForCard: async (input: Record<string, unknown>) => {
        startThreadForCardCalls.push(input);
        return { threadId: "thr-created" };
      },
      loadThreads: async () => [],
    };

    await renderShell(false, "full-rail", {
      cardsTabs: [{ id: "session:s-1", kind: "session", title: "Card 1", sessionId: "s-1" }],
      activeCardsTabId: "session:s-1",
      cardStageState: {
        open: true,
        projectId: "default",
        cardId: "card-1",
      },
      activeThreadsTabId: "thread:new",
    }, [], null, ["db", "cards"], useCodexOverrides);

    const stageThreadsProps = (globalThis as { __lastStageThreadsProps?: Record<string, unknown> }).__lastStageThreadsProps;
    const onStartThreadForCard = stageThreadsProps?.onStartThreadForCard as ((input: {
      projectId: string;
      cardId: string;
      prompt: string;
    }) => Promise<void>) | undefined;
    expect(Boolean(onStartThreadForCard)).toBeTrue();

    await onStartThreadForCard?.({
      projectId: "default",
      cardId: "card-1",
      prompt: "Plan first",
    });

    expect(startThreadForCardCalls.length).toBe(1);
    expect(startThreadForCardCalls[0]?.collaborationMode).toBe("default");
  });

  test("passes selected collaboration mode into startTurn callback", async () => {
    const startTurnCalls: Array<unknown[]> = [];
    const useCodexOverrides: Record<string, unknown> = {
      state: {
        connection: {},
        account: null,
        threadDetailsById: {
          "thr-1": {
            threadId: "thr-1",
            projectId: "default",
            cardId: "card-1",
            threadName: "Thread 1",
            threadPreview: "Preview",
            modelProvider: "openai",
            cwd: "/tmp/project",
            statusType: "idle",
            statusActiveFlags: [],
            archived: false,
            createdAt: 1,
            updatedAt: 2,
            linkedAt: "2026-02-21T00:00:00.000Z",
            turns: [],
            items: [],
          },
        },
      },
      startTurn: async (...args: unknown[]) => {
        startTurnCalls.push(args);
        return null;
      },
    };

    await renderShell(false, "full-rail", {
      activeThreadsTabId: "thr-1",
      threadsTabs: [{ id: "thr-1", title: "Thread 1", preview: "Preview" }],
    }, [
      {
        threadId: "thr-1",
        projectId: "default",
        cardId: "card-1",
        threadName: "Thread 1",
        threadPreview: "Preview",
        modelProvider: "openai",
        statusType: "idle",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 2,
        linkedAt: "2026-02-21T00:00:00.000Z",
      },
    ], null, ["db", "cards"], useCodexOverrides);

    const stageThreadsProps = (globalThis as { __lastStageThreadsProps?: Record<string, unknown> }).__lastStageThreadsProps;
    const onSendPrompt = stageThreadsProps?.onSendPrompt as ((prompt: string) => Promise<void>) | undefined;
    expect(Boolean(onSendPrompt)).toBeTrue();

    await onSendPrompt?.("Follow up");

    expect(startTurnCalls.length).toBe(1);
    const startTurnOptions = startTurnCalls[0]?.[2] as { collaborationMode?: string } | undefined;
    expect(startTurnOptions?.collaborationMode).toBe("default");
  });

  test("allows thread prompt callbacks to override collaboration mode for plan implementation follow-ups", async () => {
    const startTurnCalls: Array<unknown[]> = [];
    const useCodexOverrides: Record<string, unknown> = {
      state: {
        connection: {},
        account: null,
        threadDetailsById: {
          "thr-1": {
            threadId: "thr-1",
            projectId: "default",
            cardId: "card-1",
            threadName: "Thread 1",
            threadPreview: "Preview",
            modelProvider: "openai",
            cwd: "/tmp/project",
            statusType: "idle",
            statusActiveFlags: [],
            archived: false,
            createdAt: 1,
            updatedAt: 2,
            linkedAt: "2026-02-21T00:00:00.000Z",
            turns: [],
            items: [],
          },
        },
      },
      startTurn: async (...args: unknown[]) => {
        startTurnCalls.push(args);
        return null;
      },
    };

    await renderShell(false, "full-rail", {
      activeThreadsTabId: "thr-1",
      threadsTabs: [{ id: "thr-1", title: "Thread 1", preview: "Preview" }],
    }, [
      {
        threadId: "thr-1",
        projectId: "default",
        cardId: "card-1",
        threadName: "Thread 1",
        threadPreview: "Preview",
        modelProvider: "openai",
        statusType: "idle",
        statusActiveFlags: [],
        archived: false,
        createdAt: 1,
        updatedAt: 2,
        linkedAt: "2026-02-21T00:00:00.000Z",
      },
    ], null, ["db", "cards"], useCodexOverrides);

    const stageThreadsProps = (globalThis as { __lastStageThreadsProps?: Record<string, unknown> }).__lastStageThreadsProps;
    const onSendPrompt = stageThreadsProps?.onSendPrompt as
      | ((prompt: string, opts?: { collaborationMode?: string }) => Promise<void>)
      | undefined;
    expect(Boolean(onSendPrompt)).toBeTrue();

    await onSendPrompt?.("PLEASE IMPLEMENT THIS PLAN:\nShip it", { collaborationMode: "default" });

    expect(startTurnCalls.length).toBe(1);
    const startTurnOptions = startTurnCalls[0]?.[2] as { collaborationMode?: string } | undefined;
    expect(startTurnOptions?.collaborationMode).toBe("default");
  });

  test("terminal panel uses active terminal tab project", async () => {
    await renderShell(true, "sliding-window", {
      dbProjectId: "default",
      terminalTabs: [
        {
          id: "card:ops-session",
          kind: "card",
          projectId: "ops",
          title: "Ops card shell",
          sessionId: "card-ops-1",
          cardId: "card-ops-1",
          sessionRefId: "ops-session",
        },
      ],
      activeTerminalTabId: "card:ops-session",
    });

    const terminalPanelProps = (globalThis as { __lastTerminalPanelProps?: Record<string, unknown> }).__lastTerminalPanelProps;
    expect(terminalPanelProps?.projectId).toBe("ops");
    expect(terminalPanelProps?.cardId).toBe("card-ops-1");
    expect(terminalPanelProps?.mode).toBe("card");
  });

  test("includes recents as a top-level sidebar group", async () => {
    const markup = await renderShell(false);
    expect(markup.includes('data-stage-groups="db,recents,cards,threads,files"')).toBeTrue();
  });

  test("orders and filters top-level sidebar groups from persisted sidebar prefs", async () => {
    await renderShell(false, "sliding-window", {
      sidebar: {
        collapsed: false,
        width: 280,
        topLevelSectionOrder: ["threads", "recents", "cards", "files"],
        topLevelSections: {
          recents: { visible: true, itemLimit: 5 },
          cards: { visible: false, itemLimit: 10 },
          threads: { visible: true, itemLimit: 15 },
          files: { visible: true, itemLimit: 20 },
        },
      },
    });

    const sidebarProps = (globalThis as { __lastLeftSidebarProps?: Record<string, unknown> }).__lastLeftSidebarProps;
    const stageGroups = (sidebarProps?.stageGroups as SidebarGroup[] | undefined) ?? [];

    expect(stageGroups.map((group) => group.id).join(",")).toBe("db,threads,recents,files");
    expect(stageGroups[1]?.moreActions?.itemLimit).toBe(15);
    expect(stageGroups[1]?.moreActions?.canMoveUp).toBeFalse();
    expect(stageGroups[1]?.moreActions?.canMoveDown).toBeTrue();
    expect(stageGroups[2]?.moreActions?.itemLimit).toBe(5);
    expect(stageGroups[3]?.moreActions?.canMoveDown).toBeFalse();
  });

  test("builds a top-level recents group plus current-project cards sections", async () => {
    await renderShell(false, "sliding-window", {
      recentCardSessions: [
        {
          id: "s-1",
          projectId: "ops",
          cardId: "card-1",
          titleSnapshot: "Cross-project recent",
          lastOpenedAt: "2026-02-26T12:00:00.000Z",
        },
      ],
      cardsTabs: [{ id: "history", kind: "history", title: "History" }],
      activeCardsTabId: "history",
    });

    const sidebarProps = (globalThis as { __lastLeftSidebarProps?: Record<string, unknown> }).__lastLeftSidebarProps;
    const stageGroups = (sidebarProps?.stageGroups as SidebarGroup[] | undefined) ?? [];
    const recentsGroup = stageGroups.find((group) => group.id === "recents");
    const cardsGroup = stageGroups.find((group) => group.id === "cards");
    const sectionIds = cardsGroup?.sections?.map((section) => section.id).join(",");
    const statusSection = cardsGroup?.sections?.find((section) => section.id === "cards:status:6-in-progress");

    expect(sectionIds).toBe("cards:status:6-in-progress");
    expect(statusSection?.label).toBe("In Progress");
    expect(statusSection?.count).toBe(2);
    expect(statusSection?.collapsible).toBeTrue();
    expect(statusSection?.items?.map((item) => item.label).join(",")).toBe("Card 1,Ops Card");
    expect(recentsGroup?.label).toBe("Recents");
    expect(recentsGroup?.items?.[0]?.label).toBe("Cross-project recent");
  });

  test("passes sidebar section visibility controls through to settings", async () => {
    await renderShell(false, "sliding-window", {
      sidebar: {
        collapsed: false,
        width: 280,
        topLevelSectionOrder: ["files", "threads", "recents", "cards"],
        topLevelSections: {
          recents: { visible: false, itemLimit: 10 },
          cards: { visible: true, itemLimit: 10 },
          threads: { visible: true, itemLimit: 15 },
          files: { visible: true, itemLimit: 20 },
        },
      },
    });

    const settingsProps = (globalThis as { __lastSettingsOverlayProps?: Record<string, unknown> }).__lastSettingsOverlayProps;

    expect((settingsProps?.sidebarTopLevelSectionOrder as string[] | undefined)?.join(",")).toBe("files,threads,recents,cards");
    expect((settingsProps?.sidebarTopLevelSections as Record<string, { visible: boolean }> | undefined)?.recents?.visible).toBeFalse();
    expect(typeof settingsProps?.onSidebarTopLevelSectionVisibleChange).toBe("function");
  });

  test("opens current-project status cards through the existing card-stage flow", async () => {
    resolveSlidingWindowFocusIntentCalls = [];
    resolveSlidingWindowFocusIntentReturn = { direction: "left" };
    const openCardStageCalls: Array<unknown[]> = [];
    const setFocusedStageCalls: Array<unknown[]> = [];
    const openCardStage = (...args: unknown[]) => {
      openCardStageCalls.push(args);
    };
    const setFocusedStage = (...args: unknown[]) => {
      setFocusedStageCalls.push(args);
    };

    await renderShell(false, "sliding-window", {
      openCardStage,
      setFocusedStage,
      focusedStage: "db",
      cardsTabs: [{ id: "history", kind: "history", title: "History" }],
      activeCardsTabId: "history",
    });

    const sidebarProps = (globalThis as { __lastLeftSidebarProps?: Record<string, unknown> }).__lastLeftSidebarProps;
    const stageGroups = (sidebarProps?.stageGroups as SidebarGroup[] | undefined) ?? [];
    const cardsGroup = stageGroups.find((group) => group.id === "cards");
    const statusCard = cardsGroup?.sections
      ?.find((section) => section.id === "cards:status:6-in-progress")
      ?.items?.find((item) => item.id === "project-card:card-1");

    expect(Boolean(statusCard?.onSelect)).toBeTrue();

    statusCard?.onSelect?.();

    expect(openCardStageCalls.length).toBe(1);
    expect(openCardStageCalls[0]?.[0]).toBe("default");
    expect(openCardStageCalls[0]?.[1]).toBe("card-1");
    expect(openCardStageCalls[0]?.[2]).toBe("Card 1");
    expect(
      setFocusedStageCalls.some((call) => call[0] === "default" && call[1] === "cards" && call[2] === "left"),
    ).toBeTrue();
    expect(resolveSlidingWindowFocusIntentCalls.length).toBe(1);
  });

  test("keeps grouped current-project cards independent from the active search query", async () => {
    await renderShell(false, "sliding-window", {
      activeSearchQuery: "ops",
      cardsTabs: [{ id: "history", kind: "history", title: "History" }],
      activeCardsTabId: "history",
    });

    const sidebarProps = (globalThis as { __lastLeftSidebarProps?: Record<string, unknown> }).__lastLeftSidebarProps;
    const stageGroups = (sidebarProps?.stageGroups as SidebarGroup[] | undefined) ?? [];
    const cardsGroup = stageGroups.find((group) => group.id === "cards");
    const statusSection = cardsGroup?.sections?.find((section) => section.id === "cards:status:6-in-progress");

    expect(statusSection?.items?.map((item) => item.label).join(",")).toBe("Card 1,Ops Card");
  });

  test("highlights only sidebar groups and items shown in visible sliding windows", async () => {
    await renderShell(false, "sliding-window", {
      activeView: "list",
      activeCardsTabId: "history",
      activeThreadsTabId: "thr-1",
      activeFilesTabId: "diff",
      focusedStage: "cards",
      stageNavDirection: "right",
      cardsTabs: [{ id: "history", kind: "history", title: "History" }],
      filesTabs: [{ id: "diff", title: "Diff" }],
    }, [
      {
        threadId: "thr-1",
        threadName: "Thread 1",
        threadPreview: "preview",
        statusType: "idle",
        cardId: "card-1",
      },
    ], null, ["cards", "threads"]);

    const sidebarProps = (globalThis as { __lastLeftSidebarProps?: Record<string, unknown> }).__lastLeftSidebarProps;
    const stageGroups = (sidebarProps?.stageGroups as SidebarGroup[] | undefined) ?? [];
    const dbGroup = stageGroups.find((group) => group.id === "db");
    const cardsGroup = stageGroups.find((group) => group.id === "cards");
    const threadsGroup = stageGroups.find((group) => group.id === "threads");
    const filesGroup = stageGroups.find((group) => group.id === "files");

    expect(dbGroup?.active).toBeFalse();
    expect(cardsGroup?.active).toBeTrue();
    expect(threadsGroup?.active).toBeTrue();
    expect(filesGroup?.active).toBeFalse();

    expect(dbGroup?.items?.some((item) => item.active)).toBeTrue();
    expect(cardsGroup?.items?.some((item) => item.active)).toBeFalse();
    expect(threadsGroup?.items?.some((item) => item.active)).toBeTrue();
    expect(filesGroup?.items?.some((item) => item.active)).toBeFalse();
  });

  test("shows only one visible stage in sidebar highlights when pane count is one", async () => {
    await renderShell(false, "sliding-window", {
      activeCardsTabId: "history",
      activeThreadsTabId: "thr-1",
      focusedStage: "cards",
      stageNavDirection: "right",
      slidingWindowPaneCount: 1,
      cardsTabs: [{ id: "history", kind: "history", title: "History" }],
    }, [
      {
        threadId: "thr-1",
        threadName: "Thread 1",
        threadPreview: "preview",
        statusType: "idle",
        cardId: "card-1",
      },
    ], null, ["cards"]);

    const sidebarProps = (globalThis as { __lastLeftSidebarProps?: Record<string, unknown> }).__lastLeftSidebarProps;
    const stageGroups = (sidebarProps?.stageGroups as SidebarGroup[] | undefined) ?? [];
    const cardsGroup = stageGroups.find((group) => group.id === "cards");
    const threadsGroup = stageGroups.find((group) => group.id === "threads");

    expect(cardsGroup?.active).toBeTrue();
    expect(threadsGroup?.active).toBeFalse();
    expect(cardsGroup?.items?.some((item) => item.active)).toBeFalse();
    expect(threadsGroup?.items?.some((item) => item.active)).toBeFalse();
  });

  test("keeps the same threads header icon when threads start running", async () => {
    await renderShell(false, "sliding-window", {}, [
      {
        threadId: "thr-idle",
        threadName: "Idle Thread",
        threadPreview: "preview",
        statusType: "idle",
        updatedAt: 1710000000000,
        cardId: "card-1",
      },
    ]);

    const idleSidebarProps = (globalThis as { __lastLeftSidebarProps?: Record<string, unknown> }).__lastLeftSidebarProps;
    const idleStageGroups = (idleSidebarProps?.stageGroups as SidebarGroup[] | undefined) ?? [];
    const idleThreadsGroup = idleStageGroups.find((group) => group.id === "threads");
    const idleThreadsIcon = idleThreadsGroup?.icon;

    await renderShell(false, "sliding-window", {}, [
      {
        threadId: "thr-running",
        threadName: "Running Thread",
        threadPreview: "preview",
        statusType: "active",
        updatedAt: 1710000000000,
        cardId: "card-1",
      },
    ]);

    const runningSidebarProps = (globalThis as { __lastLeftSidebarProps?: Record<string, unknown> }).__lastLeftSidebarProps;
    const runningStageGroups = (runningSidebarProps?.stageGroups as SidebarGroup[] | undefined) ?? [];
    const runningThreadsGroup = runningStageGroups.find((group) => group.id === "threads");

    expect(runningThreadsGroup?.icon).toBe(idleThreadsIcon);
  });

  test("adds running icon and elapsed source timestamp to thread sidebar items", async () => {
    await renderShell(false, "sliding-window", {}, [
      {
        threadId: "thr-running",
        threadName: "Running Thread",
        threadPreview: "preview",
        statusType: "active",
        updatedAt: 1710000000000,
        cardId: "card-1",
      },
      {
        threadId: "thr-idle",
        threadName: "Idle Thread",
        threadPreview: "preview",
        statusType: "idle",
        updatedAt: 1710001000000,
        cardId: "card-2",
      },
    ]);

    const sidebarProps = (globalThis as { __lastLeftSidebarProps?: Record<string, unknown> }).__lastLeftSidebarProps;
    const stageGroups = (sidebarProps?.stageGroups as SidebarGroup[] | undefined) ?? [];
    const threadsGroup = stageGroups.find((group) => group.id === "threads");
    const runningThreadItem = threadsGroup?.items?.find((item) => item.id === "thr-running");
    const idleThreadItem = threadsGroup?.items?.find((item) => item.id === "thr-idle");

    expect(runningThreadItem?.icon === undefined).toBeFalse();
    expect(runningThreadItem?.updatedAtMs).toBe(1710000000000);
    expect(idleThreadItem?.icon === undefined).toBeTrue();
    expect(idleThreadItem?.updatedAtMs).toBe(1710001000000);
  });

  test("renders global bottom terminal panel when opened", async () => {
    const markup = await renderShell(true);
    expect(markup.includes("Hide terminal panel")).toBeTrue();
    expect(markup.includes("data-terminal-panel=\"true\"")).toBeTrue();
  });

  test("wires stage rail layout mode into settings modal", async () => {
    await renderShell(false, "full-rail");
    const props = (globalThis as { __lastSettingsOverlayProps?: Record<string, unknown> }).__lastSettingsOverlayProps;
    expect(props?.stageRailLayoutMode).toBe("full-rail");
    expect(typeof props?.onStageRailLayoutModeChange).toBe("function");
  });

  test("wires smart prefix settings into settings modal", async () => {
    await renderShell(false, "full-rail");
    const props = (globalThis as { __lastSettingsOverlayProps?: Record<string, unknown> }).__lastSettingsOverlayProps;
    expect(props?.smartPrefixParsingEnabled).toBeTrue();
    expect(props?.stripSmartPrefixFromTitleEnabled).toBeTrue();
    expect(typeof props?.onSmartPrefixParsingEnabledChange).toBe("function");
    expect(typeof props?.onStripSmartPrefixFromTitleEnabledChange).toBe("function");
  });

  test("uses nearest sliding-window focus intent when selecting thread from sidebar", async () => {
    resolveSlidingWindowFocusIntentCalls = [];
    resolveSlidingWindowFocusIntentReturn = { direction: "left" };
    const setFocusedStageCalls: Array<unknown[]> = [];
    const setActiveThreadsTabCalls: Array<unknown[]> = [];
    const setFocusedStage = (...args: unknown[]) => {
      setFocusedStageCalls.push(args);
    };
    const setActiveThreadsTab = (...args: unknown[]) => {
      setActiveThreadsTabCalls.push(args);
    };

    await renderShell(false, "sliding-window", {
      setFocusedStage,
      setActiveThreadsTab,
      activeThreadsTabId: "thread:new",
    }, [
      {
        threadId: "thr-1",
        threadName: "Thread 1",
        threadPreview: "preview",
        statusType: "idle",
        cardId: "card-1",
      },
    ]);

    const leftSidebarProps = (globalThis as { __lastLeftSidebarProps?: Record<string, unknown> }).__lastLeftSidebarProps;
    const stageGroups = (leftSidebarProps?.stageGroups as Array<{ id: string; items?: Array<{ id: string; onSelect?: () => void }> }> | undefined) ?? [];
    const threadGroup = stageGroups.find((group) => group.id === "threads");
    const threadItem = threadGroup?.items?.find((item) => item.id === "thr-1");
    expect(Boolean(threadItem)).toBeTrue();

    threadItem?.onSelect?.();

    expect(setActiveThreadsTabCalls.length).toBe(1);
    expect(setActiveThreadsTabCalls[0]?.[0]).toBe("default");
    expect(setActiveThreadsTabCalls[0]?.[1]).toBe("thr-1");
    expect(setFocusedStageCalls.length).toBe(1);
    expect(setFocusedStageCalls[0]?.[0]).toBe("default");
    expect(setFocusedStageCalls[0]?.[1]).toBe("threads");
    expect(setFocusedStageCalls[0]?.[2]).toBe("left");
    expect(resolveSlidingWindowFocusIntentCalls.length).toBe(1);
  });

  test("uses nearest sliding-window focus intent when opening a linked thread from Card Stage", async () => {
    resolveSlidingWindowFocusIntentCalls = [];
    resolveSlidingWindowFocusIntentReturn = { direction: "left" };
    const setFocusedStageCalls: Array<unknown[]> = [];
    const setActiveThreadsTabCalls: Array<unknown[]> = [];
    const setFocusedStage = (...args: unknown[]) => {
      setFocusedStageCalls.push(args);
    };
    const setActiveThreadsTab = (...args: unknown[]) => {
      setActiveThreadsTabCalls.push(args);
    };

    await renderShell(false, "sliding-window", {
      setFocusedStage,
      setActiveThreadsTab,
      cardsTabs: [{ id: "session:s-1", kind: "session", title: "Card 1", sessionId: "s-1" }],
      activeCardsTabId: "session:s-1",
      cardStageState: {
        open: true,
        projectId: "default",
        cardId: "card-1",
      },
    });

    const cardStageProps = (globalThis as { __lastCardStageProps?: Record<string, unknown> }).__lastCardStageProps;
    const onOpenCodexThread = cardStageProps?.onOpenCodexThread as ((threadId: string) => Promise<void>) | undefined;
    expect(Boolean(onOpenCodexThread)).toBeTrue();

    await onOpenCodexThread?.("thr-1");

    expect(setActiveThreadsTabCalls.length).toBe(1);
    expect(setActiveThreadsTabCalls[0]?.[0]).toBe("default");
    expect(setActiveThreadsTabCalls[0]?.[1]).toBe("thr-1");
    expect(setFocusedStageCalls.length).toBe(1);
    expect(setFocusedStageCalls[0]?.[0]).toBe("default");
    expect(setFocusedStageCalls[0]?.[1]).toBe("threads");
    expect(setFocusedStageCalls[0]?.[2]).toBe("left");
    expect(resolveSlidingWindowFocusIntentCalls.length).toBe(1);
  });

  test("uses nearest sliding-window focus intent for db/cards/files sidebar interactions", async () => {
    resolveSlidingWindowFocusIntentCalls = [];
    resolveSlidingWindowFocusIntentReturn = { direction: "left" };
    const setFocusedStageCalls: Array<unknown[]> = [];
    const setViewCalls: Array<unknown[]> = [];
    const openCardStageCalls: Array<unknown[]> = [];
    const setActiveFilesTabCalls: Array<unknown[]> = [];
    const setFocusedStage = (...args: unknown[]) => {
      setFocusedStageCalls.push(args);
    };
    const setView = (...args: unknown[]) => {
      setViewCalls.push(args);
    };
    const openCardStage = (...args: unknown[]) => {
      openCardStageCalls.push(args);
    };
    const setActiveFilesTab = (...args: unknown[]) => {
      setActiveFilesTabCalls.push(args);
    };

    await renderShell(false, "sliding-window", {
      setFocusedStage,
      setView,
      openCardStage,
      setActiveFilesTab,
      cardsTabs: [{ id: "history", kind: "history", title: "History" }],
      filesTabs: [{ id: "diff", title: "Diff" }],
    });

    const leftSidebarProps = (globalThis as { __lastLeftSidebarProps?: Record<string, unknown> }).__lastLeftSidebarProps;
    const stageGroups = (leftSidebarProps?.stageGroups as SidebarGroup[] | undefined) ?? [];
    const dbGroup = stageGroups.find((group) => group.id === "db");
    const cardsGroup = stageGroups.find((group) => group.id === "cards");
    const filesGroup = stageGroups.find((group) => group.id === "files");
    const dbItem = dbGroup?.items?.[0];
    const cardsItem = cardsGroup?.items?.[0];
    const filesItem = filesGroup?.items?.[0];

    expect(Boolean(dbItem)).toBeTrue();
    expect(Boolean(cardsItem)).toBeTrue();
    expect(Boolean(filesItem)).toBeTrue();

    dbItem?.onSelect?.();
    cardsItem?.onSelect?.();
    filesItem?.onSelect?.();
    dbGroup?.onFocus?.();
    cardsGroup?.onFocus?.();
    filesGroup?.onFocus?.();

    expect(setViewCalls.length).toBe(1);
    expect(openCardStageCalls.length).toBe(1);
    expect(setActiveFilesTabCalls.length).toBe(1);
    expect(openCardStageCalls[0]?.[0]).toBe("default");
    expect(openCardStageCalls[0]?.[1]).toBe("card-1");
    expect(
      setFocusedStageCalls.some((call) => call[0] === "default" && call[1] === "db" && call[2] === "left"),
    ).toBeTrue();
    expect(
      setFocusedStageCalls.some((call) => call[0] === "default" && call[1] === "cards" && call[2] === "left"),
    ).toBeTrue();
    expect(
      setFocusedStageCalls.some((call) => call[0] === "default" && call[1] === "files" && call[2] === "left"),
    ).toBeTrue();
    expect(resolveSlidingWindowFocusIntentCalls.length).toBe(6);
  });

  test("uses nearest sliding-window focus intent when opening a card from thread", async () => {
    resolveSlidingWindowFocusIntentCalls = [];
    resolveSlidingWindowFocusIntentReturn = { direction: "left" };
    const setFocusedStageCalls: Array<unknown[]> = [];
    const openCardStageCalls: Array<unknown[]> = [];
    const setFocusedStage = (...args: unknown[]) => {
      setFocusedStageCalls.push(args);
    };
    const openCardStage = (...args: unknown[]) => {
      openCardStageCalls.push(args);
    };

    await renderShell(false, "sliding-window", {
      setFocusedStage,
      openCardStage,
      focusedStage: "threads",
      stageNavDirection: "right",
      activeThreadsTabId: "thr-1",
    }, [
      {
        threadId: "thr-1",
        threadName: "Thread 1",
        threadPreview: "preview",
        statusType: "idle",
        cardId: "card-1",
      },
    ]);

    const stageThreadsProps = (globalThis as { __lastStageThreadsProps?: Record<string, unknown> }).__lastStageThreadsProps;
    const onOpenCard = stageThreadsProps?.onOpenCard as ((cardId: string) => void) | undefined;
    expect(Boolean(onOpenCard)).toBeTrue();

    onOpenCard?.("card-1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invokeCalls.length).toBe(0);
    expect(openCardStageCalls.length).toBe(1);
    expect(setFocusedStageCalls.length).toBe(1);
    expect(setFocusedStageCalls[0]?.[0]).toBe("default");
    expect(setFocusedStageCalls[0]?.[1]).toBe("cards");
    expect(setFocusedStageCalls[0]?.[2]).toBe("left");
    expect(resolveSlidingWindowFocusIntentCalls.length).toBe(1);
  });

  test("shows global recent cards in sidebar and preserves sliding-window focus intent", async () => {
    resolveSlidingWindowFocusIntentCalls = [];
    resolveSlidingWindowFocusIntentReturn = { direction: "left" };
    const setFocusedStageCalls: Array<unknown[]> = [];
    const setActiveCardsTabCalls: Array<unknown[]> = [];
    const selectRecentCardSessionCalls: Array<unknown[]> = [];
    const setActiveThreadsTabCalls: Array<unknown[]> = [];
    const setFocusedStage = (...args: unknown[]) => {
      setFocusedStageCalls.push(args);
    };
    const setActiveCardsTab = (...args: unknown[]) => {
      setActiveCardsTabCalls.push(args);
    };
    const selectRecentCardSession = (...args: unknown[]) => {
      selectRecentCardSessionCalls.push(args);
    };
    const setActiveThreadsTab = (...args: unknown[]) => {
      setActiveThreadsTabCalls.push(args);
    };

    await renderShell(false, "sliding-window", {
      projects: [
        ...PROJECTS,
        {
          id: "ops",
          name: "Ops",
          description: "",
          created: new Date("2026-02-25T00:00:00.000Z"),
        },
      ],
      spaces: [
        { projectId: "default", colorToken: "#2783de", initial: "D" },
        { projectId: "ops", colorToken: "#de9255", initial: "O" },
      ],
      recentCardSessions: [
        {
          id: "s-1",
          projectId: "ops",
          cardId: "card-1",
          titleSnapshot: "Card 1",
          lastOpenedAt: "2026-02-26T12:00:00.000Z",
        },
      ],
      setFocusedStage,
      setActiveCardsTab,
      selectRecentCardSession,
      setActiveThreadsTab,
      focusedStage: "cards",
      cardsTabs: [{ id: "history", kind: "history", title: "History" }],
      activeCardsTabId: "history",
      activeThreadsTabId: "thread:new",
    }, [
      {
        threadId: "thr-1",
        threadName: "Thread 1",
        threadPreview: "preview",
        statusType: "idle",
        cardId: "card-1",
      },
    ], null, ["cards", "threads"]);

    const sidebarProps = (globalThis as { __lastLeftSidebarProps?: Record<string, unknown> }).__lastLeftSidebarProps;
    const stageGroups = (sidebarProps?.stageGroups as SidebarGroup[] | undefined) ?? [];
    const recentsGroup = stageGroups.find((group) => group.id === "recents");
    const threadsGroup = stageGroups.find((group) => group.id === "threads");
    const cardsSession = recentsGroup?.items?.find((item) => item.id === "session:s-1");
    const threadEntry = threadsGroup?.items?.find((item) => item.id === "thr-1");
    expect(Boolean(cardsSession?.onSelect)).toBeTrue();
    expect(Boolean(threadEntry?.onSelect)).toBeTrue();

    cardsSession?.onSelect?.();
    threadEntry?.onSelect?.();

    expect(setActiveCardsTabCalls.length).toBe(0);
    expect(selectRecentCardSessionCalls.length).toBe(1);
    expect(selectRecentCardSessionCalls[0]?.[0]).toBe("s-1");
    expect(setActiveThreadsTabCalls.length).toBe(1);
    expect(setActiveThreadsTabCalls[0]?.[0]).toBe("default");
    expect(setActiveThreadsTabCalls[0]?.[1]).toBe("thr-1");
    expect(
      setFocusedStageCalls.some((call) => call[0] === "default" && call[1] === "cards" && call[2] === "left"),
    ).toBeTrue();
    expect(
      setFocusedStageCalls.some((call) => call[0] === "default" && call[1] === "threads" && call[2] === "left"),
    ).toBeTrue();
    expect(resolveSlidingWindowFocusIntentCalls.length).toBe(2);
  });

  test("uses nearest sliding-window focus intent when starting a thread for active project", async () => {
    resolveSlidingWindowFocusIntentCalls = [];
    resolveSlidingWindowFocusIntentReturn = { direction: "left" };
    const setFocusedStageCalls: Array<unknown[]> = [];
    const setActiveThreadsTabCalls: Array<unknown[]> = [];
    const setFocusedStage = (...args: unknown[]) => {
      setFocusedStageCalls.push(args);
    };
    const setActiveThreadsTab = (...args: unknown[]) => {
      setActiveThreadsTabCalls.push(args);
    };

    await renderShell(false, "sliding-window", {
      setFocusedStage,
      setActiveThreadsTab,
      dbProjectId: "default",
      focusedStage: "threads",
      stageNavDirection: "right",
      activeThreadsTabId: "thread:new",
    }, [], null, ["threads", "files"]);

    const stageThreadsProps = (globalThis as { __lastStageThreadsProps?: Record<string, unknown> }).__lastStageThreadsProps;
    const onStartThreadForCard = stageThreadsProps?.onStartThreadForCard as ((input: {
      projectId: string;
      cardId: string;
      prompt: string;
      threadName?: string;
    }) => Promise<void>) | undefined;
    expect(Boolean(onStartThreadForCard)).toBeTrue();

    await onStartThreadForCard?.({
      projectId: "default",
      cardId: "card-1",
      prompt: "hello",
      threadName: "Test Thread",
    });

    expect(setActiveThreadsTabCalls.length).toBe(1);
    expect(setActiveThreadsTabCalls[0]?.[0]).toBe("default");
    expect(setActiveThreadsTabCalls[0]?.[1]).toBe("t-1");
    expect(setFocusedStageCalls.length).toBe(1);
    expect(setFocusedStageCalls[0]?.[0]).toBe("default");
    expect(setFocusedStageCalls[0]?.[1]).toBe("threads");
    expect(setFocusedStageCalls[0]?.[2]).toBe("left");
    expect(resolveSlidingWindowFocusIntentCalls.length).toBe(1);
  });

  test("starts thread without requesting manual card-stage sync", async () => {
    await renderShell(false, "sliding-window", {
      dbProjectId: "default",
      focusedStage: "threads",
      stageNavDirection: "right",
      activeThreadsTabId: "thread:new",
      cardStageState: {
        open: true,
        projectId: "default",
        cardId: "card-1",
      },
    }, [], null, ["threads", "files"]);

    const stageThreadsProps = (globalThis as { __lastStageThreadsProps?: Record<string, unknown> }).__lastStageThreadsProps;
    const onStartThreadForCard = stageThreadsProps?.onStartThreadForCard as ((input: {
      projectId: string;
      cardId: string;
      prompt: string;
      threadName?: string;
    }) => Promise<void>) | undefined;
    expect(Boolean(onStartThreadForCard)).toBeTrue();

    await onStartThreadForCard?.({
      projectId: "default",
      cardId: "card-1",
      prompt: "create worktree thread",
    });

    expect(invokeCalls.some((call) => call[0] === "card:get")).toBeFalse();
  });

  test("focuses cards stage when opening a card from view and cards are not visible", async () => {
    const setFocusedStageCalls: Array<unknown[]> = [];
    const openCardStageCalls: Array<unknown[]> = [];
    const setFocusedStage = (...args: unknown[]) => {
      setFocusedStageCalls.push(args);
    };
    const openCardStage = (...args: unknown[]) => {
      openCardStageCalls.push(args);
    };

    await renderShell(false, "sliding-window", {
      openCardStage,
      setFocusedStage,
      focusedStage: "db",
      stageNavDirection: "right",
      slidingWindowPaneCount: 2,
    }, [], null, ["db", "threads"]);

    const mainViewHostProps = (globalThis as { __lastMainViewHostProps?: Record<string, unknown> }).__lastMainViewHostProps;
    const openCardStageFromView = mainViewHostProps?.openCardStage as (
      projectId: string,
      columnId: string,
      card: Record<string, unknown>,
      availableTags: string[],
      handlers: Record<string, unknown>,
    ) => void;
    expect(Boolean(openCardStageFromView)).toBeTrue();

    openCardStageFromView(
      "default",
      "6-in-progress",
      { id: "card-1", title: "Card 1" },
      [],
      {
        onUpdate: async () => undefined,
        onPatch: () => undefined,
        onDelete: async () => undefined,
        onMove: async () => undefined,
      },
    );

    expect(openCardStageCalls.length).toBe(1);
    expect(setFocusedStageCalls.length).toBe(1);
    expect(setFocusedStageCalls[0]?.[0]).toBe("default");
    expect(setFocusedStageCalls[0]?.[1]).toBe("cards");
  });

  test("does not refocus stage when cards are already visible in right pane", async () => {
    const setFocusedStageCalls: Array<unknown[]> = [];
    const openCardStageCalls: Array<unknown[]> = [];
    const setFocusedStage = (...args: unknown[]) => {
      setFocusedStageCalls.push(args);
    };
    const openCardStage = (...args: unknown[]) => {
      openCardStageCalls.push(args);
    };

    await renderShell(false, "sliding-window", {
      openCardStage,
      setFocusedStage,
      focusedStage: "db",
      stageNavDirection: "right",
      slidingWindowPaneCount: 2,
    }, [], null, ["db", "cards"]);

    const mainViewHostProps = (globalThis as { __lastMainViewHostProps?: Record<string, unknown> }).__lastMainViewHostProps;
    const openCardStageFromView = mainViewHostProps?.openCardStage as (
      projectId: string,
      columnId: string,
      card: Record<string, unknown>,
      availableTags: string[],
      handlers: Record<string, unknown>,
    ) => void;
    expect(Boolean(openCardStageFromView)).toBeTrue();

    openCardStageFromView(
      "default",
      "6-in-progress",
      { id: "card-1", title: "Card 1" },
      [],
      {
        onUpdate: async () => undefined,
        onPatch: () => undefined,
        onDelete: async () => undefined,
        onMove: async () => undefined,
      },
    );

    expect(openCardStageCalls.length).toBe(1);
    expect(setFocusedStageCalls.length).toBe(0);
  });
});
