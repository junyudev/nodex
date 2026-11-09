import { useEffect } from "react";
import { recordProductEvent } from "../../lib/product-analytics";
import { subscribeReadbackEvents } from "../../lib/readback-events";
import {
  createReadbackStore,
  type ReadbackCloseReason,
  type ReadbackStore,
} from "./readback-store";

type ReadbackAction = "shown" | "stopped" | ReadbackCloseReason;

const record = (action: ReadbackAction) =>
  recordProductEvent({ name: "readback", properties: { action } });

/** This window's Readbacks on screen. */
export const readbackStore: ReadbackStore = createReadbackStore({
  onClose: (_readback, reason) => record(reason),
});

/** Admits the Readbacks Main sends this window for as long as the caller is mounted. */
export function useReadbackEvents(store: ReadbackStore = readbackStore): void {
  useEffect(
    () =>
      subscribeReadbackEvents((event) => {
        if (event.type === "show") record("shown");
        store.apply(event);
      }),
    [store],
  );
}

export const recordReadbackStopped = (): void => record("stopped");
