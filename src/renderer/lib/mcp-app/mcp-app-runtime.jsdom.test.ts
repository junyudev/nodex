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
    notifyMcpAppsToolInput: vi.fn(async (_input: unknown) => undefined),
    notifyMcpAppsToolResult: vi.fn(async (_input: unknown) => undefined),
    notifyMcpAppsMcpNotification: vi.fn(async (_input: unknown) => undefined),
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
          toolListMeta: null,
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
          toolListMeta: null,
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

test("a plugin file app receives its launch input and file capability through the sandbox", async () => {
  const toolInput = {
    file: { name: "weather.fieldnote", resourceUri: "host-resource://lease-file" },
  };
  const request = vi.fn(async () => ({ contents: [] }));
  const runtime = new McpAppRuntime({
    capabilityId: "file-view",
    resource: {
      uri: "ui://notes/view",
      mode: "html",
      html: "<main />",
      mimeType: "text/html",
      metadata: resolveMcpWidgetMetadata(null),
    },
    toolInput,
    toolResult: { content: [] },
    pluginApp: { originKey: "field-notes", fileResource: true, request },
  });
  document.body.append(runtime.element);
  try {
    await vi.waitFor(() =>
      expect(api.notifyMcpAppsToolInput).toHaveBeenCalledWith({ arguments: toolInput }),
    );
    expect(api.runWidgetCode.mock.calls[0]?.[0]).toMatchObject({
      toolInput,
      mcpApps: { hostCapabilities: { experimental: { "openai/resource": {} } } },
    });
    const params = { uri: toolInput.file.resourceUri };
    await expect(connections[0]!.callMcp({ method: "resources/read", params })).resolves.toEqual({
      contents: [],
    });
    expect(request).toHaveBeenCalledWith("resources/read", params);
    runtime.notifyPluginResourceUpdated(params.uri);
    expect(api.notifyMcpAppsMcpNotification).toHaveBeenCalledWith({
      method: "notifications/resources/updated",
      params,
    });
  } finally {
    await runtime.dispose();
  }
});

test("a thread app routes text and context to its conversation callbacks", async () => {
  const sendFollowUpMessage = vi.fn(async () => {});
  const update = vi.fn(() => ({ updateId: "context-1" }));
  const request = vi.fn(async () => ({}));
  const runtime = new McpAppRuntime({
    capabilityId: "thread-view",
    resource: {
      uri: "ui://notes/thread",
      mode: "html",
      html: "<main />",
      mimeType: "text/html",
      metadata: resolveMcpWidgetMetadata(null),
    },
    toolInput: {},
    toolResult: { content: [] },
    pluginApp: { originKey: "notes", fileResource: false, request },
    sendFollowUpMessage,
    modelContext: { identity: "chat", isCurrent: () => true, update },
  });
  document.body.append(runtime.element);
  try {
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe("ready"));
    const { callMcp } = connections[0]!;
    const message = { role: "user", content: [{ type: "text", text: "Read this" }] };
    await expect(callMcp({ method: "ui/message", params: message })).resolves.toEqual({});
    expect(sendFollowUpMessage).toHaveBeenCalledWith({ prompt: "Read this", send: true });
    await expect(
      callMcp({
        method: "ui/message",
        params: { ...message, _meta: { "openai/message": { target: "new" } } },
      }),
    ).rejects.toMatchObject({ code: -32602 });
    const context = { content: [{ type: "text", text: "Selected note" }] };
    await expect(callMcp({ method: "ui/update-model-context", params: context })).resolves.toEqual({
      _meta: { "openai/modelContext": { updateId: "context-1" } },
    });
    expect(update).toHaveBeenCalledWith(context);
    expect(sendFollowUpMessage).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  } finally {
    await runtime.dispose();
  }
});
