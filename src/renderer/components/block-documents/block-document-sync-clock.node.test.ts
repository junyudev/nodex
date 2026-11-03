import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createBlockDocumentSyncClock } from "./block-document-sync-clock";

afterEach(() => vi.useRealTimers());

describe("document sync clock", () => {
  test("retains phase and pending ages until their respective transitions", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const clock = createBlockDocumentSyncClock("connecting", false, null);
    const unsubscribe = clock.subscribe(vi.fn());
    vi.advanceTimersByTime(500);
    expect(clock.getSnapshot().now - clock.getSnapshot().phaseStartedAt).toBe(500);
    clock.observe("connecting", true, null);
    vi.advanceTimersByTime(250);
    expect(clock.getSnapshot().phaseStartedAt).toBe(1000);
    expect(clock.getSnapshot().pendingStartedAt).toBe(1500);
    clock.observe("synced", false, null);
    expect(clock.getSnapshot()).toMatchObject({
      phaseStartedAt: 1750,
      pendingStartedAt: null,
      hasEverSynced: true,
    });
    expect(vi.getTimerCount()).toBe(0);
    clock.observe("connecting", false, null);
    expect(clock.getSnapshot().hasEverSynced).toBe(true);
    unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("ticks a synced structural wait only while an observer is mounted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const clock = createBlockDocumentSyncClock("synced", false, 900);
    const listener = vi.fn();
    const release = clock.subscribe(listener);
    vi.advanceTimersByTime(250);
    expect(clock.getSnapshot().now).toBe(1250);
    expect(listener).toHaveBeenCalledOnce();
    release();
    expect(vi.getTimerCount()).toBe(0);
    const releaseAgain = clock.subscribe(listener);
    clock.observe("destroyed", false, 900);
    expect(vi.getTimerCount()).toBe(0);
    releaseAgain();
  });
});
