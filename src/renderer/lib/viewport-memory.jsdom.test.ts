import { beforeEach, describe, expect, test } from "vite-plus/test";
import { createViewportMemory } from "./viewport-memory";

const decode = (value: unknown) =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { top?: unknown }).top === "number"
    ? (value as { top: number })
    : null;

describe("createViewportMemory", () => {
  beforeEach(() => localStorage.clear());

  test("keeps a saved place across a fresh memory, but a remembered one only for this window", () => {
    const first = createViewportMemory({ storageKey: "test-viewport", decode });
    first.remember("hot", { top: 1 });
    first.save("saved", { top: 2 });
    expect(first.load("hot")).toEqual({ top: 1 });

    const relaunched = createViewportMemory({ storageKey: "test-viewport", decode });
    expect(relaunched.load("saved")).toEqual({ top: 2 });
    expect(relaunched.load("hot")).toBeNull();
  });

  test("drops the oldest places beyond its bound and anything it cannot read", () => {
    localStorage.setItem("test-viewport", JSON.stringify({ broken: { top: "x" } }));
    const memory = createViewportMemory({ storageKey: "test-viewport", decode, maxEntries: 2 });
    memory.save("a", { top: 1 });
    memory.save("b", { top: 2 });
    memory.save("c", { top: 3 });
    const relaunched = createViewportMemory({ storageKey: "test-viewport", decode, maxEntries: 2 });
    expect(relaunched.load("broken")).toBeNull();
    expect(relaunched.load("a")).toBeNull();
    expect(relaunched.load("c")).toEqual({ top: 3 });
    memory.forget("c");
    expect(createViewportMemory({ storageKey: "test-viewport", decode }).load("c")).toBeNull();
  });
});
