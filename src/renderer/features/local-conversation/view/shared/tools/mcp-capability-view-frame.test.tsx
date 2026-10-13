import { act, render } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { resolveMcpWidgetMetadata } from "../../../../../../shared/mcp-app/mcp-app-resource-contract";
import { McpAppRuntimeManagerProvider } from "../../../../../lib/mcp-app/mcp-app-runtime-context";
import {
  McpAppRuntimeManager,
  type McpAppRuntimePort,
} from "../../../../../lib/mcp-app/mcp-app-runtime-manager";
import type { McpAppRuntimeConfig } from "../../../../../lib/mcp-app/mcp-app-runtime";
import { McpCapabilityViewFrame } from "./mcp-capability-view-frame";

test("two mounted surfaces follow their capability's replacement runtime and release old subscriptions", async () => {
  vi.useFakeTimers();
  const created: Array<McpAppRuntimePort & { listeners: Set<() => void> }> = [];
  const manager = new McpAppRuntimeManager(() => {
    const listeners = new Set<() => void>();
    const error = created.length === 1 ? new Error("The replacement could not load") : null;
    const snapshot = {
      status: error ? ("error" as const) : ("ready" as const),
      error,
      diagnostic: null,
      requestedDisplayMode: null,
    };
    const runtime = {
      element: document.createElement("div"),
      listeners,
      dispose: vi.fn(async () => {}),
      getSnapshot: () => snapshot,
      setDisplayMode: () => {},
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      update: () => {},
    };
    created.push(runtime);
    return runtime;
  });
  const input: McpAppRuntimeConfig = {
    capabilityId: "shared-capability",
    currentToolName: "list",
    server: "calendar",
    statuses: { data: [], nextCursor: null },
    threadId: "thread",
    toolInput: {},
    toolResult: null,
    resource: {
      uri: "ui://calendar/widget",
      mode: "html",
      html: "<main />",
      mimeType: "text/html",
      metadata: { ...resolveMcpWidgetMetadata(null), heightHint: null },
    },
  };
  const view = render(
    <McpAppRuntimeManagerProvider manager={manager}>
      <NodexTooltipProvider>
        <McpCapabilityViewFrame capabilityId={input.capabilityId} />
        <McpCapabilityViewFrame capabilityId={input.capabilityId} mode="side-panel" />
      </NodexTooltipProvider>
    </McpAppRuntimeManagerProvider>,
  );
  try {
    await act(async () => {
      manager.upsert(input);
    });
    expect(created[0]?.listeners.size).toBe(2);
    await act(async () => {
      manager.upsert({ ...input, resource: { ...input.resource, html: "<main>Updated</main>" } });
    });
    expect(view.getAllByRole("alert")).toHaveLength(2);
    expect(created[0]?.listeners.size).toBe(0);
    expect(created[1]?.listeners.size).toBe(2);
    await act(async () => {
      manager.retry(input.capabilityId);
    });
    expect(view.queryAllByRole("alert")).toHaveLength(0);
    expect(created[1]?.listeners.size).toBe(0);
    expect(created[2]?.listeners.size).toBe(2);
    await act(async () => {
      view.unmount();
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(created[2]?.listeners.size).toBe(0);
    expect(manager.get(input.capabilityId)).toBeNull();
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});
