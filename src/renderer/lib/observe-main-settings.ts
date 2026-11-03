import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { LatestReturnedValueOwner } from "./latest-returned-value-owner";

/** Reconcile cross-window invalidations after local saves; delayed events never overwrite intent. */
export function observeMainSettings<Value extends object>(
  owner: LatestReturnedValueOwner<Value>,
  queryClient: QueryClient,
  queryKey: QueryKey,
  subscribeChanges: (listener: () => void) => () => void,
): LatestReturnedValueOwner<Value> {
  let subscriptions = 0;
  let unsubscribeChanges: (() => void) | null = null;
  let refreshRequested = false;
  let refreshSequence = 0;
  const refreshCanonical = () => {
    refreshRequested = true;
    if (owner.getSnapshot().pending) return;
    refreshRequested = false;
    const sequence = ++refreshSequence;
    // Notifications and command replies have independent delivery order. Read Main's
    // current value instead of treating a delayed notification as a newer mutation.
    void queryClient.cancelQueries({ queryKey, exact: true }).then(() => {
      if (sequence !== refreshSequence) return;
      if (owner.getSnapshot().pending) {
        refreshRequested = true;
        return;
      }
      return queryClient.invalidateQueries({ queryKey, exact: true });
    });
  };
  const sharedOwner: LatestReturnedValueOwner<Value> = {
    ...owner,
    subscribe: (listener) => {
      const unsubscribe = owner.subscribe(() => {
        listener();
        if (refreshRequested && !owner.getSnapshot().pending) refreshCanonical();
      });
      subscriptions += 1;
      if (subscriptions === 1) {
        unsubscribeChanges = subscribeChanges(refreshCanonical);
      }
      return () => {
        unsubscribe();
        subscriptions -= 1;
        if (subscriptions > 0) return;
        unsubscribeChanges?.();
        unsubscribeChanges = null;
      };
    },
  };
  return sharedOwner;
}
