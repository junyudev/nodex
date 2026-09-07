import type { PanelId } from "../../shared/types";
import {
  createDefaultWorkbenchLayoutSnapshot,
  type WorkbenchLayoutSnapshot,
  type WorkbenchLocation,
  type WorkbenchSceneLocation,
} from "../../shared/workbench-layout";
import {
  makeWorkbenchSceneKey,
  type WorkbenchSceneOwner,
  type WorkbenchSceneSnapshot,
} from "../../shared/workbench-scene";
import { appScope, scopedAtom, scopedDerivedAtom, type ScopeHandle } from "./maitai/maitai-store";
import {
  databaseViewPresentationIdentity,
  type WorkbenchDatabaseViewReference,
} from "./workbench-database-view-presentation";
import {
  createWorkbenchEphemeralPanelState,
  reduceWorkbenchEphemeralPanelState,
  type WorkbenchEphemeralPanelAction,
  type WorkbenchEphemeralPanelState,
} from "./workbench-ephemeral-panel-state";
import {
  areWorkbenchLocationsEqual,
  closeWorkbenchRoute,
  createWorkbenchWindowState,
  navigateBackInWorkbenchWindow,
  navigateForwardInWorkbenchWindow,
  navigateWorkbenchWindow,
  openWorkbenchRoute,
  reconcileMissingWorkbenchSession,
  removeWorkbenchScene,
  replaceWorkbenchWindowSnapshot,
  selectWorkbenchPages,
  selectWorkbenchProject,
  selectWorkbenchSession,
  setWorkbenchDatabaseSearch,
  snapshotWorkbenchWindowState,
  updateWorkbenchScene,
  updateWorkbenchSceneAndNavigate,
  type WorkbenchSessionCatalogEntry,
  type WorkbenchWindowState,
} from "./workbench-window-state";

export interface WorkbenchFocusedPanelGroup {
  readonly ownerKey: string;
  readonly panelId: PanelId;
  readonly leafId: string;
}

export interface WorkbenchWindowPresentationState {
  readonly presentationRevision: number;
  readonly windowState: WorkbenchWindowState;
  readonly ephemeralPanels: WorkbenchEphemeralPanelState;
  readonly focusedPanelGroup: WorkbenchFocusedPanelGroup | null;
}

export interface WorkbenchWindowPersistenceSnapshot {
  readonly presentationRevision: number;
  readonly layout: WorkbenchLayoutSnapshot;
}

export interface WorkbenchWindowPersistenceReceipt extends WorkbenchWindowPersistenceSnapshot {
  readonly sessionId: string;
  readonly layoutRevision: number;
}

type CommitSnapshot = (
  snapshot: WorkbenchWindowPersistenceSnapshot,
) => Promise<WorkbenchWindowPersistenceReceipt>;

const presentationStateAtom = scopedAtom<WorkbenchWindowPresentationState | null>(appScope, null, {
  debugLabel: "workbench-window-presentation",
});

export const workbenchWindowStateAtom = scopedDerivedAtom(
  appScope,
  (get) => get(presentationStateAtom)?.windowState ?? null,
  { debugLabel: "workbench-window-state" },
);
export const workbenchEphemeralPanelsAtom = scopedDerivedAtom(
  appScope,
  (get) => get(presentationStateAtom)?.ephemeralPanels ?? null,
  { debugLabel: "workbench-ephemeral-panels" },
);

export class WorkbenchPresentationConflict extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`Workbench presentation changed from revision ${expectedRevision} to ${actualRevision}`);
    this.name = "WorkbenchPresentationConflict";
  }
}

// The cache holds one callable Interface per concrete App atom, never a second Scene store.
const owners = new WeakMap<object, ReturnType<typeof createWorkbenchWindowOwner>>();

export function getWorkbenchWindowOwner(
  scope: ScopeHandle,
  initialSnapshot?: WorkbenchLayoutSnapshot,
): WorkbenchWindowOwner {
  const key = scope.resolve(presentationStateAtom);
  const existing = owners.get(key);
  if (existing) {
    if (initialSnapshot) existing.prepareInitialSnapshot(initialSnapshot);
    return existing;
  }
  const owner = createWorkbenchWindowOwner(scope, initialSnapshot);
  owners.set(key, owner);
  return owner;
}

function createWorkbenchWindowOwner(scope: ScopeHandle, initialSnapshot?: WorkbenchLayoutSnapshot) {
  let preparedInitialSnapshot = initialSnapshot ?? null;
  let initialState: WorkbenchWindowPresentationState = {
    presentationRevision: 0,
    windowState: createWorkbenchWindowState(
      initialSnapshot ?? createDefaultWorkbenchLayoutSnapshot(),
    ),
    ephemeralPanels: createWorkbenchEphemeralPanelState(),
    focusedPanelGroup: null,
  };
  let commitSnapshot: CommitSnapshot | null = null;
  const resolvedDatabaseViews = new Map<
    string,
    { readonly token: object; readonly identity: string; readonly read: () => string }
  >();
  const read = () => scope.get(presentationStateAtom) ?? initialState;
  const initialize = () => scope.set(presentationStateAtom, (current) => current ?? initialState);
  const transition = (
    update: (current: WorkbenchWindowPresentationState) => WorkbenchWindowPresentationState,
    expectedPresentationRevision?: number,
  ) => {
    scope.set(presentationStateAtom, (stored) => {
      const current = stored ?? initialState;
      if (
        expectedPresentationRevision !== undefined &&
        current.presentationRevision !== expectedPresentationRevision
      ) {
        throw new WorkbenchPresentationConflict(
          expectedPresentationRevision,
          current.presentationRevision,
        );
      }
      const next = update(current);
      if (next === current) return current;
      return { ...next, presentationRevision: current.presentationRevision + 1 };
    });
    return read();
  };
  const updateWindow = (
    update: (state: WorkbenchWindowState) => WorkbenchWindowState,
    expectedPresentationRevision?: number,
  ) =>
    transition((current) => {
      const windowState = update(current.windowState);
      if (windowState === current.windowState) return current;
      return {
        ...current,
        windowState,
        focusedPanelGroup: areWorkbenchLocationsEqual(
          current.windowState.location,
          windowState.location,
        )
          ? current.focusedPanelGroup
          : null,
      };
    }, expectedPresentationRevision);
  const setFocusedPanelGroup = (focus: WorkbenchFocusedPanelGroup | null) =>
    transition((current) => {
      const previous = current.focusedPanelGroup;
      if (
        previous === focus ||
        (previous?.ownerKey === focus?.ownerKey &&
          previous?.panelId === focus?.panelId &&
          previous?.leafId === focus?.leafId)
      )
        return current;
      return { ...current, focusedPanelGroup: focus };
    });
  const snapshotForPersistence = () => snapshotWorkbenchWindowState(read().windowState);
  const capturePersistenceSnapshot = (): WorkbenchWindowPersistenceSnapshot => {
    const current = read();
    return {
      presentationRevision: current.presentationRevision,
      layout: snapshotWorkbenchWindowState(current.windowState),
    };
  };

  return {
    // Read-only consumers can obtain this Interface before the Window bootstrap owner mounts.
    prepareInitialSnapshot: (snapshot: WorkbenchLayoutSnapshot) => {
      if (preparedInitialSnapshot || scope.get(presentationStateAtom)) return;
      preparedInitialSnapshot = snapshot;
      initialState = { ...initialState, windowState: createWorkbenchWindowState(snapshot) };
    },
    read,
    initialize,
    registerResolvedDatabaseView: (
      sceneOwner: WorkbenchSceneOwner,
      surface: WorkbenchDatabaseViewReference,
      databaseViewId: string,
    ) => {
      const key = JSON.stringify([makeWorkbenchSceneKey(sceneOwner), surface.id]);
      const identity = databaseViewPresentationIdentity(surface);
      const previous = resolvedDatabaseViews.get(key);
      const token = {};
      resolvedDatabaseViews.set(key, { token, identity, read: () => databaseViewId });
      if (previous?.identity !== identity || previous.read() !== databaseViewId)
        transition((current) => ({ ...current }));
      return () => {
        if (resolvedDatabaseViews.get(key)?.token !== token) return;
        resolvedDatabaseViews.delete(key);
        transition((current) => ({ ...current }));
      };
    },
    resolveDatabaseView: (
      sceneOwner: WorkbenchSceneOwner,
      surface: WorkbenchDatabaseViewReference,
    ): string | null => {
      const registration = resolvedDatabaseViews.get(
        JSON.stringify([makeWorkbenchSceneKey(sceneOwner), surface.id]),
      );
      if (!registration || registration.identity !== databaseViewPresentationIdentity(surface))
        return null;
      return registration.read();
    },
    subscribe: (listener: () => void) => scope.sub(presentationStateAtom, listener),
    snapshotForPersistence,
    capturePersistenceSnapshot,
    setFocusedPanelGroup,
    // Existing keyboard routing keeps its ref-shaped API, with no independently writable ref.
    focusedPanelGroupRef: {
      get current() {
        return read().focusedPanelGroup;
      },
      set current(value: WorkbenchFocusedPanelGroup | null) {
        setFocusedPanelGroup(value);
      },
    },
    dispatchEphemeral: (
      action: WorkbenchEphemeralPanelAction,
      expectedPresentationRevision?: number,
    ) =>
      transition((current) => {
        const ephemeralPanels = reduceWorkbenchEphemeralPanelState(current.ephemeralPanels, action);
        return ephemeralPanels === current.ephemeralPanels
          ? current
          : { ...current, ephemeralPanels };
      }, expectedPresentationRevision),
    navigate: (location: WorkbenchLocation, options?: { readonly record?: boolean }) =>
      updateWindow((state) => navigateWorkbenchWindow(state, location, options)),
    navigateBack: () => updateWindow(navigateBackInWorkbenchWindow),
    navigateForward: () => updateWindow(navigateForwardInWorkbenchWindow),
    selectSession: (session: WorkbenchSessionCatalogEntry) =>
      updateWindow((state) => selectWorkbenchSession(state, session)),
    selectProject: (projectId: string | null) =>
      updateWindow((state) => selectWorkbenchProject(state, projectId)),
    selectPages: () => updateWindow(selectWorkbenchPages),
    openRoute: (route: Parameters<typeof openWorkbenchRoute>[1]) =>
      updateWindow((state) => openWorkbenchRoute(state, route)),
    closeRoute: () => updateWindow(closeWorkbenchRoute),
    setDatabaseSearch: (projectId: string, value: string) =>
      updateWindow((state) => setWorkbenchDatabaseSearch(state, projectId, value)),
    setScene: (
      owner: WorkbenchSceneOwner,
      update:
        | WorkbenchSceneSnapshot
        | ((previous: WorkbenchSceneSnapshot | undefined) => WorkbenchSceneSnapshot),
      options?: {
        readonly recordHistory?: boolean;
        readonly expectedPresentationRevision?: number;
      },
    ) =>
      updateWindow(
        (state) => updateWorkbenchScene(state, owner, update, options),
        options?.expectedPresentationRevision,
      ),
    updateScenePresentation: (
      sceneOwner: WorkbenchSceneOwner,
      update: (
        scene: WorkbenchSceneSnapshot,
        ephemeralPanels: WorkbenchEphemeralPanelState,
      ) => {
        readonly scene: WorkbenchSceneSnapshot;
        readonly ephemeralPanels: WorkbenchEphemeralPanelState;
      },
      expectedPresentationRevision: number,
      options: {
        readonly initialScene?: WorkbenchSceneSnapshot;
        readonly location?: WorkbenchSceneLocation;
      } = {},
    ) =>
      transition((current) => {
        const scene =
          current.windowState.scenesByOwnerKey[makeWorkbenchSceneKey(sceneOwner)] ??
          options.initialScene;
        if (!scene) throw new Error("Workbench Scene is unavailable");
        const next = update(scene, current.ephemeralPanels);
        const windowState = options.location
          ? updateWorkbenchSceneAndNavigate(
              current.windowState,
              sceneOwner,
              () => next.scene,
              options.location,
            )
          : next.scene === scene &&
              current.windowState.scenesByOwnerKey[makeWorkbenchSceneKey(sceneOwner)]
            ? current.windowState
            : updateWorkbenchScene(current.windowState, sceneOwner, next.scene);
        if (windowState === current.windowState && next.ephemeralPanels === current.ephemeralPanels)
          return current;
        return {
          ...current,
          windowState,
          ephemeralPanels: next.ephemeralPanels,
          focusedPanelGroup:
            options.location &&
            !areWorkbenchLocationsEqual(current.windowState.location, options.location)
              ? null
              : current.focusedPanelGroup,
        };
      }, expectedPresentationRevision),
    setSceneAndNavigate: (
      owner: WorkbenchSceneOwner,
      update: (previous: WorkbenchSceneSnapshot | undefined) => WorkbenchSceneSnapshot,
      location: Parameters<typeof updateWorkbenchSceneAndNavigate>[3],
    ) => updateWindow((state) => updateWorkbenchSceneAndNavigate(state, owner, update, location)),
    removeScene: (owner: WorkbenchSceneOwner) =>
      updateWindow((state) => removeWorkbenchScene(state, owner)),
    reconcileMissingSession: (sessionId: string) =>
      updateWindow((state) => reconcileMissingWorkbenchSession(state, sessionId)),
    replaceFromSnapshot: (snapshot: WorkbenchLayoutSnapshot) =>
      updateWindow((state) => replaceWorkbenchWindowSnapshot(state, snapshot)),
    registerPersistenceCommit: (commit: CommitSnapshot) => {
      if (commitSnapshot && commitSnapshot !== commit)
        throw new Error("Workbench persistence already has a writer");
      commitSnapshot = commit;
      return () => {
        if (commitSnapshot === commit) commitSnapshot = null;
      };
    },
    commitCurrent: (): Promise<WorkbenchWindowPersistenceReceipt> => {
      if (!commitSnapshot) return Promise.reject(new Error("Workbench persistence is unavailable"));
      return commitSnapshot(capturePersistenceSnapshot());
    },
  };
}

export type WorkbenchWindowOwner = Omit<
  ReturnType<typeof createWorkbenchWindowOwner>,
  "prepareInitialSnapshot"
>;
