import { useEffectEvent, useLayoutEffect, useRef } from "react";
import { makeWorkbenchSceneKey } from "../../shared/workbench-scene";
import { databaseViewPresentationIdentity } from "./workbench-database-view-presentation";
import {
  registerWorkbenchViewContent,
  type WorkbenchViewContentBinding,
} from "./workbench-view-content";

/** External reads use the last committed body, never a callback from an abandoned render. */
export function useWorkbenchViewContent(
  binding: WorkbenchViewContentBinding | undefined,
  read: Parameters<typeof registerWorkbenchViewContent>[1],
): void {
  const reader = useRef(read);
  useLayoutEffect(() => {
    reader.current = read;
  });
  const registration = binding?.presentation;
  const owner = registration?.owner;
  const sceneKey = registration ? makeWorkbenchSceneKey(registration.sceneOwner) : null;
  const identity = registration ? databaseViewPresentationIdentity(registration.surface) : null;
  const readRegistration = useEffectEvent(() => registration);
  // The identity contains every semantic descriptor field; title changes do not retarget this reader.
  useLayoutEffect(() => {
    const current = readRegistration();
    if (
      !current ||
      current.owner !== owner ||
      makeWorkbenchSceneKey(current.sceneOwner) !== sceneKey ||
      databaseViewPresentationIdentity(current.surface) !== identity
    )
      return;
    return registerWorkbenchViewContent(current, (request) => reader.current(request));
  }, [owner, sceneKey, identity]);
}
