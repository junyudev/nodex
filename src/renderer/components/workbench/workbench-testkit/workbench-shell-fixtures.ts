import type {
  CodexAutomationInboxItem,
  CodexModelOption,
  CodexScheduledAutomation,
  CodexSidebarThreadItem,
  Project,
  WorkbenchPanelNode,
  WorkbenchProjectionDbViewTabConfig,
  WorkbenchProjectionTabConfiguration,
  WorkbenchTabProjection,
  WorkbenchTabUpdateInput,
} from "@/lib/types";
import type { WorkbenchSessionRenderProjection } from "@/lib/workbench-session-presentation";
import type { SidebarCollapsibleSectionsState } from "@/lib/use-workbench-profile-preferences";
import { parseWorkbenchProjectionTabConfig } from "../../../../shared/schemas/project-sessions";
import { makeWorkbenchPanelLayout } from "../../../../shared/workbench-panel-layout";
import {
  WORKBENCH_SESSION_VIEW_VERSION,
  type WorkbenchSessionViewSnapshot,
  type WorkbenchSessionViewTab,
} from "../../../../shared/workbench-session-view";

export type ProjectSession = WorkbenchSessionRenderProjection;

export const DEFAULT_SIDEBAR_COLLAPSIBLE_SECTIONS: SidebarCollapsibleSectionsState = {
  pinned: false,
  pages: false,
  projects: false,
  chats: false,
};

export const DEFAULT_TEST_CODEX_MODELS: CodexModelOption[] = [
  {
    id: "gpt-5.5",
    model: "gpt-5.5",
    displayName: "GPT-5.5",
    description: "Default coding model",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "Balanced" },
      { reasoningEffort: "high", description: "Deep" },
    ],
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    multiAgentVersion: null,
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: true,
  },
  {
    id: "gpt-5.5-high",
    model: "gpt-5.5-high",
    displayName: "GPT-5.5 High",
    description: "High-only scheduled-task test model",
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Deep" }],
    defaultReasoningEffort: "high",
    inputModalities: ["text", "image"],
    multiAgentVersion: null,
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
  },
];

export function makeProject(id = "alpha", name = "Alpha", primarySourceRoot?: string): Project {
  const normalizedPrimarySourceRoot = primarySourceRoot?.trim() || null;
  return {
    id,
    libraryId: "library:test",
    databaseId: "database:test:primary",
    defaultDatabaseViewId: `database-view:${id}:primary-board`,
    lifecycle: "active",
    bindingRevision: 1,
    name,
    description: "",
    appearance: {
      color: "black",
      marker: { kind: "icon", icon: "folder" },
    },
    sources: normalizedPrimarySourceRoot ? [{ root: normalizedPrimarySourceRoot, order: 0 }] : [],
    primaryWorkspaceRoot: normalizedPrimarySourceRoot,
    pinned: false,
    pinnedOrder: null,
    created: new Date("2026-06-07T00:00:00.000Z"),
    updated: new Date("2026-06-07T00:00:00.000Z"),
  };
}

export function makeScheduledAutomation(
  overrides: Partial<CodexScheduledAutomation> = {},
): CodexScheduledAutomation {
  return {
    id: "automation-alpha",
    definitionRevision: 1,
    kind: "heartbeat",
    status: "ACTIVE",
    targetThreadId: "thread-alpha",
    name: "Alpha standup",
    prompt: "Check the alpha standup thread.",
    rrule: "FREQ=DAILY",
    model: null,
    reasoningEffort: null,
    serviceTier: null,
    backendBinding: { kind: "codex" },
    cwds: [],
    executionEnvironment: "worktree",
    localEnvironmentConfigPath: null,
    nextRunAt: new Date("2026-06-08T09:00:00.000Z").getTime(),
    lastRunAt: null,
    createdAt: new Date("2026-06-07T00:00:00.000Z").getTime(),
    updatedAt: new Date("2026-06-07T00:00:00.000Z").getTime(),
    ...overrides,
  };
}

export function makeAutomationInboxItem(
  overrides: Partial<CodexAutomationInboxItem> = {},
): CodexAutomationInboxItem {
  return {
    id: "run-alpha",
    automationId: "automation-alpha",
    automationName: "Alpha standup",
    title: "Alpha standup run",
    description: "Review the run.",
    archivedAssistantMessage: null,
    archivedUserMessage: null,
    archivedReason: null,
    sourceCwd: "/Users/asc/repo/nodex",
    threadId: "thread-run-alpha",
    readAt: null,
    createdAt: 10,
    status: "PENDING_REVIEW",
    ...overrides,
  };
}

export function makePanelLayout(tabIds: string[], activeTabId: string | null) {
  return makeWorkbenchPanelLayout(tabIds, activeTabId);
}

export function firstPanelLeafId(node: WorkbenchPanelNode): string {
  if (node.type === "leaf") return node.id;
  return firstPanelLeafId(node.first);
}

export function updatePanelLeafActiveTab(
  node: WorkbenchPanelNode,
  leafId: string,
  tabId: string | null | undefined,
): WorkbenchPanelNode {
  if (node.type === "leaf") {
    if (node.id !== leafId) return node;
    return {
      ...node,
      activeTabId: tabId ?? node.activeTabId,
      mruTabIds:
        tabId && node.tabIds.includes(tabId)
          ? [tabId, ...node.mruTabIds.filter((id) => id !== tabId)]
          : node.mruTabIds,
    };
  }
  return {
    ...node,
    first: updatePanelLeafActiveTab(node.first, leafId, tabId),
    second: updatePanelLeafActiveTab(node.second, leafId, tabId),
  };
}

export function appendTestPanelLeafTab(
  node: WorkbenchPanelNode,
  leafId: string,
  tabId: string,
): WorkbenchPanelNode {
  if (node.type === "leaf") {
    if (node.id !== leafId) return node;
    return {
      ...node,
      tabIds: [...node.tabIds.filter((id) => id !== tabId), tabId],
      activeTabId: tabId,
      mruTabIds: [tabId, ...node.mruTabIds.filter((id) => id !== tabId)],
    };
  }
  return {
    ...node,
    first: appendTestPanelLeafTab(node.first, leafId, tabId),
    second: appendTestPanelLeafTab(node.second, leafId, tabId),
  };
}

export function appendTestPanelLayoutTab(
  layout: ProjectSession["panels"]["right"]["layout"],
  leafId: string,
  tabId: string,
): ProjectSession["panels"]["right"]["layout"] {
  return {
    ...layout,
    root: appendTestPanelLeafTab(layout.root, leafId, tabId),
    activeLeafId: leafId,
    mruLeafIds: [leafId, ...layout.mruLeafIds.filter((id) => id !== leafId)],
  };
}

export function activateTestPanelLayout(
  layout: ProjectSession["panels"]["right"]["layout"],
  leafId: string | undefined,
  tabId: string | null | undefined,
): ProjectSession["panels"]["right"]["layout"] {
  const activeLeafId = leafId ?? firstPanelLeafId(layout.root);
  const root = updatePanelLeafActiveTab(layout.root, activeLeafId, tabId);
  return {
    ...layout,
    root,
    activeLeafId,
    mruLeafIds: [activeLeafId, ...layout.mruLeafIds.filter((id) => id !== activeLeafId)],
  };
}

export function makePanels(
  options: {
    rightTabIds?: string[];
    rightActiveTabId?: string | null;
    rightCollapsed?: boolean;
    rightFullWidth?: boolean;
    bottomTabIds?: string[];
    bottomActiveTabId?: string | null;
    bottomCollapsed?: boolean;
  } = {},
): ProjectSession["panels"] {
  const rightTabIds = options.rightTabIds ?? [];
  const bottomTabIds = options.bottomTabIds ?? [];
  return {
    right: {
      collapsed: options.rightCollapsed ?? false,
      layout: makePanelLayout(rightTabIds, options.rightActiveTabId ?? rightTabIds[0] ?? null),
      size: { widthPx: 600, fullWidth: options.rightFullWidth ?? false },
    },
    bottom: {
      collapsed: options.bottomCollapsed ?? true,
      layout: makePanelLayout(bottomTabIds, options.bottomActiveTabId ?? bottomTabIds[0] ?? null),
      size: { heightPx: 280 },
    },
  };
}

export type SessionTabFixtureCommon = Pick<WorkbenchTabProjection, "id" | "title"> &
  Partial<
    Pick<
      WorkbenchTabProjection,
      | "sessionId"
      | "projectId"
      | "panelId"
      | "order"
      | "stateKey"
      | "state"
      | "createdAt"
      | "updatedAt"
    >
  >;
export type SessionTabFixtureConfiguration =
  | Exclude<WorkbenchProjectionTabConfiguration, { kind: "db_view" }>
  | {
      kind: "db_view";
      config: Omit<WorkbenchProjectionDbViewTabConfig, "databaseViewId"> & {
        databaseViewId?: string;
      };
    };
export type SessionTabFixture<
  Configuration extends SessionTabFixtureConfiguration = SessionTabFixtureConfiguration,
> = Configuration extends { kind: "browser" }
  ? Configuration & SessionTabFixtureCommon & { browserTabId?: string }
  : Configuration & SessionTabFixtureCommon & { browserTabId?: never };
export type SessionTabInput = SessionTabFixture | WorkbenchTabProjection;
export type SessionFixtureOverrides = Omit<Partial<ProjectSession>, "tabs"> & {
  title?: string;
  threadId?: string;
  tabs?: SessionTabInput[];
  rightCollapsed?: boolean;
  rightFullWidth?: boolean;
  rightLayout?: ProjectSession["panels"]["right"]["layout"];
};

export function fillDbViewFixtureConfig(
  config: Omit<WorkbenchProjectionDbViewTabConfig, "databaseViewId"> & {
    databaseViewId?: string;
  },
): WorkbenchProjectionDbViewTabConfig {
  return {
    ...config,
    databaseViewId: config.databaseViewId ?? `database-view:${config.projectId}:primary-board`,
  };
}

export function makeSessionTab(overrides: SessionTabInput): WorkbenchTabProjection {
  const base = {
    sessionId: "session:alpha:database-view",
    projectId: "alpha",
    panelId: "right",
    order: 0,
    stateKey: 0,
    state: {},
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  } satisfies Pick<
    WorkbenchTabProjection,
    | "sessionId"
    | "projectId"
    | "panelId"
    | "order"
    | "stateKey"
    | "state"
    | "createdAt"
    | "updatedAt"
  >;
  const filled =
    overrides.kind === "db_view"
      ? { ...overrides, config: fillDbViewFixtureConfig(overrides.config) }
      : overrides;
  return filled.kind === "browser"
    ? {
        ...base,
        ...filled,
        browserTabId: filled.browserTabId ?? `browser:${filled.id}`,
      }
    : { ...base, ...filled, browserTabId: null };
}

export function updateSessionTab(
  tab: WorkbenchTabProjection,
  input: WorkbenchTabUpdateInput,
  updatedAt: string,
): WorkbenchTabProjection {
  const common = {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.stateKey !== undefined ? { stateKey: input.stateKey } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, "state") ? { state: input.state } : {}),
    updatedAt,
  };
  switch (tab.kind) {
    case "db_view":
      return {
        ...tab,
        ...common,
        ...(input.config === undefined
          ? {}
          : { config: parseWorkbenchProjectionTabConfig(tab.kind, input.config) }),
      };
    case "page_stage":
      return {
        ...tab,
        ...common,
        ...(input.config === undefined
          ? {}
          : { config: parseWorkbenchProjectionTabConfig(tab.kind, input.config) }),
      };
    case "canvas_stage":
      return {
        ...tab,
        ...common,
        ...(input.config === undefined
          ? {}
          : { config: parseWorkbenchProjectionTabConfig(tab.kind, input.config) }),
      };
    case "terminal":
      return {
        ...tab,
        ...common,
        ...(input.config === undefined
          ? {}
          : { config: parseWorkbenchProjectionTabConfig(tab.kind, input.config) }),
      };
    case "browser":
      return {
        ...tab,
        ...common,
        ...(input.config === undefined
          ? {}
          : { config: parseWorkbenchProjectionTabConfig(tab.kind, input.config) }),
      };
    case "review":
      return {
        ...tab,
        ...common,
        ...(input.config === undefined
          ? {}
          : { config: parseWorkbenchProjectionTabConfig(tab.kind, input.config) }),
      };
    case "files":
      return {
        ...tab,
        ...common,
        ...(input.config === undefined
          ? {}
          : { config: parseWorkbenchProjectionTabConfig(tab.kind, input.config) }),
      };
    case "image_editor":
      return {
        ...tab,
        ...common,
        ...(input.config === undefined
          ? {}
          : { config: parseWorkbenchProjectionTabConfig(tab.kind, input.config) }),
      };
  }
}

export function makeSession(overrides: SessionFixtureOverrides = {}): ProjectSession {
  const {
    rightCollapsed,
    rightFullWidth,
    rightLayout,
    tabs: rawTabs,
    title,
    ...sessionOverrides
  } = overrides;
  const projectId = overrides.projectId === undefined ? "alpha" : overrides.projectId;
  const sessionId = overrides.id ?? "session:alpha:database-view";
  const thread = sessionOverrides.thread ?? null;
  const noThreadFallbackTitle = sessionOverrides.noThreadFallbackTitle ?? title ?? "Database View";
  const displayTitle =
    sessionOverrides.displayTitle ??
    title ??
    thread?.threadName ??
    thread?.threadPreview ??
    noThreadFallbackTitle;
  const databaseViewStarter = thread === null && noThreadFallbackTitle === "Database View";
  const tabId = `${sessionId}:db`;
  const defaultTabs: SessionTabInput[] =
    projectId === null
      ? []
      : [
          makeSessionTab({
            id: tabId,
            sessionId,
            projectId,
            kind: "db_view",
            title: "DB View",
            config: { projectId },
          }),
        ];
  const tabs = (rawTabs ?? defaultTabs).map((tab, index) =>
    makeSessionTab({
      sessionId,
      projectId: tab.projectId ?? projectId ?? "alpha",
      panelId: tab.panelId ?? (tab.kind === "terminal" ? "bottom" : "right"),
      order: index,
      ...tab,
    }),
  );
  const rightTabIds = tabs.filter((tab) => tab.panelId === "right").map((tab) => tab.id);
  const bottomTabIds = tabs.filter((tab) => tab.panelId === "bottom").map((tab) => tab.id);
  const basePanels =
    overrides.panels ??
    makePanels({
      rightTabIds,
      rightActiveTabId:
        rightLayout?.root.type === "leaf" ? rightLayout.root.activeTabId : (rightTabIds[0] ?? null),
      rightCollapsed: rightCollapsed ?? false,
      rightFullWidth: rightFullWidth ?? sessionOverrides.pinned ?? databaseViewStarter,
      bottomTabIds,
      bottomActiveTabId: bottomTabIds[0] ?? null,
      bottomCollapsed: bottomTabIds.length === 0,
    });
  const panels = rightLayout
    ? {
        ...basePanels,
        right: {
          ...basePanels.right,
          layout: rightLayout,
        },
      }
    : basePanels;
  return {
    id: sessionId,
    projectId,
    noThreadFallbackTitle,
    displayTitle,
    order: 0,
    panels,
    thread,
    tabs,
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
    ...sessionOverrides,
    pinned: sessionOverrides.pinned ?? databaseViewStarter,
    pinnedOrder: sessionOverrides.pinnedOrder ?? (databaseViewStarter ? 0 : null),
    archived: sessionOverrides.archived ?? false,
    archivedAt: sessionOverrides.archivedAt ?? null,
    unread: sessionOverrides.unread ?? false,
  };
}

export function makeAttachedSession(overrides: SessionFixtureOverrides = {}): ProjectSession {
  const { threadId = "thread-alpha", ...sessionOverrides } = overrides;
  return makeSession({
    thread: {
      sessionId: overrides.id ?? "session:alpha:database-view",
      projectId: overrides.projectId === undefined ? "alpha" : overrides.projectId,
      threadId,
      parentThreadId: undefined,
      threadName: "Alpha thread",
      threadPreview: "Working on the active session",
      backendBinding: { kind: "codex" },
      executionHostId: "local",
      cwd: "/Users/asc/repo/nodex",
      statusType: "notLoaded",
      statusActiveFlags: [],
      archived: false,
      createdAt: 1_780_800_000_000,
      updatedAt: 1_780_800_000_000,
      linkedAt: "2026-06-07T00:00:00.000Z",
    },
    ...sessionOverrides,
  });
}

export function makeSessionViewFixture(session: ProjectSession): WorkbenchSessionViewSnapshot {
  const tabsById = Object.fromEntries(
    session.tabs.map((tab) => {
      const common = {
        id: tab.id,
        titleSnapshot: tab.title,
        stateKey: tab.stateKey,
        state: tab.state,
      };
      const viewTab =
        tab.kind === "browser"
          ? {
              ...common,
              kind: tab.kind,
              config: {
                browserTabId: tab.browserTabId,
                ...("url" in tab.config && tab.config.url ? { url: tab.config.url } : {}),
                ...("title" in tab.config && tab.config.title ? { title: tab.config.title } : {}),
                ...("faviconUrl" in tab.config && tab.config.faviconUrl
                  ? { faviconUrl: tab.config.faviconUrl }
                  : {}),
                ...("deviceToolbarVisible" in tab.config &&
                tab.config.deviceToolbarVisible !== undefined
                  ? { deviceToolbarVisible: tab.config.deviceToolbarVisible }
                  : {}),
              },
            }
          : {
              ...common,
              kind: tab.kind,
              config: tab.config,
            };
      return [tab.id, viewTab as WorkbenchSessionViewTab];
    }),
  );
  return {
    version: WORKBENCH_SESSION_VIEW_VERSION,
    sessionId: session.id,
    tabsById,
    panels: session.panels,
    lastFocusedPanelId: null,
    touchedAt: session.updatedAt,
  };
}

export function makeSidebarSnapshotItemForSession(session: ProjectSession): CodexSidebarThreadItem {
  if (!session.thread) throw new Error("Expected attached session");
  const hostId = session.thread.executionHostId;
  const local = hostId === "local";
  const managedWorktreePath = session.thread.managedWorktreePath ?? null;
  return {
    key: `${local ? "local" : "remote"}:${session.thread.threadId}`,
    kind: local ? "local" : "remote",
    backendBinding: session.thread.backendBinding,
    runLocation: managedWorktreePath
      ? local
        ? { kind: "local-worktree", path: managedWorktreePath, phase: "ready" }
        : { kind: "remote-worktree", hostId, path: managedWorktreePath, phase: "ready" }
      : local
        ? { kind: "local-checkout" }
        : { kind: "remote-checkout", hostId },
    hostId,
    threadId: session.thread.threadId,
    parentThreadId: session.thread.parentThreadId ?? null,
    sessionId: session.id,
    projectId: session.projectId,
    title: session.displayTitle,
    preview: session.thread.threadPreview,
    cwd: session.thread.cwd ?? null,
    updatedAt: session.thread.updatedAt,
    createdAt: session.thread.createdAt,
    pinned: session.pinned,
    pinnedOrder: session.pinnedOrder,
    unread: session.unread,
    archived: session.archived || session.thread.archived,
    statusType: "notLoaded",
    statusActiveFlags: [],
    projectless: session.projectId === null,
    disabled: false,
  };
}

export function makeBlankSession(overrides: SessionFixtureOverrides = {}): ProjectSession {
  return makeSession({
    id: "session:alpha:blank",
    title: "New thread",
    panels: makePanels({ rightCollapsed: true }),
    thread: null,
    tabs: [],
    ...overrides,
  });
}

export function makeBottomPanelTerminalSession(
  overrides: SessionFixtureOverrides = {},
): ProjectSession {
  return makeSession({
    id: "session:alpha:terminal",
    title: "Terminal",
    rightCollapsed: true,
    tabs: [
      {
        id: "terminal-tab",
        kind: "terminal",
        title: "Terminal",
        panelId: "bottom",
        config: { terminalSessionId: "terminal" },
      },
    ],
    ...overrides,
  });
}

export function replaceSession(
  current: Record<string, ProjectSession[]>,
  nextSession: ProjectSession,
): Record<string, ProjectSession[]> {
  return Object.fromEntries(
    Object.entries(current).map(([projectId, sessions]) => [
      projectId,
      sessions.map((session) => (session.id === nextSession.id ? nextSession : session)),
    ]),
  );
}

export function sortProjectSessionsForTest(sessions: ProjectSession[]): ProjectSession[] {
  return [...sessions].sort((a, b) => {
    const rank = (session: ProjectSession) => (session.pinned ? 0 : 1);
    const rankDelta = rank(a) - rank(b);
    if (rankDelta !== 0) return rankDelta;
    if (a.pinned || b.pinned) {
      return (
        (a.pinnedOrder ?? Number.MAX_SAFE_INTEGER) - (b.pinnedOrder ?? Number.MAX_SAFE_INTEGER)
      );
    }
    return a.order - b.order;
  });
}
