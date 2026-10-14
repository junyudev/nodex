import { act } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { resolveMcpWidgetMetadata } from "../../../shared/mcp-app/mcp-app-resource-contract";
import { McpAppRuntime } from "./mcp-app-runtime";
import type { McpAppHostApiHandlers } from "./mcp-app-port-rpc";

const { api, connections } = vi.hoisted(() => ({
  connections: [] as McpAppHostApiHandlers[],
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
  connectMcpAppSandbox: async (input: { handlers: McpAppHostApiHandlers }) => {
    connections.push(input.handlers);
    return { api, dispose: vi.fn() };
  },
}));
vi.mock("./mcp-app-host-styles", () => ({
  readMcpAppHostStyleVariables: () => ({
    "--color-text-info": document.documentElement.style.getPropertyValue("--app-color-text-accent"),
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  connections.length = 0;
  document.documentElement.style.colorScheme = "light";
  document.documentElement.style.setProperty("--app-color-text-accent", "#2451da");
});

test("advertises model context only for an admitted Composer and rejects retired or absent recipients", async () => {
  const config = {
    capabilityId: "app-context-test",
    currentToolName: "chart",
    server: "charts",
    threadId: "thread-1",
    toolInput: {},
    toolResult: null,
    resource: {
      uri: "ui://chart",
      mode: "html" as const,
      html: "<main />",
      mimeType: "text/html",
      metadata: { ...resolveMcpWidgetMetadata(null), heightHint: null },
    },
    statuses: {
      data: [
        {
          name: "charts",
          runtimeStatus: null,
          pluginId: null,
          httpOrigin: null,
          serverInfo: null,
          serverCapabilities: null,
          tools: { chart: { name: "chart", inputSchema: { type: "object" } } },
          toolsError: null,
          resources: [],
          resourceTemplates: [],
          authStatus: "unsupported" as const,
        },
      ],
      nextCursor: null,
    },
  };
  const absent = new McpAppRuntime(config);
  await vi.waitFor(() => expect(absent.getSnapshot().status).toBe("ready"));
  expect(api.runWidgetCode.mock.calls[0]?.[0]).toMatchObject({
    mcpApps: { forwardedRequestMethods: ["ui/update-model-context"] },
  });
  expect(api.runWidgetCode.mock.calls[0]?.[0]).not.toHaveProperty(
    "mcpApps.hostCapabilities.updateModelContext",
  );
  await expect(
    connections[0]!.callMcp({ method: "ui/update-model-context", params: {} }),
  ).rejects.toMatchObject({ code: -32_601 });
  await absent.dispose();

  let current = true;
  const update = vi.fn(() => ({ updateId: "host-update" }));
  const admitted = new McpAppRuntime({
    ...config,
    modelContext: { identity: "actual-origin", isCurrent: () => current, update },
  });
  try {
    await vi.waitFor(() => expect(admitted.getSnapshot().status).toBe("ready"));
    expect(api.runWidgetCode.mock.calls[1]?.[0]).toMatchObject({
      mcpApps: {
        hostCapabilities: {
          updateModelContext: {
            resource: {},
            resourceLink: {},
            image: {},
            structuredContent: {},
            text: {},
          },
        },
      },
    });
    const request = { method: "ui/update-model-context", params: { content: [] } };
    await expect(connections[1]!.callMcp(request)).resolves.toEqual({
      _meta: { "openai/modelContext": { updateId: "host-update" } },
    });
    expect(update).toHaveBeenCalledExactlyOnceWith(request.params);
    current = false;
    await expect(connections[1]!.callMcp(request)).rejects.toMatchObject({ code: -32_601 });
    expect(update).toHaveBeenCalledTimes(1);
    current = true;
    await admitted.dispose();
    await expect(connections[1]!.callMcp(request)).rejects.toMatchObject({ code: -32_601 });
    expect(update).toHaveBeenCalledTimes(1);
  } finally {
    await admitted.dispose();
  }
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
