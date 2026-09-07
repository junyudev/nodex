import { useEffectEvent, useLayoutEffect } from "react";
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
  const register = useEffectEvent(() => {
    if (!registration || !databaseViewId) return;
    return registration.owner.registerResolvedDatabaseView(
      registration.sceneOwner,
      registration.surface,
      databaseViewId,
    );
  });
  useLayoutEffect(() => register(), [owner, sceneKey, identity, databaseViewId]);
}
