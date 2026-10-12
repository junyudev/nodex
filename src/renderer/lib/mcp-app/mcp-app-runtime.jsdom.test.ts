import { act } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { resolveMcpWidgetMetadata } from "../../../shared/mcp-app/mcp-app-resource-contract";
import { McpAppRuntime } from "./mcp-app-runtime";

const { api } = vi.hoisted(() => ({
  api: {
    runWidgetCode: vi.fn(async function* (_input: unknown) {
      yield { type: "environment_status", status: 2 };
    }),
    notifyMcpAppsHostContext: vi.fn(async (_input: unknown) => undefined),
    requestMcpAppsResourceTeardown: vi.fn(async (_input: unknown) => undefined),
    setTheme: vi.fn(async (_input: unknown) => undefined),
    setWidgetView: vi.fn(async (_input: unknown) => undefined),
    setSafeArea: vi.fn(async (_input: unknown) => undefined),
    setAdditionalGlobals: vi.fn(async (_input: unknown) => undefined),
  },
}));

vi.mock("./mcp-app-port-rpc", () => ({
  connectMcpAppSandbox: async () => ({ api, dispose: vi.fn() }),
}));
vi.mock("./mcp-app-host-styles", () => ({
  readMcpAppHostStyleVariables: () => ({
    "--color-text-info": document.documentElement.style.getPropertyValue("--app-color-text-accent"),
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  document.documentElement.style.colorScheme = "light";
  document.documentElement.style.setProperty("--app-color-text-accent", "#2451da");
});

afterEach(() => {
  document.documentElement.removeAttribute("style");
});

test("sends resolved host styles initially and refreshes an attached App when only accent changes", async () => {
  const runtime = new McpAppRuntime({
    capabilityId: "app-theme-test",
    currentToolName: "calendar",
    resource: {
      uri: "ui://calendar/widget",
      mode: "html",
      html: "<main />",
      mimeType: "text/html",
      metadata: { ...resolveMcpWidgetMetadata(null), heightHint: null },
    },
    server: "calendar",
    statuses: {
      data: [
        {
          name: "calendar",
          runtimeStatus: null,
          pluginId: null,
          httpOrigin: null,
          serverInfo: null,
          serverCapabilities: null,
          tools: { calendar: { name: "calendar", inputSchema: { type: "object" } } },
          toolsError: null,
          resources: [],
          resourceTemplates: [],
          authStatus: "unsupported",
        },
      ],
      nextCursor: null,
    },
    threadId: "thread-1",
    toolInput: {},
    toolResult: null,
  });
  document.body.append(runtime.element);

  try {
    await vi.waitFor(() => {
      expect(runtime.getSnapshot().error).toBeNull();
      expect(runtime.getSnapshot().status).toBe("ready");
    });
    expect(api.runWidgetCode.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        mcpApps: expect.objectContaining({
          hostContext: expect.objectContaining({
            theme: "light",
            styles: { variables: { "--color-text-info": "#2451da" } },
          }),
        }),
      }),
    );

    await act(async () => {
      document.documentElement.style.setProperty("--app-color-text-accent", "#055f51");
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(api.notifyMcpAppsHostContext).toHaveBeenLastCalledWith({
        hostContext: expect.objectContaining({
          theme: "light",
          styles: { variables: { "--color-text-info": "#055f51" } },
        }),
      }),
    );
    expect(api.runWidgetCode).toHaveBeenCalledTimes(1);

    await runtime.dispose();
    const notifications = api.notifyMcpAppsHostContext.mock.calls.length;
    await act(async () => {
      document.documentElement.style.setProperty("--app-color-text-accent", "#af1fa7");
      await Promise.resolve();
    });
    expect(api.notifyMcpAppsHostContext).toHaveBeenCalledTimes(notifications);
  } finally {
    await runtime.dispose();
  }
});
