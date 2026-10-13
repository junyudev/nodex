import type {
  WorkbenchLayoutSnapshot,
  WorkbenchLayoutSnapshotV6,
  WorkbenchLocation,
  WorkbenchSceneLocation,
} from "../../shared/workbench-layout";
import { WorkbenchLayoutSnapshotSchema } from "../../shared/schemas/workbench-layout";
import {
  getRestorableWorkbenchLocation,
  getWorkbenchSceneReturnLocation,
} from "../../shared/workbench-layout";
import {
  makeWorkbenchSceneKey,
  type WorkbenchSceneOwner,
  type WorkbenchSceneSnapshot,
} from "../../shared/workbench-scene";

const MAX_WORKBENCH_LOCATION_HISTORY = 50;

export interface WorkbenchWindowNavigationSnapshot {
  readonly location: WorkbenchLocation;
  readonly scenesByOwnerKey: Readonly<Record<string, WorkbenchSceneSnapshot>>;
}

export interface WorkbenchLocationHistory {
  readonly backStack: readonly WorkbenchWindowNavigationSnapshot[];
  readonly forwardStack: readonly WorkbenchWindowNavigationSnapshot[];
}

export interface WorkbenchWindowState {
  readonly location: WorkbenchLocation;
  readonly databaseSearchByProject: Readonly<Record<string, string>>;
  readonly scenesByOwnerKey: Readonly<Record<string, WorkbenchSceneSnapshot>>;
  readonly history: WorkbenchLocationHistory;
}

export interface WorkbenchSessionCatalogEntry {
  readonly id: string;
  readonly projectId: string | null;
}

export function createWorkbenchWindowState(
  input: WorkbenchLayoutSnapshot | WorkbenchLayoutSnapshotV6,
): WorkbenchWindowState {
  const snapshot = WorkbenchLayoutSnapshotSchema.parse(input);
  return {
    location: snapshot.location,
    databaseSearchByProject: snapshot.databaseSearchByProject,
    scenesByOwnerKey: snapshot.scenesByOwnerKey,
    history: {
      backStack: [],
      forwardStack: [],
    },
  };
}

export function areWorkbenchLocationsEqual(
  left: WorkbenchLocation,
  right: WorkbenchLocation,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function snapshotWorkbenchNavigation(
  state: WorkbenchWindowState,
): WorkbenchWindowNavigationSnapshot {
  return {
    location: state.location,
    scenesByOwnerKey: state.scenesByOwnerKey,
  };
}

function areWorkbenchNavigationSnapshotsEqual(
  left: WorkbenchWindowNavigationSnapshot,
  right: WorkbenchWindowNavigationSnapshot,
): boolean {
  return (
    areWorkbenchLocationsEqual(left.location, right.location) &&
    left.scenesByOwnerKey === right.scenesByOwnerKey
  );
}

function recordWorkbenchNavigationTransition(
  previous: WorkbenchWindowState,
  next: WorkbenchWindowState,
): WorkbenchWindowState {
  const previousSnapshot = snapshotWorkbenchNavigation(previous);
  const lastSnapshot = previous.history.backStack[previous.history.backStack.length - 1] ?? null;
  const backStack =
    lastSnapshot && areWorkbenchNavigationSnapshotsEqual(lastSnapshot, previousSnapshot)
      ? previous.history.backStack
      : [...previous.history.backStack, previousSnapshot].slice(-MAX_WORKBENCH_LOCATION_HISTORY);

  return {
    ...next,
    history: {
      backStack,
      forwardStack: [],
    },
  };
}

export function navigateWorkbenchWindow(
  state: WorkbenchWindowState,
  location: WorkbenchLocation,
  options: { readonly record?: boolean } = {},
): WorkbenchWindowState {
  if (areWorkbenchLocationsEqual(state.location, location)) return state;
  if (options.record === false) {
    return {
      ...state,
      location,
    };
  }

  return recordWorkbenchNavigationTransition(state, {
    ...state,
    location,
  });
}

export function navigateBackInWorkbenchWindow(state: WorkbenchWindowState): WorkbenchWindowState {
  const snapshot = state.history.backStack[state.history.backStack.length - 1] ?? null;
  if (!snapshot) return state;

  return {
    ...state,
    location: snapshot.location,
    scenesByOwnerKey: snapshot.scenesByOwnerKey,
    history: {
      backStack: state.history.backStack.slice(0, -1),
      forwardStack: [snapshotWorkbenchNavigation(state), ...state.history.forwardStack].slice(
        0,
        MAX_WORKBENCH_LOCATION_HISTORY,
      ),
    },
  };
}

export function navigateForwardInWorkbenchWindow(
  state: WorkbenchWindowState,
): WorkbenchWindowState {
  const snapshot = state.history.forwardStack[0] ?? null;
  if (!snapshot) return state;

  return {
    ...state,
    location: snapshot.location,
    scenesByOwnerKey: snapshot.scenesByOwnerKey,
    history: {
      backStack: [...state.history.backStack, snapshotWorkbenchNavigation(state)].slice(
        -MAX_WORKBENCH_LOCATION_HISTORY,
      ),
      forwardStack: state.history.forwardStack.slice(1),
    },
  };
}

function projectContextFromLocation(location: WorkbenchLocation): string | null {
  const sceneLocation = getWorkbenchSceneReturnLocation(location);
  if (sceneLocation.kind === "project") return sceneLocation.projectId;
  if (sceneLocation.kind === "session") {
    return sceneLocation.projectContextId;
  }
  return null;
}

export function selectWorkbenchSession(
  state: WorkbenchWindowState,
  input: WorkbenchSessionCatalogEntry,
): WorkbenchWindowState {
  const projectContextId = input.projectId ?? projectContextFromLocation(state.location);
  return navigateWorkbenchWindow(state, {
    kind: "session",
    sessionId: input.id,
    projectContextId,
  });
}

export function selectWorkbenchProject(
  state: WorkbenchWindowState,
  projectId: string | null,
): WorkbenchWindowState {
  return navigateWorkbenchWindow(
    state,
    projectId ? { kind: "project", projectId } : { kind: "empty" },
  );
}

export function selectWorkbenchPages(state: WorkbenchWindowState): WorkbenchWindowState {
  return navigateWorkbenchWindow(state, { kind: "pages" });
}

export function openWorkbenchRoute(
  state: WorkbenchWindowState,
  route:
    | { readonly kind: "settings"; readonly path: string }
    | { readonly kind: "automations"; readonly path: string }
    | {
        readonly kind: "pending-worktree";
        readonly clientThreadId: string;
        readonly expectedHostId?: string;
      },
): WorkbenchWindowState {
  const returnTo = getWorkbenchSceneReturnLocation(state.location);
  return navigateWorkbenchWindow(state, {
    ...route,
    returnTo,
  } as WorkbenchLocation);
}

export function closeWorkbenchRoute(state: WorkbenchWindowState): WorkbenchWindowState {
  if (
    state.location.kind === "project" ||
    state.location.kind === "session" ||
    state.location.kind === "pages" ||
    state.location.kind === "empty"
  ) {
    return state;
  }
  return navigateWorkbenchWindow(state, state.location.returnTo);
}

export function setWorkbenchDatabaseSearch(
  state: WorkbenchWindowState,
  projectId: string,
  value: string,
): WorkbenchWindowState {
  if (state.databaseSearchByProject[projectId] === value) return state;
  return {
    ...state,
    databaseSearchByProject: {
      ...state.databaseSearchByProject,
      [projectId]: value,
    },
  };
}

export function updateWorkbenchScene(
  state: WorkbenchWindowState,
  owner: WorkbenchSceneOwner,
  update:
    | WorkbenchSceneSnapshot
    | ((previous: WorkbenchSceneSnapshot | undefined) => WorkbenchSceneSnapshot),
  options: { readonly recordHistory?: boolean } = {},
): WorkbenchWindowState {
  const sceneKey = makeWorkbenchSceneKey(owner);
  const previous = state.scenesByOwnerKey[sceneKey];
  const next = typeof update === "function" ? update(previous) : update;
  if (makeWorkbenchSceneKey(next.owner) !== sceneKey || previous === next) {
    return state;
  }

  const nextState = {
    ...state,
    scenesByOwnerKey: {
      ...state.scenesByOwnerKey,
      [sceneKey]: next,
    },
  };
  return options.recordHistory === false
    ? nextState
    : recordWorkbenchNavigationTransition(state, nextState);
}

export function updateWorkbenchSceneAndNavigate(
  state: WorkbenchWindowState,
  owner: WorkbenchSceneOwner,
  update: (previous: WorkbenchSceneSnapshot | undefined) => WorkbenchSceneSnapshot,
  location: WorkbenchSceneLocation,
): WorkbenchWindowState {
  const sceneKey = makeWorkbenchSceneKey(owner);
  const nextScene = update(state.scenesByOwnerKey[sceneKey]);
  if (makeWorkbenchSceneKey(nextScene.owner) !== sceneKey) return state;
  const next = {
    ...state,
    location,
    scenesByOwnerKey: {
      ...state.scenesByOwnerKey,
      [sceneKey]: nextScene,
    },
  };
  if (
    state.scenesByOwnerKey[sceneKey] === nextScene &&
    areWorkbenchLocationsEqual(state.location, location)
  )
    return state;
  return recordWorkbenchNavigationTransition(state, next);
}

export function removeWorkbenchScene(
  state: WorkbenchWindowState,
  owner: WorkbenchSceneOwner,
): WorkbenchWindowState {
  const sceneKey = makeWorkbenchSceneKey(owner);
  if (!state.scenesByOwnerKey[sceneKey]) return state;
  const scenesByOwnerKey = { ...state.scenesByOwnerKey };
  delete scenesByOwnerKey[sceneKey];
  return {
    ...state,
    scenesByOwnerKey,
  };
}

export function reconcileMissingWorkbenchSession(
  state: WorkbenchWindowState,
  sessionId: string,
): WorkbenchWindowState {
  const current = getWorkbenchSceneReturnLocation(state.location);
  if (current.kind !== "session" || current.sessionId !== sessionId) {
    return state;
  }
  const fallback: WorkbenchSceneLocation = current.projectContextId
    ? { kind: "project", projectId: current.projectContextId }
    : { kind: "empty" };

  const withoutScene = removeWorkbenchScene(state, {
    kind: "session",
    sessionId,
  });
  if (
    withoutScene.location.kind !== "project" &&
    withoutScene.location.kind !== "session" &&
    withoutScene.location.kind !== "pages" &&
    withoutScene.location.kind !== "empty"
  ) {
    return {
      ...withoutScene,
      location: {
        ...withoutScene.location,
        returnTo: fallback,
      },
    };
  }
  return navigateWorkbenchWindow(withoutScene, fallback, { record: false });
}

export function replaceWorkbenchWindowSnapshot(
  state: WorkbenchWindowState,
  snapshot: WorkbenchLayoutSnapshot | WorkbenchLayoutSnapshotV6,
): WorkbenchWindowState {
  return {
    ...createWorkbenchWindowState(snapshot),
    history: state.history,
  };
}

export function snapshotWorkbenchWindowState(state: WorkbenchWindowState): WorkbenchLayoutSnapshot {
  return {
    version: 7,
    location: getRestorableWorkbenchLocation(state.location),
    databaseSearchByProject: {
      ...state.databaseSearchByProject,
    },
    scenesByOwnerKey: {
      ...state.scenesByOwnerKey,
    },
  };
}

export const workbenchWindowStateLimits = {
  maxHistoryEntries: MAX_WORKBENCH_LOCATION_HISTORY,
};
