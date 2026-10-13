import { describe, expect, test, vi } from "vite-plus/test";
import { resolveMcpWidgetMetadata } from "../../../shared/mcp-app/mcp-app-resource-contract";
import type { McpAppRuntimeConfig } from "./mcp-app-runtime";
import {
  McpAppRuntimeManager,
  type McpAppRuntimePort,
  type McpAppSurfaceMode,
} from "./mcp-app-runtime-manager";

function config(capabilityId = "capability-1"): McpAppRuntimeConfig {
  return {
    capabilityId,
    currentToolName: "list",
    resource: {
      uri: "ui://calendar/widget",
      mode: "html",
      html: "<main />",
      mimeType: "text/html",
      metadata: {
        ...resolveMcpWidgetMetadata(null),
        heightHint: null,
      },
    },
    server: "calendar",
    statuses: { data: [], nextCursor: null },
    threadId: "thread-1",
    toolInput: {},
    toolResult: null,
  };
}

function fakeRuntime(): McpAppRuntimePort & {
  modes: McpAppSurfaceMode[];
  dispose: ReturnType<typeof vi.fn>;
} {
  const modes: McpAppSurfaceMode[] = [];
  return {
    element: document.createElement("div"),
    modes,
    dispose: vi.fn(async () => undefined),
    getSnapshot: () => ({
      diagnostic: null,
      error: null,
      requestedDisplayMode: null,
      status: "ready",
    }),
    setDisplayMode: (mode) => modes.push(mode),
    subscribe: () => () => undefined,
    update: () => undefined,
  };
}

describe("MCP App runtime manager", () => {
  test("notifies capability observers for identity changes and releases only the unused shared runtime", async () => {
    vi.useFakeTimers();
    try {
      const manager = new McpAppRuntimeManager(fakeRuntime);
      const first = vi.fn();
      const second = vi.fn();
      const foreign = vi.fn();
      const unsubscribeFirst = manager.subscribeRuntime("capability-1", first);
      const unsubscribeSecond = manager.subscribeRuntime("capability-1", second);
      const unsubscribeForeign = manager.subscribeRuntime("capability-2", foreign);
      expect(manager.get("capability-1")).toBeNull();
      const initial = config();
      const original = manager.upsert(initial);
      manager.upsert({ ...initial, toolInput: { page: 2 } });
      const other = manager.upsert(config("capability-2"));
      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();
      expect(foreign).toHaveBeenCalledOnce();

      const inline = document.createElement("div");
      const panel = document.createElement("div");
      document.body.append(inline, panel);
      const releaseInline = manager.registerSurface({
        capabilityId: "capability-1",
        element: inline,
        mode: "inline",
        visible: true,
      });
      const releasePanel = manager.registerSurface({
        capabilityId: "capability-1",
        element: panel,
        mode: "side-panel",
        visible: true,
      });
      const restarted = manager.upsert({
        ...initial,
        resource: { ...initial.resource, html: "<main>Updated</main>" },
      });
      expect(restarted).not.toBe(original);
      expect(restarted.element.parentElement).toBe(panel);
      expect(first).toHaveBeenCalledTimes(2);
      expect(second).toHaveBeenCalledTimes(2);
      unsubscribeSecond();
      releasePanel();
      const retried = manager.retry("capability-1");
      expect(retried).not.toBe(restarted);
      expect(retried?.element.parentElement).toBe(inline);
      expect(first).toHaveBeenCalledTimes(3);
      expect(second).toHaveBeenCalledTimes(2);
      releaseInline();
      await vi.advanceTimersByTimeAsync(500);
      expect(manager.get("capability-1")).toBeNull();
      expect(first).toHaveBeenCalledTimes(4);
      expect(second).toHaveBeenCalledTimes(2);
      expect(foreign).toHaveBeenCalledOnce();
      expect(manager.get("capability-2")).toBe(other);
      unsubscribeFirst();
      unsubscribeForeign();
      inline.remove();
      panel.remove();
    } finally {
      vi.useRealTimers();
    }
  });
  test("creates one guest runtime and reparents it to the higher-priority surface", () => {
    const created: ReturnType<typeof fakeRuntime>[] = [];
    const manager = new McpAppRuntimeManager(() => {
      const runtime = fakeRuntime();
      created.push(runtime);
      return runtime;
    });
    const inline = document.createElement("div");
    const sidePanel = document.createElement("div");
    document.body.append(inline, sidePanel);

    const runtime = manager.upsert(config());
    manager.upsert(config());
    const unregisterInline = manager.registerSurface({
      capabilityId: "capability-1",
      element: inline,
      mode: "inline",
      visible: true,
    });
    const unregisterPanel = manager.registerSurface({
      capabilityId: "capability-1",
      element: sidePanel,
      mode: "side-panel",
      visible: true,
    });

    expect(created).toHaveLength(1);
    expect(runtime.element.parentElement).toBe(sidePanel);
    unregisterPanel();
    expect(runtime.element.parentElement).toBe(inline);
    unregisterInline();
    inline.remove();
    sidePanel.remove();
  });

  test("isolates equal resource URIs by capability id", () => {
    const created: McpAppRuntimePort[] = [];
    const manager = new McpAppRuntimeManager(() => {
      const runtime = fakeRuntime();
      created.push(runtime);
      return runtime;
    });

    manager.upsert(config("call-1"));
    manager.upsert(config("call-2"));

    expect(created).toHaveLength(2);
    expect(manager.get("call-1")).not.toBe(manager.get("call-2"));
  });

  test("restarts only when sandbox-defining content changes", () => {
    const created: McpAppRuntimePort[] = [];
    const manager = new McpAppRuntimeManager(() => {
      const runtime = fakeRuntime();
      created.push(runtime);
      return runtime;
    });
    const initial = config();
    manager.upsert(initial);
    manager.upsert({
      ...initial,
      statuses: { ...initial.statuses },
      toolInput: { page: 2 },
    });
    expect(created).toHaveLength(1);

    manager.upsert({
      ...initial,
      resource: { ...initial.resource, html: "<main>updated</main>" },
    });
    expect(created).toHaveLength(2);
  });

  test("retries with a new runtime generation and tears down after a bounded grace", async () => {
    vi.useFakeTimers();
    try {
      const created: ReturnType<typeof fakeRuntime>[] = [];
      const manager = new McpAppRuntimeManager(() => {
        const runtime = fakeRuntime();
        created.push(runtime);
        return runtime;
      });
      const surface = document.createElement("div");
      document.body.append(surface);
      manager.upsert(config());
      const unregister = manager.registerSurface({
        capabilityId: "capability-1",
        element: surface,
        mode: "inline",
        visible: true,
      });

      expect(manager.retry("capability-1")).toBe(created[1]);
      expect(created[0]?.dispose).toHaveBeenCalledOnce();
      unregister();
      await vi.advanceTimersByTimeAsync(499);
      expect(created[1]?.dispose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(created[1]?.dispose).toHaveBeenCalledOnce();
      surface.remove();
    } finally {
      vi.useRealTimers();
    }
  });
});
