import { useSyncExternalStore } from "react";
import type { AntigravityRuntimeSnapshot } from "../../../shared/antigravity-runtime";
import { antigravityRuntime, type AntigravityRuntimeAdapter } from "../../lib/antigravity-runtime";

export type AntigravityRuntimeAction = "check" | "install" | "remove" | "cancel";

export interface AntigravityRuntimeViewInput {
  readonly state: AntigravityRuntimeSnapshot | null;
  readonly pending: AntigravityRuntimeAction | null;
  readonly error: {
    readonly action: AntigravityRuntimeAction | "read";
    readonly message: string;
  } | null;
}

export interface AntigravityRuntimeOwner {
  readonly getSnapshot: () => AntigravityRuntimeViewInput;
  readonly subscribe: (listener: () => void) => () => void;
  readonly run: (action: AntigravityRuntimeAction) => Promise<void>;
}

const initial: AntigravityRuntimeViewInput = { state: null, pending: null, error: null };
const inactive = () => () => {};

/** Main owns the operation and orders every reply and event, even across execution restarts. */
export function createAntigravityRuntimeOwner(
  runtime: AntigravityRuntimeAdapter,
): AntigravityRuntimeOwner {
  const listeners = new Set<() => void>();
  let snapshot = initial;
  let stop: (() => void) | undefined;

  const publish = (patch: Partial<AntigravityRuntimeViewInput>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const adopt = (state: AntigravityRuntimeSnapshot) => {
    if (snapshot.state && snapshot.state.revision >= state.revision) return;
    publish({ state, error: null });
  };
  const fail = (action: AntigravityRuntimeAction | "read", error: unknown) =>
    publish({ error: { action, message: error instanceof Error ? error.message : String(error) } });

  const refresh = () => {
    const baseline = snapshot.state;
    void runtime.read().then(adopt, (error: unknown) => {
      if (snapshot.state === baseline) fail("read", error);
    });
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        const stopEvents = runtime.subscribe(adopt);
        const stopInvalidation = runtime.subscribeInvalidation(refresh);
        stop = () => {
          stopEvents();
          stopInvalidation();
        };
        refresh();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        stop?.();
        stop = undefined;
      };
    },
    run: async (action) => {
      if (snapshot.pending) return;
      const operation = snapshot.state?.operation;
      if (action === "cancel" && !operation?.cancellable) return;
      publish({ pending: action, error: null });
      try {
        adopt(
          await (action === "cancel" ? runtime.cancel(operation!.operationId) : runtime[action]()),
        );
      } catch (error) {
        fail(action, error);
      } finally {
        publish({ pending: null });
      }
    },
  };
}

export const antigravityRuntimeOwner = createAntigravityRuntimeOwner(antigravityRuntime);

export function useAntigravityRuntime(
  owner: AntigravityRuntimeOwner = antigravityRuntimeOwner,
  enabled = true,
): AntigravityRuntimeViewInput {
  return useSyncExternalStore(enabled ? owner.subscribe : inactive, owner.getSnapshot);
}
