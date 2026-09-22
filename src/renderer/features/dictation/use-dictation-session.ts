import { useEffect, useSyncExternalStore } from "react";
import {
  DictationSessionController,
  type DictationSessionSnapshot,
} from "./dictation-session-controller";

export const useDictationSession = (
  controller: DictationSessionController,
): DictationSessionSnapshot => {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  // A recorded utterance can still settle into the owning draft after its surface
  // detaches. Acquisition is cancelled; subscriptions remain React-owned.
  useEffect(() => () => controller.detach(), [controller]);
  return snapshot;
};
