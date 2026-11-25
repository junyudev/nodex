import { describe, expect, test } from "vite-plus/test";
import {
  BlockDisclosureStateStore,
  MemoryBlockDisclosurePersistence,
  browserBlockDisclosurePersistence,
  type BlockDisclosurePersistence,
} from "./block-disclosure-state";
import { toggledStateStorageKey } from "@blocknote/core";

describe("BlockDisclosureStateStore", () => {
  test("rehydrates stable Block disclosure preferences across store lifetimes", () => {
    const persistence = new MemoryBlockDisclosurePersistence();
    const firstLifetime = new BlockDisclosureStateStore(persistence);

    firstLifetime.setExpanded("card-shell", true);
    expect(new BlockDisclosureStateStore(persistence).isExpanded("card-shell")).toBe(true);

    firstLifetime.setExpanded("card-shell", false);
    expect(new BlockDisclosureStateStore(persistence).isExpanded("card-shell")).toBe(false);
  });

  test("keeps separate reference Block occurrences independent", () => {
    const store = new BlockDisclosureStateStore();
    let firstNotifications = 0;
    let secondNotifications = 0;
    store.subscribe("card-ref-1", () => {
      firstNotifications += 1;
    });
    store.subscribe("card-ref-2", () => {
      secondNotifications += 1;
    });

    store.setExpanded("card-ref-1", true);
    store.setExpanded("card-ref-1", true);

    expect(store.isExpanded("card-ref-1")).toBe(true);
    expect(store.isExpanded("card-ref-2")).toBe(false);
    expect(firstNotifications).toBe(1);
    expect(secondNotifications).toBe(0);
  });

  test("keeps a collapsed default-expanded Block collapsed across store lifetimes", () => {
    const persistence = new MemoryBlockDisclosurePersistence();
    const store = new BlockDisclosureStateStore(persistence);
    let notifications = 0;
    store.subscribe("page-ref", () => {
      notifications += 1;
    });

    expect(store.isExpanded("page-ref", true)).toBe(true);
    store.setExpanded("page-ref", false);

    expect(store.isExpanded("page-ref", true)).toBe(false);
    expect(new BlockDisclosureStateStore(persistence).isExpanded("page-ref", true)).toBe(false);
    expect(notifications).toBe(1);
  });

  test("falls back to live renderer state when persistence is unavailable", () => {
    const unavailablePersistence: BlockDisclosurePersistence = {
      read: () => {
        throw new Error("unavailable");
      },
      write: () => {
        throw new Error("full");
      },
    };
    const store = new BlockDisclosureStateStore(unavailablePersistence);

    store.setExpanded("card-shell", true);

    expect(store.isExpanded("card-shell")).toBe(true);
  });

  test("shares the same browser-local key contract as native BlockNote toggles", () => {
    const blockId = "disclosure-storage-contract";
    const storageKey = toggledStateStorageKey(blockId);
    localStorage.removeItem(storageKey);
    try {
      const firstLifetime = new BlockDisclosureStateStore(browserBlockDisclosurePersistence);
      firstLifetime.setExpanded(blockId, true);

      expect(localStorage.getItem(storageKey)).toBe("true");
      expect(
        new BlockDisclosureStateStore(browserBlockDisclosurePersistence).isExpanded(blockId),
      ).toBe(true);
    } finally {
      localStorage.removeItem(storageKey);
    }
  });
});
