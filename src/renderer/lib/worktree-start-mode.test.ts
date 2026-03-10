import { describe, expect, test } from "bun:test";
import { readWorktreeStartMode, writeWorktreeStartMode } from "./worktree-start-mode";

const mockStorage = {
  store: new Map<string, string>(),
  getItem(key: string) {
    return this.store.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    this.store.set(key, value);
  },
  clear() {
    this.store.clear();
  },
};

describe("worktree start mode setting", () => {
  test("defaults to detachedHead and persists known values", () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: mockStorage,
    });
    mockStorage.clear();

    expect(readWorktreeStartMode()).toBe("detachedHead");
    expect(writeWorktreeStartMode("detachedHead")).toBe("detachedHead");
    expect(readWorktreeStartMode()).toBe("detachedHead");

    if (originalDescriptor) {
      Object.defineProperty(globalThis, "localStorage", originalDescriptor);
      return;
    }
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
});
