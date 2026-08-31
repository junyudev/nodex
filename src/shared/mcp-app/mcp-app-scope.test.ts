import { describe, expect, test } from "vite-plus/test";
import type { ProtocolListMcpServerStatusResponse } from "../types";
import {
  createMcpAppScopeSnapshot,
  requireMcpAppScopedResource,
  requireMcpAppScopedTool,
} from "./mcp-app-scope";

function statuses(server = "calendar"): ProtocolListMcpServerStatusResponse {
  return {
    data: [
      {
        name: server,
        runtimeStatus: null,
        pluginId: null,
        serverInfo: null,
        authStatus: "unsupported",
        resources: [{ name: "widget", uri: "ui://calendar/widget" }],
        resourceTemplates: [],
        tools: {
          list: {
            name: "list",
            inputSchema: { type: "object" },
            _meta: { ui: { resourceUri: "ui://calendar/widget" } },
          },
          upload: {
            name: "upload",
            inputSchema: { type: "object" },
            _meta: { "openai/fileParams": ["file"] },
          },
        },
      },
    ],
    nextCursor: null,
  };
}

describe("MCP App scope", () => {
  test("removes tools that accept file parameters", () => {
    const scope = createMcpAppScopeSnapshot({
      currentToolName: "list",
      originResourceUri: "ui://calendar/widget",
      server: "calendar",
      statuses: statuses(),
      threadId: "thread-1",
    });

    expect([...scope.allowedTools.keys()]).toEqual(["list"]);
    expect(() => requireMcpAppScopedTool(scope, "upload")).toThrow(/outside its scope/u);
  });

  test("binds codex_apps resources to the origin widget", () => {
    const scope = createMcpAppScopeSnapshot({
      currentToolName: "list",
      originResourceUri: "ui://calendar/widget",
      server: "codex_apps",
      statuses: statuses("codex_apps"),
      threadId: "thread-1",
    });

    expect(() => requireMcpAppScopedResource(scope, "ui://other/widget")).toThrow(
      /outside its widget scope/u,
    );
  });

  test("scopes codex_apps tools to the trusted connector target", () => {
    const data = statuses("codex_apps");
    const server = data.data[0];
    if (!server) throw new Error("Missing test server");
    server.tools = {
      origin: {
        name: "origin",
        inputSchema: { type: "object" },
        _meta: {
          connectorId: "calendar",
          _codex_apps: { resource_uri: "/calendar/account-a/origin" },
        },
      },
      sibling: {
        name: "sibling",
        inputSchema: { type: "object" },
        _meta: {
          connectorId: "calendar",
          _codex_apps: { resource_uri: "/calendar/account-a/sibling" },
        },
      },
      otherTarget: {
        name: "otherTarget",
        inputSchema: { type: "object" },
        _meta: {
          connectorId: "calendar",
          _codex_apps: { resource_uri: "/calendar/account-b/other" },
        },
      },
    };
    const scope = createMcpAppScopeSnapshot({
      currentToolName: "origin",
      originResourceUri: "ui://calendar/widget",
      server: "codex_apps",
      statuses: data,
      threadId: "thread-1",
    });

    expect([...scope.allowedTools.keys()]).toEqual(["origin", "sibling"]);
    expect(() => requireMcpAppScopedTool(scope, "otherTarget")).toThrow(/outside its scope/u);
  });
});
