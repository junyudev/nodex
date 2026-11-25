import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createBlockDocumentSyncClock } from "./block-document-sync-clock";
import {
  appendInlineCardAncestor,
  appendInlineDocumentOwnerAncestor,
  isInlineCardCycle,
  isInlineDocumentOwnerCycle,
} from "./block-reference-runtime-context";
import type { OwnedDocumentDescriptor } from "../../../shared/block-documents";
import type { BlockDocumentSurfaceRuntime } from "@/lib/block-document-surface-runtime";
import type { EditorSurfaceLease } from "@/lib/document-session-registry";
import { PageEditorSessionObservation } from "./page-editor-session-owner";

describe("block document sync clock", () => {
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
});

describe("inline Card reference ancestry", () => {
  test("tracks the open Document path and detects indirect cycles", () => {
    const root = appendInlineCardAncestor([], "card-a");
    const nested = appendInlineCardAncestor(root, "card-b");

    expect(root.join(",")).toBe("card-a");
    expect(nested.join(",")).toBe("card-a,card-b");
    expect(isInlineCardCycle(nested, "card-a")).toBe(true);
    expect(isInlineCardCycle(nested, "card-b")).toBe(true);
    expect(isInlineCardCycle(nested, "card-c")).toBe(false);
    expect(appendInlineCardAncestor(nested, "card-a") === nested).toBe(true);
  });
});

describe("inline owned Document ancestry", () => {
  test("tracks mixed Card and body-only owners without duplicating a path", () => {
    const cardPath = appendInlineDocumentOwnerAncestor([], "card-a");
    const syncedPath = appendInlineDocumentOwnerAncestor(cardPath, "synced-source-a");

    expect(syncedPath.join(",")).toBe("card-a,synced-source-a");
    expect(isInlineDocumentOwnerCycle(syncedPath, "card-a")).toBe(true);
    expect(isInlineDocumentOwnerCycle(syncedPath, "synced-source-a")).toBe(true);
    expect(isInlineDocumentOwnerCycle(syncedPath, "template-b")).toBe(false);
    expect(appendInlineDocumentOwnerAncestor(syncedPath, "synced-source-a") === syncedPath).toBe(
      true,
    );
  });
});

describe("page editor session owner", () => {
  const createLease = (connect = Promise.resolve()) => ({
    claimView: vi.fn(() => 7),
    connect: vi.fn(() => connect),
    releaseView: vi.fn(() => true),
    runtime: {} as BlockDocumentSurfaceRuntime,
  });
  const descriptor = {} as OwnedDocumentDescriptor;

  describe("editor session observation", () => {
    test("publishes a view lease, reads the latest retention policy, and clears its runtime handle", () => {
      const observation = new PageEditorSessionObservation();
      const lease = createLease();
      const registry = {
        acquire: vi.fn(() => lease as unknown as EditorSurfaceLease),
        dispose: vi.fn(async () => {}),
      };
      const runtimeRef = { current: null as BlockDocumentSurfaceRuntime | null };
      let retain = false;
      const listener = vi.fn();
      const unsubscribe = observation.subscribe(listener);
      const detach = observation.attach({
        registry,
        sessionKey: "tab",
        descriptor,
        createRuntime: () => lease.runtime,
        runtimeRef,
        retainModel: () => retain,
      });
      expect(observation.getSnapshot().session).toBe(lease);
      expect(runtimeRef.current).toBe(lease.runtime);
      expect(listener).toHaveBeenCalled();
      retain = true;
      detach();
      expect(lease.releaseView).toHaveBeenCalledWith(7, { retain: true });
      expect(runtimeRef.current).toBeNull();
      expect(registry.dispose).not.toHaveBeenCalled();
      unsubscribe();
    });

    test("disposes previews and ignores a retired connection failure after a replayed attachment", async () => {
      let reject!: (error: Error) => void;
      const retired = createLease(
        new Promise<void>((_, fail) => {
          reject = fail;
        }),
      );
      const active = createLease();
      const registry = {
        acquire: vi.fn().mockReturnValueOnce(retired).mockReturnValueOnce(active),
        dispose: vi.fn(async () => {}),
      };
      const observation = new PageEditorSessionObservation();
      const input = {
        registry,
        sessionKey: "preview",
        descriptor,
        createRuntime: () => active.runtime,
        retainModel: () => false,
      };
      const detach = observation.attach(input);
      detach();
      const detachActive = observation.attach(input);
      reject(new Error("retired connection"));
      await Promise.resolve();
      expect(observation.getSnapshot()).toEqual({ session: active, startupError: null });
      expect(registry.dispose).toHaveBeenCalledWith("preview", retired);
      detachActive();
      expect(registry.dispose).toHaveBeenCalledWith("preview", active);
    });
  });
});
