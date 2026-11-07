import { useLayoutEffect, useMemo } from "react";
import {
  createDefaultWorkbenchLayoutSnapshot,
  type WorkbenchLayoutSnapshot,
} from "../../shared/workbench-layout";
import { appScope, scopedDerivedAtom, useScopeHandle, useScopedAtomValue } from "./maitai";
import {
  getWorkbenchWindowOwner,
  workbenchEphemeralPanelsAtom,
  workbenchWindowStateAtom,
} from "./workbench-window-owner";

export const workbenchLocationAtom = scopedDerivedAtom(
  appScope,
  (get) => get(workbenchWindowStateAtom)?.location ?? null,
  { debugLabel: "workbench-location" },
);
export const workbenchScenesAtom = scopedDerivedAtom(
  appScope,
  (get) => get(workbenchWindowStateAtom)?.scenesByOwnerKey ?? {},
  { debugLabel: "workbench-scenes" },
);

export function useWorkbenchWindowOwner(initialSnapshot?: WorkbenchLayoutSnapshot) {
  const scope = useScopeHandle(appScope);
  const owner = getWorkbenchWindowOwner(scope, initialSnapshot);
  const ownsInitialization = initialSnapshot !== undefined;
  useLayoutEffect(() => {
    if (ownsInitialization) owner.initialize();
  }, [owner, ownsInitialization]);
  return owner;
}

export function useWorkbenchEphemeralPanels() {
  const owner = useWorkbenchWindowOwner();
  const state = useScopedAtomValue(workbenchEphemeralPanelsAtom) ?? owner.read().ephemeralPanels;
  return { state, owner, dispatch: owner.dispatchEphemeral };
}

export function useWorkbenchWindowState(
  initialSnapshot: WorkbenchLayoutSnapshot = createDefaultWorkbenchLayoutSnapshot(),
) {
  const owner = useWorkbenchWindowOwner(initialSnapshot);
  const state = useScopedAtomValue(workbenchWindowStateAtom) ?? owner.read().windowState;
  return useMemo(
    () => ({
      ...owner,
      owner,
      state,
      location: state.location,
      databaseSearchByProject: state.databaseSearchByProject,
      scenesByOwnerKey: state.scenesByOwnerKey,
      canNavigateBack: state.history.backStack.length > 0,
      canNavigateForward: state.history.forwardStack.length > 0,
      openProject: owner.selectProject,
    }),
    [owner, state],
  );
}
