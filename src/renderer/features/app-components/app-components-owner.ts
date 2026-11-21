import type { AppComponentsState } from "../../../shared/app-components";
import type { AppComponentsRuntime } from "../../lib/app-components-runtime";

export interface AppComponentsOwner {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => AppComponentsState | null;
  readonly setEnabled: (...args: Parameters<AppComponentsRuntime["setEnabled"]>) => Promise<void>;
  readonly request: (...args: Parameters<AppComponentsRuntime["request"]>) => Promise<void>;
  readonly retry: (...args: Parameters<AppComponentsRuntime["retry"]>) => Promise<void>;
}

/** Admit Main's snapshot by revision so a late response never overwrites newer progress. */
export function createAppComponentsOwner(runtime: AppComponentsRuntime): AppComponentsOwner {
  const listeners = new Set<() => void>();
  let snapshot: AppComponentsState | null = null;
  let stopEvents: (() => void) | null = null;

  const admit = (state: AppComponentsState) => {
    if (snapshot && state.revision <= snapshot.revision) return;
    snapshot = state;
    for (const listener of [...listeners]) listener();
  };
  const read = async () => {
    try {
      admit(await runtime.read());
    } catch {
      // Keep the last snapshot. A new observer or a pushed snapshot can recover the view.
    }
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        try {
          stopEvents = runtime.subscribe(admit);
        } catch {
          stopEvents = null;
        }
        void read();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size !== 0) return;
        stopEvents?.();
        stopEvents = null;
      };
    },
    getSnapshot: () => snapshot,
    setEnabled: async (input) => admit(await runtime.setEnabled(input)),
    request: async (id) => admit(await runtime.request(id)),
    retry: async (id) => admit(await runtime.retry(id)),
  };
}
