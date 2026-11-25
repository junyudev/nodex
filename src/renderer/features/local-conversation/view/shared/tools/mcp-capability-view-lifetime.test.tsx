import { useLayoutEffect } from "react";
import { act, render } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { installWindowApi } from "@/test/browser-globals";
import { resolveMcpWidgetMetadata } from "../../../../../../shared/mcp-app/mcp-app-resource-contract";
import { ScopeProvider } from "../../../../../lib/maitai";
import { ComposerScope } from "../../../../../lib/workbench-ui-scopes";
import { McpAppRuntimeManagerProvider } from "../../../../../lib/mcp-app/mcp-app-runtime-context";
import {
  McpAppRuntimeManager,
  type McpAppRuntimePort,
} from "../../../../../lib/mcp-app/mcp-app-runtime-manager";
import type { McpAppRuntimeConfig } from "../../../../../lib/mcp-app/mcp-app-runtime";
import {
  ComposerAppModelContextProvider,
  useComposerAppModelContext,
} from "../../composer/composer-app-model-context";
import { fixture } from "../../conversation-markdown-targets.test-fixtures";
import { McpCapabilityViewFrame } from "./mcp-capability-view-frame";
import { NodexTooltipProvider } from "@/components/ui/tooltip";

test.each(["warm", "after-recipient", "no-composer"] as const)(
  "%s resources keep one sandbox when the real Composer recipient commits",
  async (timing) => {
    installWindowApi({
      invoke: async () => {
        throw new Error("Unsupported fixture request");
      },
      on: () => () => {},
    });
    vi.useFakeTimers();
    const created: Array<{ config: McpAppRuntimeConfig; port: McpAppRuntimePort }> = [];
    const manager = new McpAppRuntimeManager((config) => {
      const snapshot = {
        status: "ready" as const,
        error: null,
        diagnostic: null,
        requestedDisplayMode: null,
      };
      const port = {
        element: document.createElement("div"),
        dispose: vi.fn(async () => {}),
        getSnapshot: () => snapshot,
        setDisplayMode: () => {},
        subscribe: () => () => {},
        update: vi.fn(),
      };
      created.push({ config, port });
      return port;
    });
    const input: McpAppRuntimeConfig = {
      capabilityId: "chart-capability",
      currentToolName: "chart",
      server: "charts",
      statuses: { data: [], nextCursor: null },
      threadId: "thread",
      toolInput: {},
      toolResult: null,
      resource: {
        uri: "ui://charts/widget",
        mode: "html",
        html: "<main>Chart</main>",
        mimeType: "text/html",
        metadata: { ...resolveMcpWidgetMetadata(null), heightHint: null },
      },
    };
    const committed = vi.fn();
    function Composer() {
      const context = useComposerAppModelContext({
        hostId: "local",
        threadId: "thread",
        enabled: true,
      });
      useLayoutEffect(() => {
        if (context.recipient) committed(context.recipient);
      }, [context.recipient]);
      return <output aria-label="Context count">{context.attachments.length}</output>;
    }
    function Content({ ready }: { readonly ready: boolean }) {
      return (
        <McpAppRuntimeManagerProvider manager={manager}>
          <ComposerAppModelContextProvider>
            <McpCapabilityViewFrame
              capabilityId={input.capabilityId}
              resource={ready ? input.resource : undefined}
              runtimeConfig={input}
            />
            {timing !== "no-composer" ? (
              <ScopeProvider
                scope={ComposerScope}
                descriptor={{ identity: "main", focusComposerNonce: null }}
              >
                <Composer />
              </ScopeProvider>
            ) : null}
          </ComposerAppModelContextProvider>
        </McpAppRuntimeManagerProvider>
      );
    }
    const source = fixture("Answer");
    const view = source.mount([], <Content ready={timing !== "after-recipient"} />);
    try {
      if (timing === "no-composer") expect(committed).not.toHaveBeenCalled();
      else expect(committed).toHaveBeenCalled();
      if (timing === "after-recipient") view.rerender(source.rows([], <Content ready />));
      await act(async () => {
        await Promise.resolve();
      });
      expect({
        created: created.length,
        disposed: created.reduce(
          (count, { port }) => count + vi.mocked(port.dispose).mock.calls.length,
          0,
        ),
        identities: created.map(({ config }) => config.modelContext?.identity ?? null),
      }).toEqual({
        created: 1,
        disposed: 0,
        identities: [timing === "no-composer" ? null : expect.any(String)],
      });
      expect(manager.get(input.capabilityId)).toBe(created[0]?.port);
    } finally {
      await act(async () => {
        view.unmount();
        await vi.advanceTimersByTimeAsync(500);
      });
      source.dispose();
      vi.useRealTimers();
    }
  },
);

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
