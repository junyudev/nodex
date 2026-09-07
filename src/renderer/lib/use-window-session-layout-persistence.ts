import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { WorkbenchLayoutSnapshot } from "../../shared/workbench-layout";
import { saveWindowSessionLayout } from "./window-sessions";
import { createWindowSessionLayoutPersistence } from "./window-session-layout-persistence";
import type {
  WorkbenchWindowOwner,
  WorkbenchWindowPersistenceSnapshot,
} from "./workbench-window-owner";

const WINDOW_SESSION_LAYOUT_SAVE_DEBOUNCE_MS = 350;

export function useWindowSessionLayoutPersistence(input: {
  readonly sessionId: string;
  readonly initialRevision: number;
  readonly initialLayout: WorkbenchLayoutSnapshot;
  readonly owner: WorkbenchWindowOwner;
}) {
  const { owner } = input;
  const writer = useMemo(
    () =>
      createWindowSessionLayoutPersistence({
        sessionId: input.sessionId,
        initialRevision: input.initialRevision,
        initialLayout: input.initialLayout,
        save: saveWindowSessionLayout,
      }),
    [input.initialLayout, input.initialRevision, input.sessionId],
  );
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);
  const commit = useCallback(
    (snapshot: WorkbenchWindowPersistenceSnapshot) => {
      clearTimer();
      return writer.commit(snapshot);
    },
    [clearTimer, writer],
  );
  const commitCurrent = useCallback(
    () => commit(owner.capturePersistenceSnapshot()),
    [commit, owner],
  );

  useLayoutEffect(() => {
    const unregisterCommit = owner.registerPersistenceCommit(commit);
    let previousWindowState = owner.read().windowState;
    const schedule = () => {
      clearTimer();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void commitCurrent().catch((error: unknown) => {
          console.error("Failed to persist Window Session layout", error);
        });
      }, WINDOW_SESSION_LAYOUT_SAVE_DEBOUNCE_MS);
    };
    // Initial materialization may have happened in a child's layout effect before this subscription.
    schedule();
    const unsubscribe = owner.subscribe(() => {
      const current = owner.read().windowState;
      if (current === previousWindowState) return;
      previousWindowState = current;
      schedule();
    });
    return () => {
      unsubscribe();
      unregisterCommit();
      clearTimer();
    };
  }, [clearTimer, commit, commitCurrent, owner]);

  return { commitCurrent, flush: commitCurrent };
}

export const windowSessionLayoutPersistenceTiming = {
  saveDebounceMs: WINDOW_SESSION_LAYOUT_SAVE_DEBOUNCE_MS,
};
