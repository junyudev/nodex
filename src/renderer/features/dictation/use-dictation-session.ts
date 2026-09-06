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

  // Effect cleanup can be replayed while React retains this controller. Release
  // the active session; subscriptions unsubscribe through useSyncExternalStore.
  useEffect(() => () => controller.cancel(), [controller]);
  return snapshot;
};
