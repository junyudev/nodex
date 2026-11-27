import { useEffect, useSyncExternalStore } from "react";

// One tip at a time in a window. A tip above the Composer belongs to a moment that passes, so it
// goes first; a tip beside a control stays until it is answered, so it can wait its turn.
let composerTipsOnScreen = 0;
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Counts a Composer tip as on screen for as long as the calling component shows it. */
export function useComposerTipOnScreen(): void {
  useEffect(() => {
    composerTipsOnScreen += 1;
    changed();
    return () => {
      composerTipsOnScreen -= 1;
      changed();
    };
  }, []);
}

/** Whether a tip beside a control has the window's turn: no Composer tip is on screen. */
export function useControlTipTurn(): boolean {
  return useSyncExternalStore(subscribe, () => composerTipsOnScreen === 0);
}
