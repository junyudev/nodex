import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import type {
  BoardSummary,
  DatabasePage,
  Project,
  ProjectSessionThreadLink,
  WorkbenchTabProjection,
  WorkbenchProjectionTabConfiguration,
} from "@/lib/types";
import * as Y from "yjs";
import {
  PAGE_DOCUMENT_SCHEMA_VERSION,
  createPageDocument,
  plainTextToPortableRichText,
} from "../../../shared/block-documents";
import { populateBlockDocumentBodyFromNfm } from "../../../shared/block-documents/block-document-codec";
import {
  INITIAL_PROJECT_NAME,
  INITIAL_PROJECT_WELCOME_TITLE,
  renderInitialProjectWelcomePage,
} from "../../../shared/initial-project-welcome";
import type { LibraryModuleReadRequest, LibraryReadValue } from "../../../shared/library-module";
import type { CodexSideChatStartInput, CodexSideChatStartResult } from "../../../shared/types";
import { buildPageDetailStoryResult } from "../board/page-stage/page-stage-story-page-detail";
import {
  findWorkbenchPanelLeafForTab,
  makeWorkbenchPanelLayout,
} from "../../../shared/workbench-panel-layout";
import { WorkbenchRuntime } from "./workbench-runtime";
import { type WorkbenchSessionRenderProjection } from "@/lib/workbench-session-presentation";
import { WorkbenchLayoutSnapshotSchema } from "../../../shared/schemas/workbench-layout";
import {
  createWorkbenchSceneSurface,
  ensureWorkbenchSceneLeafToRight,
  makeWorkbenchSceneKey,
  materializeInitialWorkbenchScene,
} from "../../../shared/workbench-scene";
import { makeSessionSceneFixture } from "./workbench-testkit/session-scene-fixture";

type ProjectSession = WorkbenchSessionRenderProjection;

let activeStorySessionsByProject: Record<string, ProjectSession[]> = {};
let activeStorySessionWindowErrorScopeIds: ReadonlySet<string> = new Set();

type ShellStoryArgs = {
  workspace: "projects" | "projectless-only";
  activeTab:
    | "browser"
    | "terminal"
    | "db"
    | "single-db"
    | "page"
    | "welcome"
    | "cross-project-card"
    | "missing-card"
    | "loading-card"
    | "review"
    | "empty";
  thread: "empty" | "attached";
  rightPanel: "regular" | "collapsed" | "full";
  rightPanelGroups: "single" | "split";
  bottomPanel: "collapsed" | "empty" | "terminal";
  sidebar: "expanded" | "collapsed";
  sidebarReveal: "idle" | "edge" | "focus";
  sidebarWidth: 240 | 300 | 520;
  longNames: boolean;
};

const meta = {
  title: "Workbench/Project session shell",
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Codex Electron-style project session shell with fixed global toolbar controls and top-level right and bottom panels.",
      },
    },
  },
  args: {
    workspace: "projects",
    activeTab: "browser",
    thread: "empty",
    rightPanel: "regular",
    rightPanelGroups: "single",
    bottomPanel: "collapsed",
    sidebar: "expanded",
    sidebarReveal: "idle",
    sidebarWidth: 300,
    longNames: false,
  },
  argTypes: {
    workspace: {
      control: "inline-radio",
      options: ["projects", "projectless-only"],
    },
    activeTab: {
      control: "inline-radio",
      options: [
        "browser",
        "terminal",
        "db",
        "single-db",
        "page",
        "welcome",
        "cross-project-card",
        "missing-card",
        "loading-card",
        "review",
        "empty",
      ],
    },
    thread: {
      control: "inline-radio",
      options: ["empty", "attached"],
    },
    rightPanel: {
      control: "inline-radio",
      options: ["regular", "collapsed", "full"],
    },
    rightPanelGroups: {
      control: "inline-radio",
      options: ["single", "split"],
    },
    bottomPanel: {
      control: "inline-radio",
      options: ["collapsed", "empty", "terminal"],
    },
    sidebar: {
      control: "inline-radio",
      options: ["expanded", "collapsed"],
    },
    sidebarReveal: {
      control: "inline-radio",
      options: ["idle", "edge", "focus"],
    },
    sidebarWidth: {
      control: "inline-radio",
      options: [240, 300, 520],
    },
    longNames: {
      control: "boolean",
    },
  },
  render: (args) => <ProjectSessionShellStory {...args} />,
} satisfies Meta<ShellStoryArgs>;

export default meta;

type Story = StoryObj<typeof meta>;

const CREATED_AT = "2026-06-07T00:00:00.000Z";

const PROJECTS: Project[] = [
  {
    id: "nodex",
    libraryId: "library:test",
    databaseId: "database:test:primary",
    defaultDatabaseViewId: "view:test:primary",
    lifecycle: "active",
    bindingRevision: 1,
    name: "Nodex",
    description: "",
    appearance: { color: "black", marker: { kind: "icon", icon: "folder" } },
    sources: [{ root: "/Users/asc/repo/nodex", order: 0 }],
    primaryWorkspaceRoot: "/Users/asc/repo/nodex",
    pinned: false,
    pinnedOrder: null,
    created: new Date(CREATED_AT),
    updated: new Date(CREATED_AT),
  },
  {
    id: "codex-readable",
    libraryId: "library:test",
    databaseId: "database:test:primary",
    defaultDatabaseViewId: "view:test:primary",
    lifecycle: "active",
    bindingRevision: 1,
    name: "Codex readable pack",
    description: "",
    appearance: { color: "blue", marker: { kind: "icon", icon: "terminal" } },
    sources: [{ root: "/Users/asc/repo/devtools-codex", order: 0 }],
    primaryWorkspaceRoot: "/Users/asc/repo/devtools-codex",
    pinned: false,
    pinnedOrder: null,
    created: new Date(CREATED_AT),
    updated: new Date(CREATED_AT),
  },
];

const INITIAL_PROJECT_SOURCE_ROOT = "/Users/alex/Documents/Nodex/My Project";

const INITIAL_PROJECT: Project = {
  ...PROJECTS[0],
  name: INITIAL_PROJECT_NAME,
  sources: [{ root: INITIAL_PROJECT_SOURCE_ROOT, order: 0 }],
  primaryWorkspaceRoot: INITIAL_PROJECT_SOURCE_ROOT,
  pinned: true,
  pinnedOrder: 0,
};

const WELCOME_PAGE_ID = "welcome";
const WELCOME_PAGE = renderInitialProjectWelcomePage({
  sourceRoot: INITIAL_PROJECT_SOURCE_ROOT,
});

const STORY_BOARD: BoardSummary = {
  columns: [
    {
      id: "build",
      name: "In Progress",
      cards: [
        {
          id: "card-1",
          pageKey: "LAB-13",
          status: "build",
          archived: false,
          title: "Workbench redesign",
          richTitle: plainTextToPortableRichText("Workbench redesign"),
          descriptionPreview: "",
          descriptionLength: 0,
          hasDescription: false,
          tags: ["shell"],
          created: new Date(CREATED_AT),
          order: 0,
          revision: 1,
        },
      ],
    },
  ],
};

const WELCOME_BOARD: BoardSummary = {
  columns: [
    {
      id: "triage",
      name: "Triage",
      cards: [
        {
          id: WELCOME_PAGE_ID,
          pageKey: null,
          status: "triage",
          archived: false,
          title: INITIAL_PROJECT_WELCOME_TITLE,
          richTitle: plainTextToPortableRichText(INITIAL_PROJECT_WELCOME_TITLE),
          descriptionPreview: WELCOME_PAGE.nfm.slice(0, 240),
          descriptionLength: WELCOME_PAGE.nfm.length,
          hasDescription: true,
          tags: [],
          created: new Date(CREATED_AT),
          order: 0,
          revision: 1,
        },
      ],
    },
  ],
};

function buildStoryCardDetail(projectId: string, pageId: string): DatabasePage | null {
  if (pageId === WELCOME_PAGE_ID) {
    return {
      id: pageId,
      pageKey: null,
      status: "triage",
      archived: false,
      title: INITIAL_PROJECT_WELCOME_TITLE,
      richTitle: plainTextToPortableRichText(INITIAL_PROJECT_WELCOME_TITLE),
      description: WELCOME_PAGE.nfm,
      tags: [],
      created: new Date(CREATED_AT),
      order: 0,
      revision: 1,
    };
  }
  if (pageId !== "card-1") return null;
  const crossProject = projectId === "codex-readable";

  return {
    id: pageId,
    pageKey: crossProject ? "CRP-1" : "LAB-13",
    status: "build",
    archived: false,
    title: crossProject ? "Readable pack review" : "Workbench redesign",
    richTitle: plainTextToPortableRichText(
      crossProject ? "Readable pack review" : "Workbench redesign",
    ),
    description: crossProject
      ? "Review the readable Codex pack from the current Nodex session."
      : "Tighten the workbench shell while preserving project-scoped panel tabs.",
    tags: crossProject ? ["review"] : ["shell"],
    created: new Date(CREATED_AT),
    order: 0,
    revision: 1,
  };
}

interface StoryOwnedDocument {
  readonly projectId: string;
  readonly ownerBlockId: string;
  readonly document: Y.Doc;
  headSeq: number;
}

const storyDocuments = new Map<string, StoryOwnedDocument>();

function getStoryOwnedDocument(projectId: string, ownerBlockId: string): StoryOwnedDocument {
  const documentId = `storybook:${projectId}:${ownerBlockId}`;
  const existing = storyDocuments.get(documentId);
  if (existing) return existing;

  const page = buildStoryCardDetail(projectId, ownerBlockId);
  const envelope = createPageDocument({
    documentId,
    initialTitle: page?.title ?? "Story Page",
  });
  populateBlockDocumentBodyFromNfm(envelope.body, page?.description ?? "");
  const created = {
    projectId,
    ownerBlockId,
    document: envelope.document,
    headSeq: 0,
  };
  storyDocuments.set(documentId, created);
  return created;
}

function getStoryDocumentDescriptor(owned: StoryOwnedDocument) {
  return {
    projectId: owned.projectId,
    ownerBlockId: owned.ownerBlockId,
    ownerType: "page",
    ownerLifecycle: "active" as const,
    documentId: owned.document.guid,
    storeEpoch: "storybook-store",
    generation: 1,
    headSeq: owned.headSeq,
    schemaKey: "nodex.page",
    schemaVersion: PAGE_DOCUMENT_SCHEMA_VERSION,
    readiness: "ready" as const,
    sync: {
      kind: "yjs" as const,
      stateVector: Y.encodeStateVector(owned.document),
    },
  };
}

function storyUsesWelcomePage(
  sessionsByProject: Readonly<Record<string, readonly ProjectSession[]>>,
): boolean {
  return Object.values(sessionsByProject)
    .flat()
    .some((session) =>
      session.tabs.some(
        (tab) => tab.kind === "page_stage" && tab.config.pageId === WELCOME_PAGE_ID,
      ),
    );
}

type SessionTabFixtureCommon = Pick<WorkbenchTabProjection, "id" | "title"> &
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

type SessionTabFixture<
  Configuration extends WorkbenchProjectionTabConfiguration = WorkbenchProjectionTabConfiguration,
> = Configuration extends { kind: "browser" }
  ? Configuration & SessionTabFixtureCommon & { browserTabId?: string }
  : Configuration & SessionTabFixtureCommon & { browserTabId?: never };

type SessionTabInput = SessionTabFixture | WorkbenchTabProjection;

function makeTab(overrides: SessionTabInput): WorkbenchTabProjection {
  const base = {
    sessionId: "session:overview",
    projectId: "nodex",
    panelId: overrides.kind === "terminal" ? "bottom" : "right",
    order: 0,
    stateKey: 0,
    state: {},
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
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
  if (overrides.kind === "browser") {
    return {
      ...base,
      ...overrides,
      browserTabId: overrides.browserTabId ?? `browser:${overrides.id}`,
    };
  }
  return { ...base, ...overrides, browserTabId: null };
}

function makePanelLayout(tabIds: string[], activeTabId: string | null) {
  return makeWorkbenchPanelLayout(tabIds, activeTabId);
}

function makeSplitPanelLayout(
  tabIds: string[],
  activeTabId: string | null,
): ProjectSession["panels"]["right"]["layout"] {
  const firstTabIds = tabIds.filter((tabId) => tabId !== "tab:browser");
  const secondTabIds: string[] = tabIds.filter((tabId) => tabId === "tab:browser");
  const activeLeafId =
    activeTabId === "tab:browser" && secondTabIds.length > 0 ? "leaf:browser" : "leaf:main";
  return {
    version: 2,
    activeLeafId,
    mruLeafIds: [activeLeafId, activeLeafId === "leaf:main" ? "leaf:browser" : "leaf:main"],
    maximizedLeafId: null,
    root: {
      type: "split",
      id: "split:right-root",
      direction: "horizontal",
      ratio: 0.58,
      first: {
        type: "leaf",
        id: "leaf:main",
        tabIds: firstTabIds,
        activeTabId:
          activeTabId && firstTabIds.includes(activeTabId) ? activeTabId : (firstTabIds[0] ?? null),
        mruTabIds: [
          ...(activeTabId && firstTabIds.includes(activeTabId) ? [activeTabId] : []),
          ...firstTabIds,
        ],
      },
      second: {
        type: "leaf",
        id: "leaf:browser",
        tabIds: secondTabIds,
        activeTabId:
          activeTabId && secondTabIds.includes(activeTabId)
            ? activeTabId
            : (secondTabIds[0] ?? null),
        mruTabIds: [
          ...(activeTabId && secondTabIds.includes(activeTabId) ? [activeTabId] : []),
          ...secondTabIds,
        ],
      },
    },
  };
}

function makePanels(input: {
  rightTabIds?: string[];
  rightActiveTabId?: string | null;
  rightCollapsed?: boolean;
  rightFullWidth?: boolean;
  bottomTabIds?: string[];
  bottomActiveTabId?: string | null;
  bottomCollapsed?: boolean;
}): ProjectSession["panels"] {
  const rightTabIds = input.rightTabIds ?? [];
  const bottomTabIds = input.bottomTabIds ?? [];
  return {
    right: {
      collapsed: input.rightCollapsed ?? false,
      layout: makePanelLayout(rightTabIds, input.rightActiveTabId ?? rightTabIds[0] ?? null),
      size: { widthPx: 600, fullWidth: input.rightFullWidth ?? false },
    },
    bottom: {
      collapsed: input.bottomCollapsed ?? bottomTabIds.length === 0,
      layout: makePanelLayout(bottomTabIds, input.bottomActiveTabId ?? bottomTabIds[0] ?? null),
      size: { heightPx: 280 },
    },
  };
}

function withPanelLayouts(
  session: ProjectSession,
  activeByPanel: Partial<Record<"right" | "bottom", string | null>> = {},
): ProjectSession {
  const rightTabIds = session.tabs.filter((tab) => tab.panelId === "right").map((tab) => tab.id);
  const bottomTabIds = session.tabs.filter((tab) => tab.panelId === "bottom").map((tab) => tab.id);
  return {
    ...session,
    panels: {
      right: {
        ...session.panels.right,
        layout: makePanelLayout(rightTabIds, activeByPanel.right ?? rightTabIds[0] ?? null),
      },
      bottom: {
        ...session.panels.bottom,
        layout: makePanelLayout(bottomTabIds, activeByPanel.bottom ?? bottomTabIds[0] ?? null),
      },
    },
  };
}

function makeSession(args: ShellStoryArgs): ProjectSession {
  if (args.activeTab === "empty") {
    const panels = makePanels({
      rightCollapsed: args.rightPanel === "collapsed",
      rightFullWidth: args.rightPanel === "full",
      bottomCollapsed: args.bottomPanel !== "empty",
    });
    const title = "Database View";
    return {
      id: "session:database-view",
      projectId: "nodex",
      noThreadFallbackTitle: title,
      displayTitle: title,
      order: 0,
      pinned: true,
      pinnedOrder: 0,
      archived: false,
      archivedAt: null,
      unread: false,
      panels,
      thread: null,
      tabs: [],
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    };
  }

  if (args.activeTab === "welcome") {
    const tabs = [
      makeTab({
        id: "tab:db",
        kind: "db_view",
        title: "Database",
        order: 0,
        config: {
          projectId: "nodex",
          databaseViewId: "database-view:nodex:primary-board",
        },
      }),
      makeTab({
        id: "tab:welcome",
        kind: "page_stage",
        title: INITIAL_PROJECT_WELCOME_TITLE,
        order: 1,
        config: {
          projectId: "nodex",
          pageId: WELCOME_PAGE_ID,
          titleSnapshot: INITIAL_PROJECT_WELCOME_TITLE,
        },
      }),
    ];
    return {
      id: "session:database-view",
      projectId: "nodex",
      noThreadFallbackTitle: "Database View",
      displayTitle: "Database View",
      order: 0,
      pinned: true,
      pinnedOrder: 0,
      archived: false,
      archivedAt: null,
      unread: false,
      panels: makePanels({
        rightTabIds: tabs.map((tab) => tab.id),
        rightActiveTabId: "tab:welcome",
        rightFullWidth: true,
        bottomCollapsed: true,
      }),
      thread: null,
      tabs,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    };
  }

  const cardProjectId = args.activeTab === "cross-project-card" ? "codex-readable" : "nodex";
  const pageTitle =
    args.activeTab === "cross-project-card"
      ? "Readable pack review"
      : args.activeTab === "missing-card"
        ? "Missing project card"
        : args.activeTab === "loading-card"
          ? "Loading project card"
          : args.longNames
            ? "Rewrite the project-session workbench shell while preserving card thread links"
            : "Workbench redesign";
  const baseTabs = [
    makeTab({
      id: "tab:db",
      kind: "db_view",
      title: "DB View",
      order: 0,
      config: {
        projectId: "nodex",
        databaseViewId: "database-view:nodex:primary-board",
      },
    }),
    makeTab({
      id: "tab:card",
      kind: "page_stage",
      title: pageTitle,
      order: 1,
      config: {
        projectId: cardProjectId,
        pageId:
          args.activeTab === "missing-card"
            ? "missing-card"
            : args.activeTab === "loading-card"
              ? "loading-card"
              : "card-1",
        titleSnapshot: pageTitle,
      },
    }),
    makeTab({
      id: "tab:terminal",
      kind: "terminal",
      title: "Terminal",
      order: 2,
      config: { terminalSessionId: "story-terminal" },
    }),
    makeTab({
      id: "tab:browser",
      kind: "browser",
      title: "Browser",
      order: 3,
      config: { projectId: "nodex", title: "Browser" },
    }),
  ];
  const tabs =
    args.activeTab === "single-db"
      ? baseTabs.filter((tab) => tab.id === "tab:db")
      : args.activeTab === "review"
        ? [
            ...baseTabs,
            makeTab({
              id: "tab:review",
              kind: "review",
              title: "Review",
              order: 4,
              config: { projectId: "nodex" },
            }),
          ]
        : baseTabs;
  const activeTabId = (() => {
    if (args.activeTab === "db" || args.activeTab === "single-db") return "tab:db";
    if (
      args.activeTab === "page" ||
      args.activeTab === "cross-project-card" ||
      args.activeTab === "missing-card" ||
      args.activeTab === "loading-card"
    ) {
      return "tab:card";
    }
    if (args.activeTab === "terminal") return "tab:terminal";
    if (args.activeTab === "review") return "tab:review";
    return "tab:browser";
  })();
  const rightTabIds = tabs.filter((tab) => tab.panelId === "right").map((tab) => tab.id);
  const bottomTabIds = tabs.filter((tab) => tab.panelId === "bottom").map((tab) => tab.id);
  const panels = makePanels({
    rightTabIds,
    rightActiveTabId: rightTabIds.includes(activeTabId) ? activeTabId : (rightTabIds[0] ?? null),
    rightCollapsed: args.rightPanel === "collapsed",
    rightFullWidth: args.rightPanel === "full",
    bottomTabIds,
    bottomActiveTabId: bottomTabIds.includes(activeTabId) ? activeTabId : (bottomTabIds[0] ?? null),
    bottomCollapsed:
      args.bottomPanel === "empty"
        ? false
        : args.activeTab !== "terminal" && args.bottomPanel !== "terminal",
  });
  if (args.rightPanelGroups === "split" && rightTabIds.length > 1) {
    panels.right = {
      ...panels.right,
      layout: makeSplitPanelLayout(
        rightTabIds,
        rightTabIds.includes(activeTabId) ? activeTabId : (rightTabIds[0] ?? null),
      ),
    };
  }

  const thread: ProjectSessionThreadLink | null =
    args.thread === "attached"
      ? {
          sessionId: "session:database-view",
          projectId: "nodex",
          threadId: "thread-story",
          parentThreadId: undefined,
          threadName: "Codex shell parity",
          threadPreview: "Reviewing shell layout and tab persistence",
          backendBinding: { kind: "codex" },
          executionHostId: "local",
          cwd: "/Users/asc/repo/nodex",
          statusType: "notLoaded",
          statusActiveFlags: [],
          archived: false,
          createdAt: 1_780_800_000_000,
          updatedAt: 1_780_800_000_000,
          linkedAt: CREATED_AT,
        }
      : null;
  const title = args.longNames
    ? "Database View and implementation notes for a project session shell"
    : "Database View";

  return {
    id: "session:database-view",
    projectId: "nodex",
    noThreadFallbackTitle: title,
    displayTitle: thread?.threadName ?? title,
    order: 0,
    pinned: true,
    pinnedOrder: 0,
    archived: false,
    archivedAt: null,
    unread: false,
    panels,
    thread,
    tabs,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function makeSecondarySession(args: ShellStoryArgs): ProjectSession {
  const tabs = [
    makeTab({
      id: "tab:release-terminal",
      sessionId: "session:release",
      kind: "terminal",
      title: "Release terminal",
      order: 0,
      config: { terminalSessionId: "release-terminal" },
    }),
    makeTab({
      id: "tab:release-browser",
      sessionId: "session:release",
      kind: "browser",
      title: "Browser",
      order: 1,
      config: { projectId: "nodex", title: "Browser" },
    }),
  ];
  const rightTabIds = tabs.filter((tab) => tab.panelId === "right").map((tab) => tab.id);
  const bottomTabIds = tabs.filter((tab) => tab.panelId === "bottom").map((tab) => tab.id);
  return {
    ...makeSession({ ...args, activeTab: "terminal", thread: "empty" }),
    id: "session:release",
    noThreadFallbackTitle: args.longNames
      ? "Release validation and follow-up terminal work"
      : "Release run",
    displayTitle: args.longNames ? "Release validation and follow-up terminal work" : "Release run",
    order: 1,
    tabs,
    panels: makePanels({
      rightTabIds,
      rightActiveTabId: rightTabIds[0] ?? null,
      rightCollapsed: args.rightPanel === "collapsed",
      rightFullWidth: args.rightPanel === "full",
      bottomTabIds,
      bottomActiveTabId: "tab:release-terminal",
      bottomCollapsed: false,
    }),
  };
}

function makeAttachedProjectlessSession(args: ShellStoryArgs): ProjectSession {
  const base = makeSession({
    ...args,
    activeTab: "browser",
    thread: "attached",
    rightPanel: "regular",
  });
  return {
    ...base,
    id: "session:projectless-attached",
    projectId: null,
    noThreadFallbackTitle: "Projectless chat tools",
    displayTitle: "Projectless chat tools",
    thread: base.thread
      ? {
          ...base.thread,
          sessionId: "session:projectless-attached",
          projectId: null,
          threadId: "thread-projectless-attached",
          threadName: "Projectless chat tools",
          cwd: "/Users/asc/repo/scratch",
        }
      : null,
    tabs: [],
    panels: makePanels({
      rightTabIds: [],
      rightActiveTabId: null,
      rightCollapsed: false,
      rightFullWidth: false,
      bottomTabIds: [],
      bottomActiveTabId: null,
      bottomCollapsed: true,
    }),
  };
}

function ProjectSessionShellStory(args: ShellStoryArgs) {
  const initialSessionsByProject = useMemo<Record<string, ProjectSession[]>>(() => {
    if (args.workspace === "projectless-only") {
      const session =
        args.thread === "attached"
          ? makeAttachedProjectlessSession(args)
          : {
              ...makeSession({ ...args, activeTab: "empty", thread: "empty" }),
              id: "session:projectless:blank",
              projectId: null,
              noThreadFallbackTitle: "New chat",
              displayTitle: "New chat",
            };
      return { __projectless__: [session] } as Record<string, ProjectSession[]>;
    }
    return {
      nodex:
        args.activeTab === "welcome"
          ? [makeSession(args)]
          : [makeSession(args), makeSecondarySession(args)],
      "codex-readable": [
        withPanelLayouts(
          {
            ...makeSession({ ...args, activeTab: "browser", thread: "empty" }),
            id: "session:codex-database-view",
            projectId: "codex-readable",
            noThreadFallbackTitle: "Database View",
            displayTitle: "Database View",
            tabs: [
              makeTab({
                id: "tab:codex-browser",
                sessionId: "session:codex-database-view",
                projectId: "codex-readable",
                kind: "browser",
                title: "Browser",
                config: { projectId: "codex-readable", title: "Browser" },
              }),
            ],
          },
          { right: "tab:codex-browser" },
        ),
      ],
    } as Record<string, ProjectSession[]>;
  }, [args]);
  const [sessionsByProject] = useState(initialSessionsByProject);
  const sessionScenesByOwnerKey = Object.fromEntries(
    Object.values(initialSessionsByProject)
      .flat()
      .map((session) => [
        makeWorkbenchSceneKey({ kind: "session", sessionId: session.id }),
        makeSessionSceneFixture(session),
      ]),
  );
  const [initialWindowLayoutSnapshot] = useState(() => {
    const activeSession =
      args.workspace === "projectless-only"
        ? (initialSessionsByProject.__projectless__?.[0] ?? null)
        : (initialSessionsByProject.nodex?.[0] ?? null);
    return WorkbenchLayoutSnapshotSchema.parse({
      version: 6 as const,
      location: activeSession
        ? {
            kind: "session" as const,
            projectContextId: args.workspace === "projectless-only" ? null : "nodex",
            sessionId: activeSession.id,
          }
        : args.workspace === "projectless-only"
          ? { kind: "empty" as const }
          : { kind: "project" as const, projectId: "nodex" },
      databaseSearchByProject:
        args.workspace === "projectless-only" ? ({} as Record<string, string>) : { nodex: "" },
      scenesByOwnerKey: sessionScenesByOwnerKey,
    });
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(args.sidebar === "collapsed");
  const [sidebarWidth, setSidebarWidth] = useState<number>(args.sidebarWidth);
  const [sidebarCollapsibleSections, setSidebarCollapsibleSections] = useState({
    pinned: false,
    pages: false,
    projects: false,
    chats: false,
  });

  useLayoutEffect(() => {
    activeStorySessionsByProject = sessionsByProject;
    return () => {
      if (activeStorySessionsByProject !== sessionsByProject) return;
      activeStorySessionsByProject = {};
    };
  }, [sessionsByProject]);

  useEffect(() => {
    setSidebarCollapsed(args.sidebar === "collapsed");
    setSidebarWidth(args.sidebarWidth);
  }, [args.sidebar, args.sidebarWidth]);

  useEffect(() => {
    if (args.rightPanel === "collapsed") return undefined;
    const timeout = window.setTimeout(() => {
      const label = args.rightPanel === "regular" ? "Restore panel width" : "Expand panel";
      document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.click();
    }, 0);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [args.rightPanel, sessionsByProject]);

  useEffect(() => {
    if (args.sidebar !== "collapsed" || args.sidebarReveal === "idle") return undefined;
    let focusTimeout: number | null = null;
    const timeout = window.setTimeout(() => {
      if (args.sidebarReveal === "edge") {
        window.dispatchEvent(
          new MouseEvent("pointermove", {
            clientX: 12,
            clientY: 120,
          }),
        );
        return;
      }

      window.dispatchEvent(
        new MouseEvent("pointermove", {
          clientX: 12,
          clientY: 120,
        }),
      );
      focusTimeout = window.setTimeout(() => {
        const focusTarget = document.querySelector<HTMLElement>(
          '[data-sidebar-floating-focus-area="true"] button',
        );
        focusTarget?.focus();
        window.dispatchEvent(
          new MouseEvent("pointermove", {
            clientX: args.sidebarWidth + 24,
            clientY: 120,
          }),
        );
      }, 0);
    }, 0);
    return () => {
      window.clearTimeout(timeout);
      if (focusTimeout !== null) window.clearTimeout(focusTimeout);
    };
  }, [args.sidebar, args.sidebarReveal, args.sidebarWidth, sessionsByProject]);

  return (
    <div className="h-screen">
      <WorkbenchRuntime
        windowSessionId="window-session:storybook"
        initialWindowLayoutSnapshot={initialWindowLayoutSnapshot}
        projects={
          args.workspace === "projectless-only"
            ? []
            : args.activeTab === "welcome"
              ? [INITIAL_PROJECT]
              : PROJECTS
        }
        sidebar={{
          collapsed: sidebarCollapsed,
          width: sidebarWidth,
          collapsibleSections: sidebarCollapsibleSections,
        }}
        setSidebarCollapsed={setSidebarCollapsed}
        setSidebarWidth={setSidebarWidth}
        setSidebarCollapsibleSectionCollapsed={(sectionId, collapsed) => {
          setSidebarCollapsibleSections((current) => ({
            ...current,
            [sectionId]: collapsed,
          }));
        }}
        pageStageCloseRef={{ current: null }}
        openPageStage={() => undefined}
        onLeavePageStage={() => undefined}
        onCreateProject={async () => null}
        onUpdateProject={async () => null}
        onArchiveProject={async () => ({ kind: "not-found" })}
        onReorderProjects={async () => undefined}
        onSetProjectPinned={async () => null}
        onSetPinnedProjectOrder={async () => undefined}
        onRequestProjectPickerOpen={() => undefined}
        threadSearchOpenTick={0}
      />
    </div>
  );
}

function ProjectSceneStory({
  boundTask,
  dockHidden = false,
  secondaryDatabase = false,
  splitPage = false,
  welcome = false,
  sessionWindowError = false,
}: {
  boundTask: boolean;
  dockHidden?: boolean;
  secondaryDatabase?: boolean;
  splitPage?: boolean;
  welcome?: boolean;
  sessionWindowError?: boolean;
}) {
  const [sessionsByProject] = useState<Record<string, ProjectSession[]>>(() => {
    if (!boundTask) return { nodex: [], "codex-readable": [] };
    const session = {
      ...makeSession({
        ...(meta.args as ShellStoryArgs),
        activeTab: "empty",
        thread: "attached",
      }),
      id: "session:project-scene-conversation",
      noThreadFallbackTitle: "Discuss the board",
      displayTitle: "Discuss the board",
      pinned: false,
      pinnedOrder: null,
    };
    return { nodex: [session], "codex-readable": [] };
  });
  const [initialWindowLayoutSnapshot] = useState(() => {
    const owner = { kind: "project" as const, projectId: "nodex" };
    const initial = materializeInitialWorkbenchScene(owner);
    const withSecondaryDatabase = secondaryDatabase
      ? createWorkbenchSceneSurface(initial, {
          panelId: "right",
          surface: {
            id: "surface:secondary-database",
            kind: "db_view",
            titleSnapshot: "Database",
            config: {
              accessContext: {
                kind: "project",
                projectId: "codex-readable",
              },
              target: {
                kind: "database-view",
                databaseViewId: "view:test:primary",
              },
            },
            stateKey: 0,
            state: null,
          },
        })
      : initial;
    const withWelcome = welcome
      ? createWorkbenchSceneSurface(withSecondaryDatabase, {
          panelId: "right",
          surface: {
            id: "surface:welcome",
            kind: "page_stage",
            titleSnapshot: INITIAL_PROJECT_WELCOME_TITLE,
            config: {
              accessContext: { kind: "project", projectId: "nodex" },
              pageId: WELCOME_PAGE_ID,
              titleSnapshot: INITIAL_PROJECT_WELCOME_TITLE,
            },
            stateKey: 0,
            state: null,
          },
        })
      : withSecondaryDatabase;
    const withSplitPage = splitPage
      ? (() => {
          const sourceLeaf = findWorkbenchPanelLeafForTab(
            withWelcome.panels.right.layout,
            withWelcome.primary?.id ?? "",
          );
          if (!sourceLeaf) return withWelcome;
          const target = ensureWorkbenchSceneLeafToRight(withWelcome, {
            panelId: "right",
            leafId: sourceLeaf.id,
          });
          return createWorkbenchSceneSurface(target.scene, {
            panelId: "right",
            targetLeafId: target.leafId,
            surface: {
              id: "surface:page-from-project-home",
              kind: "page_stage",
              titleSnapshot: "Workbench redesign",
              config: {
                accessContext: { kind: "project", projectId: "nodex" },
                pageId: "card-1",
                titleSnapshot: "Workbench redesign",
              },
              stateKey: 0,
              state: null,
            },
          });
        })()
      : withWelcome;
    const session = sessionsByProject.nodex?.[0] ?? null;
    const scene = withSplitPage.agentDock
      ? {
          ...withSplitPage,
          composerOverlay: { visible: !dockHidden },
          agentDock: {
            ...withSplitPage.agentDock,
            binding: session
              ? { kind: "session" as const, sessionId: session.id }
              : { kind: "new" as const },
          },
        }
      : withSplitPage;
    return WorkbenchLayoutSnapshotSchema.parse({
      version: 6,
      location: { kind: "project", projectId: "nodex" },
      databaseSearchByProject: { nodex: "" },
      scenesByOwnerKey: {
        [makeWorkbenchSceneKey(owner)]: scene,
      },
    });
  });

  useLayoutEffect(() => {
    activeStorySessionsByProject = sessionsByProject;
    activeStorySessionWindowErrorScopeIds = sessionWindowError ? new Set(["nodex"]) : new Set();
    return () => {
      if (activeStorySessionsByProject === sessionsByProject) {
        activeStorySessionsByProject = {};
      }
      activeStorySessionWindowErrorScopeIds = new Set();
    };
  }, [sessionWindowError, sessionsByProject]);

  return (
    <div className="h-screen">
      <WorkbenchRuntime
        windowSessionId="window-session:storybook-project-scene"
        initialWindowLayoutSnapshot={initialWindowLayoutSnapshot}
        projects={welcome ? [INITIAL_PROJECT] : PROJECTS}
        sidebar={{ collapsed: false, width: 300 }}
        pageStageCloseRef={{ current: null }}
        openPageStage={() => undefined}
        onLeavePageStage={() => undefined}
        onCreateProject={async () => null}
        onUpdateProject={async () => null}
        onArchiveProject={async () => ({ kind: "not-found" })}
        onReorderProjects={async () => undefined}
        onSetProjectPinned={async () => null}
        onSetPinnedProjectOrder={async () => undefined}
        onRequestProjectPickerOpen={() => undefined}
        threadSearchOpenTick={0}
      />
    </div>
  );
}

function installReducedMotionMatchMedia() {
  if (typeof window === "undefined") return null;
  const originalMatchMedia = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });

  return () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
  };
}

function ReducedMotionProjectSessionShellStory(args: ShellStoryArgs) {
  const [restoreMatchMedia] = useState(installReducedMotionMatchMedia);

  useEffect(
    () => () => {
      restoreMatchMedia?.();
    },
    [restoreMatchMedia],
  );

  return <ProjectSessionShellStory {...args} />;
}

function ScheduledRouteProjectSessionShellStory(args: ShellStoryArgs) {
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      document.querySelector<HTMLButtonElement>('[aria-label="Scheduled"]')?.click();
    }, 0);
    return () => {
      window.clearTimeout(timeout);
    };
  }, []);

  return <ProjectSessionShellStory {...args} />;
}

function buildStorySideChatStartResult(
  input: CodexSideChatStartInput,
  sessionsByProject: Record<string, ProjectSession[]>,
): CodexSideChatStartResult {
  const parentSession =
    Object.values(sessionsByProject)
      .flat()
      .find((session) => session.thread?.threadId === input.parentThreadId) ?? null;
  const threadId = `thread-story-side-chat:${input.parentThreadId}`;
  const now = Date.now();

  return {
    parentThreadId: input.parentThreadId,
    threadId,
    conversation: {
      threadId,
      projectId: parentSession?.projectId ?? null,
      forkedFromId: input.parentThreadId,
      source: {
        parentThreadId: input.parentThreadId,
        sideConversation: true,
        sideConversationParentNavigationPath: input.parentNavigationPath ?? null,
      },
      ephemeral: true,
      threadName: "Side chat",
      threadPreview: "",
      modelProvider: "openai",
      cwd: parentSession?.thread?.cwd ?? null,
      projectlessOutputDirectory: null,
      projectlessWorkspaceBrowserRoot: null,
      statusType: "notLoaded",
      statusActiveFlags: [],
      archived: false,
      createdAt: now,
      updatedAt: now,
      linkedAt: CREATED_AT,
      resumeState: "resumed",
      turns: [],
      requests: [],
      queuedFollowUps: {
        status: "ready",
        ledgerRevision: 0,
        projectionRevision: 0,
        entries: [],
        inFlightFollowUpId: null,
        editingFollowUpId: null,
        error: null,
      },
      pendingSteers: [],
      backgroundTerminalRows: [],
      capabilityFlags: {
        canEditLastUserTurn: false,
        canForkFromTurn: false,
        canSearch: true,
        canCollapseTurns: true,
      },
    },
  };
}

function installStoryApi(readSessionsByProject: () => Record<string, ProjectSession[]>) {
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      invoke: async (channel: string, ...args: unknown[]) => {
        if (channel === "projects:get") {
          return PROJECTS.find((project) => project.id === String(args[0])) ?? null;
        }
        if (channel === "project-sessions:get") {
          return (
            Object.values(readSessionsByProject())
              .flat()
              .find((session) => session.id === String(args[0])) ?? null
          );
        }
        if (channel === "workspace:tasks:list") {
          const scopeKey = args[0] === null ? "__projectless__" : String(args[0]);
          if (activeStorySessionWindowErrorScopeIds.has(scopeKey)) {
            throw new Error("Couldn’t load chats for this Project");
          }
          return {
            items: readSessionsByProject()[scopeKey] ?? [],
            nextCursor: null,
            hasMore: false,
            projectionRevision: 1,
          };
        }
        if (channel === "codex:thread:side-chat:start") {
          return buildStorySideChatStartResult(
            args[0] as CodexSideChatStartInput,
            readSessionsByProject(),
          );
        }
        if (channel === "codex:thread:side-chat:discard") {
          return true;
        }
        if (channel === "project-sessions:list" || channel === "project-sessions:list-summaries") {
          const scopeKey = args[0] === null ? "__projectless__" : String(args[0]);
          return readSessionsByProject()[scopeKey] ?? [];
        }
        if (channel === "database:view-window:get") {
          const projectId = String(args[0] ?? "nodex");
          const board = storyUsesWelcomePage(readSessionsByProject()) ? WELCOME_BOARD : STORY_BOARD;
          const viewId = `database-view:${projectId}:primary-board`;
          const databaseId = `database:${projectId}:primary`;
          const dataSourceId = `${databaseId}:data-source:initial`;
          // Core-backed channels return a CoreResult envelope.
          return {
            ok: true,
            value: {
              projectId,
              libraryId: "library:test",
              databaseId,
              dataSourceId,
              viewId,
              storeEpoch: "epoch:story",
              commitSeq: 1,
              projectionRevision: 1,
              nextCursor: null,
              rows: board.columns.flatMap((column) =>
                column.cards.map((page, index) => ({
                  page,
                  groupKey: column.id,
                  rankKey: String(index).padStart(8, "0"),
                })),
              ),
              board,
              view: {
                id: viewId,
                databaseBlockId: databaseId,
                projectId,
                name: "Tasks",
                layout: "board",
                config: {},
                isPrimary: true,
                createdAt: CREATED_AT,
                updatedAt: CREATED_AT,
              },
              query: {
                database: {
                  databaseId,
                  libraryId: "library:test",
                  name: "Tasks",
                  lifecycle: "active",
                  defaultViewId: viewId,
                  accessRevision: 1,
                  metadataRevision: 1,
                  createdAt: CREATED_AT,
                  updatedAt: CREATED_AT,
                },
                dataSource: {
                  dataSourceId,
                  libraryId: "library:test",
                  homeDatabaseId: databaseId,
                  name: "Pages",
                  schemaKey: "nodex.page",
                  schemaRevision: 1,
                  lifecycle: "active",
                  rankKey: "a",
                  createdAt: CREATED_AT,
                  updatedAt: CREATED_AT,
                },
                view: {
                  viewId,
                  databaseId,
                  dataSourceId,
                  name: "Tasks",
                  layout: "board",
                  config: {
                    schemaKey: "nodex.database-view",
                    schemaVersion: 2,
                    filter: { kind: "group", operator: "and", children: [] },
                    sort: [],
                    group: null,
                    display: { propertyIds: [], showTitle: true },
                  },
                  isDefault: true,
                  revision: 1,
                  rankKey: "a",
                  lifecycle: "active",
                  createdAt: CREATED_AT,
                  updatedAt: CREATED_AT,
                },
                properties: [],
                rows: [],
              },
            },
          };
        }
        if (channel === "database:view-groups:get") {
          const projectId = String(args[0] ?? "nodex");
          const board = storyUsesWelcomePage(readSessionsByProject()) ? WELCOME_BOARD : STORY_BOARD;
          const databaseId = `database:${projectId}:primary`;
          return {
            ok: true,
            value: {
              projectId,
              libraryId: "library:test",
              databaseId,
              dataSourceId: `${databaseId}:data-source:initial`,
              viewId: `database-view:${projectId}:primary-board`,
              storeEpoch: "epoch:story",
              commitSeq: 1,
              grouped: true,
              totalRows: board.columns.reduce((total, column) => total + column.cards.length, 0),
              truncated: false,
              groups: board.columns.map((column) => ({
                groupKey: column.id,
                totalRows: column.cards.length,
              })),
            },
          };
        }
        if (channel === "library-module:read") {
          const read = (args[0] as LibraryModuleReadRequest).read;
          const value: LibraryReadValue = (() => {
            if (read.mode === "metadata") return { kind: "metadata" };
            if (read.mode === "canvas_target") {
              return {
                kind: "canvas_target",
                value: { status: "missing", canvasId: read.canvasId },
              };
            }
            if (read.mode === "resource_project_access") {
              return {
                kind: "resource_project_access",
                value: { target: read.target, projects: [] },
              };
            }
            if (read.mode === "path") {
              return { kind: "path", target: read.target, nodes: [] };
            }
            if (read.mode === "catalog") {
              return { kind: "catalog", items: [], nextCursor: null, hasMore: false, total: 0 };
            }
            if (read.mode === "standalone_roots") {
              return {
                kind: "standalone_roots",
                items: [],
                nextCursor: null,
                hasMore: false,
                total: 0,
              };
            }
            if (read.mode === "move_destinations") {
              return {
                kind: "move_destinations",
                target: read.target,
                scope: read.scope,
                items: [],
                currentDestination: null,
                nextCursor: null,
                hasMore: false,
                total: 0,
                rootIsCurrent: false,
              };
            }
            if (read.mode === "page_reference_candidates") {
              return { kind: "page_reference_candidates", items: [] };
            }
            if (read.mode === "page_backlinks") {
              return {
                kind: "page_backlinks",
                targetPageId: read.targetPageId,
                items: [],
                nextCursor: null,
                hasMore: false,
                total: 0,
                sourcePageCount: 0,
              };
            }
            if (read.mode === "page_mention_destination") {
              return {
                kind: "page_mention_destination",
                value: {
                  pageId: read.pageId,
                  documentId: `document:${read.pageId}`,
                  documentGeneration: 1,
                  documentHeadSeq: 0,
                },
              };
            }
            if (read.mode !== "children") {
              return { kind: "metadata" };
            }
            return {
              kind: "children",
              parent: read.parent,
              items: [],
              nextCursor: null,
              hasMore: false,
              total: 0,
            };
          })();
          return {
            ok: true,
            value: {
              version: 1,
              profileId: "profile:story",
              libraryId: "library:test",
              storeEpoch: "epoch:story",
              commitSeq: 0,
              value,
            },
          };
        }
        if (channel === "codex:scheduled-automations:list") {
          return { items: [] };
        }
        if (channel === "codex:automation-runs:inbox-items") {
          return { items: [] };
        }
        if (channel === "pages:detail:get") {
          const projectId = String(args[0] ?? "nodex");
          const pageId = String(args[1] ?? "");
          if (pageId === "loading-card") {
            return new Promise<never>(() => {});
          }
          return buildPageDetailStoryResult(projectId, buildStoryCardDetail(projectId, pageId));
        }
        if (channel === "block-document:owned:get") {
          return getStoryDocumentDescriptor(
            getStoryOwnedDocument(String(args[0]), String(args[1])),
          );
        }
        if (channel === "block-document:owned:prepare") {
          return {
            ok: true,
            value: getStoryDocumentDescriptor(
              getStoryOwnedDocument(String(args[0]), String(args[1])),
            ),
          };
        }
        if (channel === "document-sync:subscribe") {
          return { ok: true, value: { subscribed: true } };
        }
        if (channel === "document-sync:unsubscribe") {
          return { ok: true, value: { unsubscribed: true } };
        }
        if (channel === "document-sync:sync") {
          const request = args[0] as {
            documentId: string;
            stateVector: Uint8Array;
          };
          const owned = storyDocuments.get(request.documentId);
          if (!owned) {
            return {
              ok: false,
              error: {
                code: "document_not_found",
                message: "Story document was not found",
                retryable: false,
                resetRequired: false,
              },
            };
          }
          return {
            ok: true,
            value: {
              documentId: request.documentId,
              storeEpoch: "storybook-store",
              generation: 1,
              headSeq: owned.headSeq,
              stateVector: Y.encodeStateVector(owned.document),
              update: Y.encodeStateAsUpdate(owned.document, request.stateVector),
            },
          };
        }
        if (channel === "document-sync:apply") {
          const request = args[0] as {
            documentId: string;
            updateId: string;
            update: Uint8Array;
          };
          const owned = storyDocuments.get(request.documentId);
          if (!owned) {
            return {
              ok: false,
              error: {
                code: "document_not_found",
                message: "Story document was not found",
                retryable: false,
                resetRequired: false,
              },
            };
          }
          Y.applyUpdate(owned.document, request.update);
          owned.headSeq += 1;
          return {
            ok: true,
            value: {
              documentId: request.documentId,
              storeEpoch: "storybook-store",
              generation: 1,
              updateId: request.updateId,
              committedSeq: owned.headSeq,
              headSeq: owned.headSeq,
              stateVector: Y.encodeStateVector(owned.document),
              duplicate: false,
            },
          };
        }
        if (channel === "document-sync:awareness:publish") {
          return { ok: true, value: { accepted: true } };
        }
        if (
          channel === "project-session-threads:attach" ||
          channel === "project-session-threads:detach"
        ) {
          return true;
        }
        return null;
      },
      on: () => () => undefined,
      awaitInitialization: async () => undefined,
      onInitializationStep: () => () => undefined,
      reportInitializationReady: () => undefined,
      readPasteClipboard: async () => ({}),
      getPathInfoForFile: () => null,
      getPathForFile: () => "",
    } satisfies NonNullable<Window["api"]>,
  });
}

if (typeof window !== "undefined") {
  installStoryApi(() => activeStorySessionsByProject);
}

function selectStorySession(label: string): void {
  const candidate = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent?.includes(label),
  );
  candidate?.click();
}

function LiveSessionTransitionStory(args: ShellStoryArgs) {
  return (
    <>
      <div className="fixed right-4 top-14 z-[100] flex gap-2 rounded-lg border border-token-border bg-token-main-surface-primary p-2 shadow-lg">
        <button
          type="button"
          className="rounded-md bg-token-foreground/8 px-3 py-1.5 text-xs"
          onClick={() => selectStorySession("Database View")}
        >
          Select Database View
        </button>
        <button
          type="button"
          className="rounded-md bg-token-foreground/8 px-3 py-1.5 text-xs"
          onClick={() => selectStorySession("Release run")}
        >
          Select Release run
        </button>
      </div>
      <ProjectSessionShellStory {...args} />
    </>
  );
}

export const MixedRightTabs: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Regular 600px right panel with registry-backed global bottom/side panel toggles in the fixed toolbar, expand/restore in the panel tab header, and no empty toolbar row above the thread title.",
      },
    },
  },
};

export const ProjectSceneWithSecondaryDatabase: Story = {
  render: () => <ProjectSceneStory boundTask={false} secondaryDatabase />,
  parameters: {
    docs: {
      description: {
        story:
          "Only the protected root uses Project Home chrome. Another Database surface in the same Project Scene retains the standard table icon and DB View label used by Session tabs.",
      },
    },
  },
};

export const ProjectSceneDatabasePageGroup: Story = {
  render: () => <ProjectSceneStory boundTask={false} splitPage />,
  parameters: {
    docs: {
      description: {
        story:
          "Opening a Page from the full-width Project Home Database creates one adjacent right tab group. Further Pages from that Database reuse the right group instead of displacing Project Home or creating additional splits.",
      },
    },
  },
};

export const ProjectSceneSessionLoadError: Story = {
  render: () => <ProjectSceneStory boundTask={false} sessionWindowError />,
  parameters: {
    docs: {
      description: {
        story:
          "A Project Scene whose Session window failed its first hydration. The Project remains usable and the expanded folder shows one compact, scope-local Retry chats action instead of a fake empty state.",
      },
    },
  },
};

export const ProjectSceneWithBoundTask: Story = {
  render: () => <ProjectSceneStory boundTask />,
  parameters: {
    docs: {
      description: {
        story:
          "The Database remains the root surface while the footer-only Agent Dock subscribes to a real running chat. Use Find a chat to alternate between the bound chat and New chat: one stable context rail projects either the connected latest turn or the mutable new-chat run context without vertical motion. Open chat is the explicit path to the full transcript.",
      },
    },
  },
};

export const ProjectSceneDockHidden: Story = {
  render: () => <ProjectSceneStory boundTask dockHidden />,
  parameters: {
    docs: {
      description: {
        story:
          "A running task stays bound while its controlled Agent Dock is hidden. The Database receives the released space and the restore handle carries activity attention; its grip stays geometrically centered between the independent leading and trailing controls.",
      },
    },
  },
};

export const InitialProjectWelcome: Story = {
  render: () => <ProjectSceneStory boundTask={false} welcome />,
  args: {
    activeTab: "welcome",
    thread: "empty",
    rightPanel: "full",
    rightPanelGroups: "single",
    bottomPanel: "collapsed",
    sidebar: "expanded",
    sidebarWidth: 300,
  },
  parameters: {
    docs: {
      description: {
        story:
          "A fresh Profile after automatic bootstrap: My Project opens as one full-width Scene, with the Welcome Page as an ordinary tab, the marker/Project Home tab retained as the protected Database root, and New chat available in the Agent Dock without creating a starter chat.",
      },
    },
  },
};

export const LiveSessionStatePreservation: Story = {
  render: (args) => <LiveSessionTransitionStory {...args} />,
  args: {
    thread: "attached",
    rightPanel: "regular",
    bottomPanel: "terminal",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Switches between two live Session projections without remounting the Workbench runtime, so panel selection, Terminal state, and composer ownership can be inspected across the transition.",
      },
    },
  },
};

export const SingleClosableRightPanelTab: Story = {
  args: {
    activeTab: "single-db",
    rightPanel: "regular",
    bottomPanel: "collapsed",
  },
  parameters: {
    docs: {
      description: {
        story:
          "A sole durable right-panel tab remains closable: hover or focus the tab to reveal its close action.",
      },
    },
  },
};

export const CardRightPanelCollapseAnchor: Story = {
  args: {
    activeTab: "page",
    thread: "attached",
    rightPanel: "regular",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Interactive resize acceptance scene: drag the right-panel sash past its collapse threshold, reopen it, then resize it narrower. The full Page Detail canvas follows the sash with no retained minimum width, while trailing toolbar actions stay anchored to the viewport-right edge.",
      },
    },
  },
};

export const EmptyRightPanelActions: Story = {
  args: {
    activeTab: "empty",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Empty right panel showing the Codex-style new-tab action grid with Database View and Page actions appended.",
      },
    },
  },
};

export const AttachedProjectlessChatTools: Story = {
  args: {
    workspace: "projectless-only",
    activeTab: "empty",
    thread: "attached",
    rightPanel: "regular",
    bottomPanel: "collapsed",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Attached projectless chat with a workspace cwd. The empty side panel exposes Side chat, Browser, and Terminal in conversation-native order.",
      },
    },
  },
};

export const EmptyBottomPanelActions: Story = {
  args: {
    activeTab: "empty",
    rightPanel: "collapsed",
    bottomPanel: "empty",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Open empty bottom panel showing the Codex-eligible Files, Side chat, Browser, Review, and Terminal action grid.",
      },
    },
  },
};

export const MissingPageStageTab: Story = {
  args: {
    activeTab: "missing-card",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Page Detail tab whose saved Page id no longer exists; it should render a clear missing state instead of a blank panel.",
      },
    },
  },
};

export const LoadingPageStageTab: Story = {
  args: {
    activeTab: "loading-card",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Page Detail tab while the saved Page detail is still hydrating; it keeps the shell stable with a disabled toolbar and localized property/editor skeletons instead of the missing-Page state.",
      },
    },
  },
};

export const CrossProjectPageStageTab: Story = {
  args: {
    activeTab: "cross-project-card",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Nodex session hosting a Page Detail tab whose content project is Codex readable pack; the tab row should expose the content project before the Page title.",
      },
    },
  },
};

export const ReviewRightTab: Story = {
  args: {
    thread: "attached",
    activeTab: "review",
  },
  parameters: {
    docs: {
      description: {
        story: "Attached session with the singleton Review right-panel tab active.",
      },
    },
  },
};

export const BrowserRightTab: Story = {
  args: {
    activeTab: "browser",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Real Browser tab with Codex-parity chrome. Storybook renders the desktop-only unavailable state because Electron webview is not present.",
      },
    },
  },
};

export const ExpandedSidebarParity: Story = {
  args: {
    thread: "attached",
    sidebar: "expanded",
    sidebarWidth: 300,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Expanded Codex sidebar parity state with the real app-shell left panel mounted at the 300px default width and enabled Back/Forward chrome in the titlebar.",
      },
    },
  },
};

export const ProjectlessOnlyWorkspace: Story = {
  args: {
    workspace: "projectless-only",
    thread: "empty",
    activeTab: "empty",
  },
  parameters: {
    docs: {
      description: {
        story: "The Workbench remains mounted with its global Chats lane when no Projects exist.",
      },
    },
  },
};

export const ScheduledRouteShellHeader: Story = {
  args: {
    thread: "attached",
    rightPanel: "full",
    sidebar: "expanded",
    sidebarWidth: 300,
  },
  render: (args) => <ScheduledRouteProjectSessionShellStory {...args} />,
  parameters: {
    docs: {
      description: {
        story:
          "Scheduled route opened inside the normal Workbench shell: left titlebar chrome stays mounted while the Scheduled tabs and create controls occupy the global header center.",
      },
    },
  },
};

export const SidebarPinnedProjection: Story = {
  args: {
    thread: "attached",
    sidebar: "expanded",
    sidebarWidth: 300,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Pinned tasks always render as standalone Pinned rows; pinned project folders separately render their remaining project children.",
      },
    },
  },
};

export const ExpandedSidebarMinWidth: Story = {
  args: {
    thread: "attached",
    sidebar: "expanded",
    sidebarWidth: 240,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Expanded real sidebar at Codex's 240px minimum width, matching the clamp zone before the half-minimum collapse threshold.",
      },
    },
  },
};

export const ExpandedSidebarMaxWidth: Story = {
  args: {
    thread: "attached",
    sidebar: "expanded",
    sidebarWidth: 520,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Expanded real sidebar at Codex's 520px maximum width, preserving the native vibrant shell and animated header slot reservation.",
      },
    },
  },
};

export const ExpandedSidebarReducedMotion: Story = {
  args: {
    thread: "attached",
    sidebar: "expanded",
    sidebarWidth: 300,
  },
  render: (args) => <ReducedMotionProjectSessionShellStory {...args} />,
  parameters: {
    docs: {
      description: {
        story:
          "Expanded real sidebar under prefers-reduced-motion, where explicit sidebar toggles snap instead of running the shell spring.",
      },
    },
  },
};

export const AttachedThreadPage: Story = {
  args: {
    thread: "attached",
    activeTab: "browser",
  },
};

export const SingletonFilteredActions: Story = {
  args: {
    thread: "attached",
    activeTab: "review",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Session with DB View, Browser, and Review already present; Review filters as a singleton while DB View stays available for other project DBs and Browser remains available for more tabs.",
      },
    },
  },
};

export const CollapsedRightPanel: Story = {
  args: {
    thread: "attached",
    rightPanel: "collapsed",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Attached thread with the right panel collapsed, keeping the thread title and summary toggle in the fixed app-header center surface at the panel boundary.",
      },
    },
  },
};

export const NarrowLongThreadHeaderWithRightPanel: Story = {
  args: {
    thread: "attached",
    rightPanel: "regular",
    sidebar: "expanded",
    sidebarWidth: 520,
    longNames: true,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Narrow main-thread acceptance state with a long task title, maximum-width sidebar, and regular right panel. The fixed toolbar must show exactly one clipped title row while switching tasks; no second title may enter vertically.",
      },
    },
  },
};

export const CollapsedSidebarThreadChrome: Story = {
  args: {
    thread: "attached",
    sidebar: "collapsed",
    sidebarReveal: "idle",
    rightPanel: "collapsed",
    longNames: true,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Collapsed sidebar chrome parity scene: traffic-light safe left rail with sidebar toggle, Back, Forward, compact New chat, and a long thread title that truncates in the top chrome.",
      },
    },
  },
};

export const DisabledNavigationChrome: Story = {
  args: {
    thread: "attached",
    sidebar: "collapsed",
    rightPanel: "collapsed",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Collapsed titlebar with Codex Back/Forward buttons present but disabled because the workbench history stacks are empty.",
      },
    },
  },
};

export const FloatingSidebarAutoRevealed: Story = {
  args: {
    thread: "attached",
    sidebar: "collapsed",
    sidebarReveal: "edge",
    rightPanel: "collapsed",
    sidebarWidth: 300,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Collapsed sidebar with a synthetic pointer at x=12, rendering the Codex fixed floating left panel.",
      },
    },
  },
};

export const FloatingSidebarFocusOverride: Story = {
  args: {
    thread: "attached",
    sidebar: "collapsed",
    sidebarReveal: "focus",
    rightPanel: "regular",
    sidebarWidth: 300,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Collapsed sidebar with focus inside the already revealed floating sidebar, keeping the floating panel visible after the pointer leaves.",
      },
    },
  },
};

export const FloatingSidebarResizedWidth: Story = {
  args: {
    thread: "attached",
    sidebar: "collapsed",
    sidebarReveal: "edge",
    rightPanel: "collapsed",
    sidebarWidth: 520,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Floating sidebar after its right-edge sash has resized to the Codex maximum clamped width of 520px.",
      },
    },
  },
};

export const FloatingSidebarReducedMotion: Story = {
  args: {
    thread: "attached",
    sidebar: "collapsed",
    sidebarReveal: "edge",
    rightPanel: "collapsed",
    sidebarWidth: 300,
  },
  render: (args) => <ReducedMotionProjectSessionShellStory {...args} />,
  parameters: {
    docs: {
      description: {
        story:
          "Floating sidebar under prefers-reduced-motion, using Codex's zero-duration transition branch.",
      },
    },
  },
};

export const FullWidthRightPanel: Story = {
  args: {
    rightPanel: "full",
    activeTab: "terminal",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Expanded right panel with tabs aligned to the panel edge, restore in the panel tab header, and the main thread viewport collapsed to zero width under the same fixed toolbar.",
      },
    },
  },
};

export const CollapsedSidebarFullWidthRightPanel: Story = {
  args: {
    sidebar: "collapsed",
    sidebarReveal: "idle",
    rightPanel: "full",
    activeTab: "browser",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Collapsed sidebar with a full-width right panel: the left titlebar rail reserves its measured width before the right-panel tabs so toolbar controls and tabs never overlap.",
      },
    },
  },
};

export const CollapsedSidebarFullWidthRightPanelReveal: Story = {
  args: {
    sidebar: "collapsed",
    sidebarReveal: "edge",
    rightPanel: "full",
    activeTab: "browser",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Collapsed sidebar auto-reveal over a full-width right panel, matching Codex's pointer-led floating left panel behavior.",
      },
    },
  },
};

export const FullWidthRightPanelWithBottomPanel: Story = {
  args: {
    rightPanel: "full",
    bottomPanel: "terminal",
    activeTab: "terminal",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Full-width right panel with the independent bottom panel still visible, matching Codex's zero right-slot reservation while bottom geometry remains separate.",
      },
    },
  },
};

export const SplitRightPanelGroups: Story = {
  args: {
    rightPanel: "regular",
    rightPanelGroups: "split",
    activeTab: "browser",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Right panel with two persisted tab groups, showing the persistent panel-edge hairline plus hover sash treatment, stable resize release, per-leaf tab strip, and active group chrome.",
      },
    },
  },
};

export const EmptyRightPanelOptionMenu: Story = {
  args: {
    activeTab: "empty",
    rightPanel: "regular",
    bottomPanel: "collapsed",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Codex-parity empty right-panel option menu with the compact Review, Terminal, Browser, Files, and Side chat action rows.",
      },
    },
  },
};

export const RegularRightAndBottomMotionParity: Story = {
  args: {
    thread: "attached",
    rightPanel: "regular",
    bottomPanel: "terminal",
    activeTab: "browser",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Regular side panel plus open bottom panel, showing one active-thread title in the global header, the animated right header slot for bottom/side toggles, and the summary toggle in the thread header lane while both panel shells use Codex spring geometry.",
      },
    },
  },
};

export const LongNames: Story = {
  args: {
    longNames: true,
    activeTab: "terminal",
  },
};
