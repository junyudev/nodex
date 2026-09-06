import { expect, test, vi } from "vite-plus/test";
import {
  acquireContentInteractionHistory,
  readContentInteractionHistories,
  readContentProjectionActivities,
  registerContentProjectionActivity,
  subscribeContentInteractionHistories,
  type ContentProjectionActivity,
} from "./content-interaction-history";

test("observation neither retains a timeline nor duplicates shared projection owners", () => {
  const scope = {
    libraryId: "observation",
    accessContext: { kind: "library" as const },
    storeEpoch: "epoch",
  };
  const changed = vi.fn();
  const unsubscribe = subscribeContentInteractionHistories(changed);
  const lease = acquireContentInteractionHistory(scope);
  let activity: ContentProjectionActivity = { pending: 1, acknowledged: 0, unknown: 0 };
  let notify = () => {};
  const detach = vi.fn();
  const source = {
    id: "view",
    label: "Tasks",
    getActivity: () => activity,
    subscribe: (listener: () => void) => {
      notify = listener;
      return detach;
    },
  };
  const releaseFirst = registerContentProjectionActivity(scope, source);
  const releaseSecond = registerContentProjectionActivity(scope, source);
  try {
    expect(readContentInteractionHistories()).toHaveLength(1);
    expect(readContentProjectionActivities()).toHaveLength(1);
    expect(readContentProjectionActivities()[0]?.activity.pending).toBe(1);
    const before = readContentProjectionActivities();
    expect(readContentProjectionActivities()).toBe(before);
    activity = { pending: 0, acknowledged: 1, unknown: 0 };
    notify();
    expect(readContentProjectionActivities()[0]?.activity.acknowledged).toBe(1);
    expect(changed).toHaveBeenCalled();
    lease.release();
    expect(readContentInteractionHistories()).toHaveLength(0);
    releaseFirst();
    expect(detach).not.toHaveBeenCalled();
    releaseSecond();
    expect(detach).toHaveBeenCalledTimes(1);
    expect(readContentProjectionActivities()).toHaveLength(0);
  } finally {
    lease.release();
    releaseFirst();
    releaseSecond();
    unsubscribe();
  }
});
