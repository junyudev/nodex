import type {
  WorkbenchLayoutSnapshot,
  WorkbenchLayoutSnapshotV6,
  WorkbenchLayoutSnapshotV7,
  WorkbenchHomeLocation,
  WorkbenchLocation,
  WorkbenchSceneLocation,
  WorkbenchStableLocation,
} from "../../shared/workbench-layout";
import { WorkbenchLayoutSnapshotSchema } from "../../shared/schemas/workbench-layout";
import {
  getRestorableWorkbenchLocation,
  getWorkbenchHomeLocation,
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
  readonly homeLocation: WorkbenchHomeLocation;
  readonly scenesByOwnerKey: Readonly<Record<string, WorkbenchSceneSnapshot>>;
}

export interface WorkbenchLocationHistory {
  readonly backStack: readonly WorkbenchWindowNavigationSnapshot[];
  readonly forwardStack: readonly WorkbenchWindowNavigationSnapshot[];
}

export interface WorkbenchWindowState {
  readonly location: WorkbenchLocation;
  readonly homeLocation: WorkbenchHomeLocation;
  readonly databaseSearchByProject: Readonly<Record<string, string>>;
  readonly scenesByOwnerKey: Readonly<Record<string, WorkbenchSceneSnapshot>>;
  readonly history: WorkbenchLocationHistory;
}

export interface WorkbenchSessionCatalogEntry {
  readonly id: string;
  readonly projectId: string | null;
}

export function createWorkbenchWindowState(
  input: WorkbenchLayoutSnapshot | WorkbenchLayoutSnapshotV7 | WorkbenchLayoutSnapshotV6,
): WorkbenchWindowState {
  const snapshot = WorkbenchLayoutSnapshotSchema.parse(input);
  return {
    location: snapshot.location,
    homeLocation: snapshot.homeLocation,
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
    homeLocation: state.homeLocation,
    scenesByOwnerKey: state.scenesByOwnerKey,
  };
}

function areWorkbenchNavigationSnapshotsEqual(
  left: WorkbenchWindowNavigationSnapshot,
  right: WorkbenchWindowNavigationSnapshot,
): boolean {
  return (
    areWorkbenchLocationsEqual(left.location, right.location) &&
    areWorkbenchLocationsEqual(left.homeLocation, right.homeLocation) &&
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
  const next = {
    ...state,
    location,
    homeLocation: getWorkbenchHomeLocation(location) ?? state.homeLocation,
  };
  if (options.record === false) {
    return next;
  }

  return recordWorkbenchNavigationTransition(state, next);
}

export function navigateBackInWorkbenchWindow(state: WorkbenchWindowState): WorkbenchWindowState {
  const snapshot = state.history.backStack[state.history.backStack.length - 1] ?? null;
  if (!snapshot) return state;

  return {
    ...state,
    location: snapshot.location,
    homeLocation: snapshot.homeLocation,
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
    homeLocation: snapshot.homeLocation,
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

/**
 * Scheduled presents a run or Heartbeat chat in place: the route keeps the Scheduled
 * destination and carries the chat's Session as its Scene.
 */
export function presentWorkbenchScheduledSession(
  state: WorkbenchWindowState,
  input: { readonly path: string; readonly session: WorkbenchSessionCatalogEntry },
): WorkbenchWindowState {
  const projectContextId = input.session.projectId ?? projectContextFromLocation(state.location);
  return navigateWorkbenchWindow(state, {
    kind: "automations",
    path: input.path,
    returnTo: { kind: "session", sessionId: input.session.id, projectContextId },
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

export function selectWorkbenchHome(state: WorkbenchWindowState): WorkbenchWindowState {
  return navigateWorkbenchWindow(state, state.homeLocation);
}

export function openWorkbenchRoute(
  state: WorkbenchWindowState,
  route:
    | { readonly kind: "settings"; readonly path: string }
    | { readonly kind: "automations"; readonly path: string }
    | { readonly kind: "inbox" }
    | {
        readonly kind: "pending-worktree";
        readonly clientThreadId: string;
        readonly expectedHostId?: string;
      },
): WorkbenchWindowState {
  if (route.kind === "settings") {
    const returnTo =
      state.location.kind === "settings" || state.location.kind === "pending-worktree"
        ? state.location.returnTo
        : state.location;
    return navigateWorkbenchWindow(state, { ...route, returnTo });
  }
  const returnTo = getWorkbenchSceneReturnLocation(state.location);
  return navigateWorkbenchWindow(state, {
    ...route,
    returnTo,
  });
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
    homeLocation: getWorkbenchHomeLocation(location) ?? state.homeLocation,
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

function repairLocationForMissingOwner(
  location: WorkbenchSceneLocation,
  owner: WorkbenchSceneOwner,
): WorkbenchSceneLocation;
function repairLocationForMissingOwner(
  location: WorkbenchStableLocation,
  owner: WorkbenchSceneOwner,
): WorkbenchStableLocation;
function repairLocationForMissingOwner(
  location: WorkbenchLocation,
  owner: WorkbenchSceneOwner,
): WorkbenchLocation;
function repairLocationForMissingOwner(
  location: WorkbenchLocation,
  owner: WorkbenchSceneOwner,
): WorkbenchLocation {
  if (location.kind === "settings") {
    const returnTo = repairLocationForMissingOwner(location.returnTo, owner);
    return returnTo === location.returnTo ? location : { ...location, returnTo };
  }
  if ("returnTo" in location) {
    const returnTo = repairLocationForMissingOwner(location.returnTo, owner);
    return returnTo === location.returnTo ? location : { ...location, returnTo };
  }
  const current = location;
  let next: WorkbenchSceneLocation = current;
  if (
    owner.kind === "session" &&
    current.kind === "session" &&
    current.sessionId === owner.sessionId
  ) {
    next = current.projectContextId
      ? { kind: "project", projectId: current.projectContextId }
      : { kind: "empty" };
  }
  if (
    owner.kind === "project" &&
    current.kind === "project" &&
    current.projectId === owner.projectId
  ) {
    next = { kind: "empty" };
  }
  if (
    owner.kind === "project" &&
    current.kind === "session" &&
    current.projectContextId === owner.projectId
  ) {
    next = { ...current, projectContextId: null };
  }
  if (next === current) return location;
  return next;
}

function pruneWorkbenchNavigationSnapshot(
  snapshot: WorkbenchWindowNavigationSnapshot,
  owner: WorkbenchSceneOwner,
): WorkbenchWindowNavigationSnapshot {
  const location = repairLocationForMissingOwner(snapshot.location, owner);
  const homeLocation = getWorkbenchHomeLocation(
    repairLocationForMissingOwner(snapshot.homeLocation, owner),
  ) ?? { kind: "empty" };
  const sceneKey = makeWorkbenchSceneKey(owner);
  const hasScene = snapshot.scenesByOwnerKey[sceneKey] !== undefined;
  if (location === snapshot.location && homeLocation === snapshot.homeLocation && !hasScene) {
    return snapshot;
  }
  const scenesByOwnerKey = hasScene
    ? Object.fromEntries(
        Object.entries(snapshot.scenesByOwnerKey).filter(([key]) => key !== sceneKey),
      )
    : snapshot.scenesByOwnerKey;
  return { location, homeLocation, scenesByOwnerKey };
}

function pruneWorkbenchNavigationStack(
  stack: readonly WorkbenchWindowNavigationSnapshot[],
  owner: WorkbenchSceneOwner,
): readonly WorkbenchWindowNavigationSnapshot[] {
  const next = stack.map((snapshot) => pruneWorkbenchNavigationSnapshot(snapshot, owner));
  return next.every((snapshot, index) => snapshot === stack[index]) ? stack : next;
}

/** Authoritative owner removal repairs retained destinations and history before they can reopen it. */
export function removeWorkbenchScene(
  state: WorkbenchWindowState,
  owner: WorkbenchSceneOwner,
): WorkbenchWindowState {
  const snapshot = snapshotWorkbenchNavigation(state);
  const next = pruneWorkbenchNavigationSnapshot(snapshot, owner);
  const backStack = pruneWorkbenchNavigationStack(state.history.backStack, owner);
  const forwardStack = pruneWorkbenchNavigationStack(state.history.forwardStack, owner);
  if (
    next === snapshot &&
    backStack === state.history.backStack &&
    forwardStack === state.history.forwardStack
  ) {
    return state;
  }
  return { ...state, ...next, history: { backStack, forwardStack } };
}

export function reconcileMissingWorkbenchSession(
  state: WorkbenchWindowState,
  sessionId: string,
): WorkbenchWindowState {
  return removeWorkbenchScene(state, { kind: "session", sessionId });
}

export function replaceWorkbenchWindowSnapshot(
  state: WorkbenchWindowState,
  snapshot: WorkbenchLayoutSnapshot | WorkbenchLayoutSnapshotV7 | WorkbenchLayoutSnapshotV6,
): WorkbenchWindowState {
  return {
    ...createWorkbenchWindowState(snapshot),
    history: state.history,
  };
}

export function snapshotWorkbenchWindowState(state: WorkbenchWindowState): WorkbenchLayoutSnapshot {
  const location = getRestorableWorkbenchLocation(state.location);
  return {
    version: 8,
    location,
    homeLocation: getWorkbenchHomeLocation(location) ?? state.homeLocation,
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
