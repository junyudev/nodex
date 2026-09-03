import type { WorkbenchSessionViewSnapshot } from "./workbench-session-view";
import type {
  WorkbenchSceneKey,
  WorkbenchSceneSnapshot,
  WorkbenchSceneSnapshotV3,
  WorkbenchSceneSnapshotV4,
} from "./workbench-scene";
import type { LibraryResourceTarget, LibraryRouteTarget } from "./library-module";

export type WorkbenchLayoutView = "board" | "list" | "toggle-list" | "calendar";
export type WorkbenchLayoutStageId = "db" | "pages" | "threads" | "files";
export type WorkbenchLayoutStageNavDirection = "left" | "right";

export interface WorkbenchRecentPageSession {
  id: string;
  projectId: string;
  pageId: string;
  titleSnapshot: string;
  lastOpenedAt: string;
}

export interface WorkbenchLayoutPageStageState {
  open: boolean;
  projectId: string;
  pageId: string | null;
}

export interface WorkbenchLayoutThreadsStageTab {
  id: string;
  title: string;
  preview: string;
}

export interface WorkbenchLayoutFilesStageTab {
  id: "diff";
  title: string;
}

export interface WorkbenchLayoutSidebarSnapshot {
  collapsed: boolean;
  width: number;
  collapsibleSections: Record<string, unknown>;
}

export interface WorkbenchLayoutDockSnapshot {
  width: number;
  tree: unknown;
}

export interface WorkbenchLayoutSnapshotV3 {
  version: 3;
  dbProjectId: string | null;
  activeProjectSessionId: string | null;
  threadsProjectId: string | null;
  viewsByProject: Record<string, WorkbenchLayoutView>;
  searchByProject: Record<string, string>;
  dbViewPrefsByProject: Record<string, unknown>;
  projectOrder: string[];
  focusedStage: WorkbenchLayoutStageId;
  stageNavDirection: WorkbenchLayoutStageNavDirection;
  sidebar: WorkbenchLayoutSidebarSnapshot;
  dock: WorkbenchLayoutDockSnapshot;
  sidebarStageExpandedByProject: Record<string, Record<string, boolean>>;
  sidebarSectionExpandedByProject: Record<string, Record<string, boolean>>;
  sidebarSectionShowAllByProject: Record<string, Record<string, boolean>>;
  activePagesTabId: string;
  activeRecentSessionId: string | null;
  recentPageSessions: WorkbenchRecentPageSession[];
  pageStage: WorkbenchLayoutPageStageState;
  threadsTabs: WorkbenchLayoutThreadsStageTab[];
  activeThreadsTabId: string;
  filesTabs: WorkbenchLayoutFilesStageTab[];
  activeFilesTabId: string;
  stagePanelWidths: Record<string, number>;
  slidingWindowPaneCount: number;
  sessionViewsBySessionId: Record<string, WorkbenchSessionViewSnapshot>;
}

export type WorkbenchSessionLocationV4 =
  | {
      readonly kind: "session";
      readonly activeProjectId: string | null;
      readonly sessionId: string;
    }
  | {
      readonly kind: "empty";
      readonly activeProjectId: string | null;
    };

export type WorkbenchLibraryLocationTarget =
  | { readonly kind: "home" }
  | Extract<LibraryRouteTarget, { readonly kind: "page" }>
  | (Extract<LibraryRouteTarget, { readonly kind: "database" | "canvas" | "view" }> & {
      readonly accessProjectId?: string;
    });

export type WorkbenchLocationV4 =
  | WorkbenchSessionLocationV4
  | {
      readonly kind: "library";
      readonly target: WorkbenchLibraryLocationTarget;
      readonly returnTo: WorkbenchSessionLocationV4;
    }
  | {
      readonly kind: "settings";
      readonly path: string;
      readonly returnTo: WorkbenchSessionLocationV4;
    }
  | {
      readonly kind: "automations";
      readonly path: string;
      readonly returnTo: WorkbenchSessionLocationV4;
    }
  | {
      readonly kind: "pending-worktree";
      readonly clientThreadId: string;
      readonly returnTo: WorkbenchSessionLocationV4;
    };

export interface WorkbenchLayoutSnapshotV4 {
  readonly version: 4;
  readonly location: Exclude<WorkbenchLocationV4, { readonly kind: "pending-worktree" }>;
  readonly databaseSearchByProject: Record<string, string>;
  readonly sessionViewsBySessionId: Record<string, WorkbenchSessionViewSnapshot>;
}

export type WorkbenchSceneLocationV5 =
  | {
      readonly kind: "project";
      readonly projectId: string;
    }
  | {
      readonly kind: "session";
      readonly sessionId: string;
      readonly projectContextId: string | null;
    }
  | {
      readonly kind: "empty";
    };

export type WorkbenchLocationV5 =
  | WorkbenchSceneLocationV5
  | {
      readonly kind: "library";
      readonly target: WorkbenchLibraryLocationTarget;
      readonly returnTo: WorkbenchSceneLocationV5;
    }
  | {
      readonly kind: "settings";
      readonly path: string;
      readonly returnTo: WorkbenchSceneLocationV5;
    }
  | {
      readonly kind: "automations";
      readonly path: string;
      readonly returnTo: WorkbenchSceneLocationV5;
    }
  | {
      readonly kind: "pending-worktree";
      readonly clientThreadId: string;
      readonly returnTo: WorkbenchSceneLocationV5;
    };

export interface WorkbenchLayoutSnapshotV5 {
  readonly version: 5;
  readonly location: Exclude<WorkbenchLocationV5, { readonly kind: "pending-worktree" }>;
  readonly databaseSearchByProject: Record<string, string>;
  readonly scenesByOwnerKey: Record<WorkbenchSceneKey, WorkbenchSceneSnapshotV3>;
}

export type WorkbenchSceneLocationV6 =
  | WorkbenchSceneLocationV5
  | {
      readonly kind: "resource";
      readonly root: LibraryResourceTarget;
    };

export type WorkbenchLocationV6 =
  | WorkbenchSceneLocationV6
  | {
      readonly kind: "settings";
      readonly path: string;
      readonly returnTo: WorkbenchSceneLocationV6;
    }
  | {
      readonly kind: "automations";
      readonly path: string;
      readonly returnTo: WorkbenchSceneLocationV6;
    }
  | {
      readonly kind: "pending-worktree";
      readonly clientThreadId: string;
      readonly returnTo: WorkbenchSceneLocationV6;
    };

export interface WorkbenchLayoutSnapshotV6 {
  readonly version: 6;
  readonly location: Exclude<WorkbenchLocationV6, { readonly kind: "pending-worktree" }>;
  readonly databaseSearchByProject: Record<string, string>;
  readonly scenesByOwnerKey: Record<WorkbenchSceneKey, WorkbenchSceneSnapshotV4>;
}

export type WorkbenchSceneLocation = WorkbenchSceneLocationV5 | { readonly kind: "pages" };

export type WorkbenchLocationV7 =
  | WorkbenchSceneLocation
  | {
      readonly kind: "settings";
      readonly path: string;
      readonly returnTo: WorkbenchSceneLocation;
    }
  | {
      readonly kind: "automations";
      readonly path: string;
      readonly returnTo: WorkbenchSceneLocation;
    }
  | {
      readonly kind: "pending-worktree";
      readonly clientThreadId: string;
      readonly returnTo: WorkbenchSceneLocation;
    };

export interface WorkbenchLayoutSnapshotV7 {
  readonly version: 7;
  readonly location: Exclude<WorkbenchLocationV7, { readonly kind: "pending-worktree" }>;
  readonly databaseSearchByProject: Record<string, string>;
  readonly scenesByOwnerKey: Record<WorkbenchSceneKey, WorkbenchSceneSnapshot>;
}

export type WorkbenchLocation = WorkbenchLocationV7;
export type WorkbenchLayoutSnapshot = WorkbenchLayoutSnapshotV7;

function createDefaultDockTree(): WorkbenchLayoutSnapshotV3["dock"]["tree"] {
  return {
    type: "leaf",
    id: globalThis.crypto?.randomUUID?.() ?? "default-dock",
    tabs: [
      { id: "pagestage", kind: "pagestage", title: "Page" },
      { id: "history", kind: "history", title: "History" },
    ],
    activeTabId: "pagestage",
  };
}

export function createDefaultWorkbenchLayoutSnapshotV3(): WorkbenchLayoutSnapshotV3 {
  return {
    version: 3,
    dbProjectId: null,
    activeProjectSessionId: null,
    threadsProjectId: null,
    viewsByProject: {},
    searchByProject: {},
    dbViewPrefsByProject: {},
    projectOrder: [],
    focusedStage: "db",
    stageNavDirection: "right",
    sidebar: {
      collapsed: false,
      width: 300,
      collapsibleSections: {},
    },
    dock: {
      width: 560,
      tree: createDefaultDockTree(),
    },
    sidebarStageExpandedByProject: {},
    sidebarSectionExpandedByProject: {},
    sidebarSectionShowAllByProject: {},
    activePagesTabId: "",
    activeRecentSessionId: null,
    recentPageSessions: [],
    pageStage: {
      open: false,
      projectId: "",
      pageId: null,
    },
    threadsTabs: [],
    activeThreadsTabId: "thread:new",
    filesTabs: [{ id: "diff", title: "Diffs" }],
    activeFilesTabId: "diff",
    stagePanelWidths: {},
    slidingWindowPaneCount: 2,
    sessionViewsBySessionId: {},
  };
}

export function createDefaultWorkbenchLayoutSnapshotV4(): WorkbenchLayoutSnapshotV4 {
  return {
    version: 4,
    location: {
      kind: "empty",
      activeProjectId: null,
    },
    databaseSearchByProject: {},
    sessionViewsBySessionId: {},
  };
}

export function createDefaultWorkbenchLayoutSnapshotV5(): WorkbenchLayoutSnapshotV5 {
  return {
    version: 5,
    location: { kind: "empty" },
    databaseSearchByProject: {},
    scenesByOwnerKey: {},
  };
}

export function createDefaultWorkbenchLayoutSnapshotV6(): WorkbenchLayoutSnapshotV6 {
  return {
    version: 6,
    location: { kind: "empty" },
    databaseSearchByProject: {},
    scenesByOwnerKey: {},
  };
}

export function createDefaultWorkbenchLayoutSnapshotV7(): WorkbenchLayoutSnapshotV7 {
  return {
    version: 7,
    location: { kind: "empty" },
    databaseSearchByProject: {},
    scenesByOwnerKey: {},
  };
}

export function createDefaultWorkbenchLayoutSnapshot(): WorkbenchLayoutSnapshot {
  return createDefaultWorkbenchLayoutSnapshotV7();
}

export function getWorkbenchSessionReturnLocationV4(
  location: WorkbenchLocationV4,
): WorkbenchSessionLocationV4 {
  if (location.kind === "session" || location.kind === "empty") {
    return location;
  }
  return location.returnTo;
}

export function getWorkbenchSceneReturnLocation(
  location: WorkbenchLocationV7,
): WorkbenchSceneLocation {
  if (
    location.kind === "project" ||
    location.kind === "session" ||
    location.kind === "pages" ||
    location.kind === "empty"
  ) {
    return location;
  }
  return location.returnTo;
}

/** Resolves the active Agent Session from the canonical Window Session location projection. */
export function getWorkbenchActiveSessionId(
  layout: Pick<WorkbenchLayoutSnapshotV7, "location">,
): string | null {
  const location = getWorkbenchSceneReturnLocation(layout.location);
  return location.kind === "session" ? location.sessionId : null;
}

export function getRestorableWorkbenchLocationV4(
  location: WorkbenchLocationV4,
): WorkbenchLayoutSnapshotV4["location"] {
  if (location.kind !== "pending-worktree") return location;
  return location.returnTo;
}

export function getRestorableWorkbenchLocationV5(
  location: WorkbenchLocationV5,
): WorkbenchLayoutSnapshotV5["location"] {
  if (location.kind !== "pending-worktree") return location;
  return location.returnTo;
}

export function getRestorableWorkbenchLocationV6(
  location: WorkbenchLocationV6,
): WorkbenchLayoutSnapshotV6["location"] {
  if (location.kind !== "pending-worktree") return location;
  return location.returnTo;
}

export function getRestorableWorkbenchLocationV7(
  location: WorkbenchLocationV7,
): WorkbenchLayoutSnapshotV7["location"] {
  if (location.kind !== "pending-worktree") return location;
  return location.returnTo;
}

export const getRestorableWorkbenchLocation = getRestorableWorkbenchLocationV7;
