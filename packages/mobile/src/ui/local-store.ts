import { useSyncExternalStore } from "react";

/**
 * A little state only this phone's screens care about, such as a draft or a transient message. What
 * a Host says lives in the runtime; this holds nothing a reconnect would need to reconcile.
 */
export const createLocalStore = <State>(initial: State) => {
  let state = initial;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const getState = () => state;
  const setState = (update: Partial<State> | ((current: State) => Partial<State>)) => {
    const patch = typeof update === "function" ? update(state) : update;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const useSelected = <Selected>(select: (current: State) => Selected): Selected =>
    useSyncExternalStore(subscribe, () => select(state));
  return Object.assign(useSelected, { getState, setState });
};
