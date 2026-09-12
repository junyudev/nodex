import { describe, expect, test } from "vite-plus/test";
import { CodexRendererViewRegistry } from "./codex-renderer-view-registry";

describe("CodexRendererViewRegistry", () => {
  test("routes presentation to the most recently presented renderer", () => {
    const registry = new CodexRendererViewRegistry();

    registry.setPresented("thread-1", "renderer-1", "surface-1", true);
    registry.setPresented("thread-1", "renderer-2", "surface-2", true);
    expect(registry.resolvePresentedSurfaceClient("thread-1")).toBe("renderer-2");

    registry.setPresented("thread-1", "renderer-1", "surface-1", false);
    registry.setPresented("thread-1", "renderer-1", "surface-3", true);
    expect(registry.resolvePresentedSurfaceClient("thread-1")).toBe("renderer-1");
  });

  test("falls back to another visible renderer when the latest client leaves", () => {
    const registry = new CodexRendererViewRegistry();
    registry.setPresented("thread-1", "renderer-1", "surface-1", true);
    registry.setPresented("thread-1", "renderer-2", "surface-2", true);

    registry.setPresented("thread-1", "renderer-2", "surface-2", false);

    expect(registry.resolvePresentedSurfaceClient("thread-1")).toBe("renderer-1");
  });

  test("removes every view owned by a disposed client without affecting peers", () => {
    const registry = new CodexRendererViewRegistry();
    registry.setPresented("thread-1", "renderer-1", "surface-1", true);
    registry.setPresented("thread-2", "renderer-1", "surface-2", true);
    registry.setPresented("thread-2", "renderer-2", "surface-3", true);

    expect(registry.removeClient("renderer-1")).toEqual(["thread-1", "thread-2"]);
    expect(registry.resolvePresentedSurfaceClient("thread-1")).toBeNull();
    expect(registry.resolvePresentedSurfaceClient("thread-2")).toBe("renderer-2");

    registry.clearConversation("thread-2");
  });

  test("requires a surface and a focused client for foreground presentation", () => {
    const registry = new CodexRendererViewRegistry();

    registry.setClientForegrounded("renderer-1", true);
    expect(registry.isPresentedInForeground("thread-1")).toBe(false);

    registry.setPresented("thread-1", "renderer-1", "surface-1", true);
    expect(registry.isPresentedInForeground("thread-1")).toBe(true);

    registry.setClientForegrounded("renderer-1", false);
    expect(registry.isPresentedInForeground("thread-1")).toBe(false);

    registry.setClientForegrounded("renderer-2", true);
    registry.setPresented("thread-1", "renderer-2", "surface-2", true);
    expect(registry.isPresentedInForeground("thread-1")).toBe(true);

    registry.removeClient("renderer-2");
    expect(registry.isPresentedInForeground("thread-1")).toBe(false);
  });

  test("keeps a conversation presented until every client surface leaves", () => {
    const registry = new CodexRendererViewRegistry();
    registry.setClientForegrounded("renderer-1", true);
    registry.setPresented("thread-1", "renderer-1", "surface-1", true);
    registry.setPresented("thread-1", "renderer-1", "surface-2", true);

    registry.setPresented("thread-1", "renderer-1", "surface-1", false);
    expect(registry.isClientPresenting("thread-1", "renderer-1")).toBe(true);
    expect(registry.isPresentedInForeground("thread-1")).toBe(true);

    registry.setPresented("thread-1", "renderer-1", "surface-2", false);
    expect(registry.isClientPresenting("thread-1", "renderer-1")).toBe(false);
    expect(registry.isPresentedInForeground("thread-1")).toBe(false);
  });

  test("repeated surface reports preserve the most recently presented client", () => {
    const registry = new CodexRendererViewRegistry();
    registry.setPresented("thread-1", "renderer-1", "surface-1", true);
    registry.setPresented("thread-1", "renderer-2", "surface-2", true);
    registry.setPresented("thread-1", "renderer-1", "surface-1", true);
    registry.setPresented("thread-1", "renderer-1", "surface-3", true);
    expect(registry.resolvePresentedSurfaceClient("thread-1")).toBe("renderer-2");

    registry.clearConversation("thread-1");
    expect(registry.resolvePresentedSurfaceClient("thread-1")).toBeNull();
    expect(registry.isClientPresenting("thread-1", "renderer-1")).toBe(false);
  });
});
