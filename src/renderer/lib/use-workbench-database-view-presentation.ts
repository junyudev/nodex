import { useLayoutEffect, useState } from "react";
import { makeWorkbenchSceneKey } from "../../shared/workbench-scene";
import {
  databaseViewPresentationIdentity,
  type WorkbenchDatabaseViewPresentationRegistration,
} from "./workbench-database-view-presentation";

/** Publish only the View model committed by this body; unmount and unresolved reads revoke it. */
export function useWorkbenchDatabaseViewPresentation(
  registration: WorkbenchDatabaseViewPresentationRegistration | undefined,
  databaseViewId: string | null,
) {
  const owner = registration?.owner;
  const sceneKey = registration ? makeWorkbenchSceneKey(registration.sceneOwner) : null;
  const identity = registration ? databaseViewPresentationIdentity(registration.surface) : null;
  const [retainedRegistration, setRetainedRegistration] = useState(registration);
  const retainedSceneKey = retainedRegistration
    ? makeWorkbenchSceneKey(retainedRegistration.sceneOwner)
    : null;
  const retainedIdentity = retainedRegistration
    ? databaseViewPresentationIdentity(retainedRegistration.surface)
    : null;
  if (
    owner !== retainedRegistration?.owner ||
    sceneKey !== retainedSceneKey ||
    identity !== retainedIdentity
  ) {
    setRetainedRegistration(registration);
  }
  useLayoutEffect(() => {
    if (!retainedRegistration || !databaseViewId) return;
    return retainedRegistration.owner.registerResolvedDatabaseView(
      retainedRegistration.sceneOwner,
      retainedRegistration.surface,
      databaseViewId,
    );
  }, [retainedRegistration, databaseViewId]);
}
