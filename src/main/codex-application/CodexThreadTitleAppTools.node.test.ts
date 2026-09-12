import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import { describe, expect, test } from "vite-plus/test";
import {
  promptNeedsThreadTitleAppTools,
  resolveThreadTitleReadOnlyAppToolAllowlist,
} from "./CodexThreadTitleAppTools";

type AppInfo = ClientRequestResponsesByMethod["app/list"]["data"][number];
type McpServerStatus = ClientRequestResponsesByMethod["mcpServerStatus/list"]["data"][number];

const app = (id: string, overrides: Partial<AppInfo> = {}): AppInfo => ({
  id,
  name: id,
  isAccessible: true,
  isEnabled: true,
  pluginDisplayNames: [],
  ...overrides,
});

const server = (name: string, tools: McpServerStatus["tools"]): McpServerStatus =>
  ({
    name,
    tools,
    authStatus: { type: "unsupported" },
    resources: [],
    resourceTemplates: [],
  }) as unknown as McpServerStatus;

const tool = (
  name: string,
  connector: string,
  readOnly: boolean,
  connectorKey: "connectorId" | "connector_id" = "connectorId",
) => ({
  name,
  inputSchema: {},
  annotations: { readOnlyHint: readOnly },
  _meta: { [connectorKey]: connector },
});

describe("Codex thread title app tools", () => {
  test("only inventories prompts that reference app resources or recognized sites", () => {
    expect(promptNeedsThreadTitleAppTools("Fix the login form")).toBe(false);
    expect(promptNeedsThreadTitleAppTools("Summarize app://github")).toBe(true);
    expect(promptNeedsThreadTitleAppTools("Review plugin://github@openai-curated-remote")).toBe(
      true,
    );
    expect(promptNeedsThreadTitleAppTools("Check https://docs.google.com/document/d/abc")).toBe(
      true,
    );
    expect(promptNeedsThreadTitleAppTools("Check https://example.com/document/d/abc")).toBe(false);
  });

  test("allows only accessible enabled connector tools explicitly marked read-only", () => {
    const apps = [
      app("github", { pluginDisplayNames: ["GitHub MCP Server"] }),
      app("google-drive"),
      app("dropbox", { isAccessible: false }),
      app("notion", { isEnabled: false }),
    ];
    const statuses = [
      server("codex_apps", {
        github_search: tool("github_search", "github", true),
        github_get: tool("github_get", "connector-github-mcp-server", true, "connector_id"),
        github_write: tool("github_write", "github", false),
        drive_get: tool("drive_get", "google-drive", true),
        dropbox_get: tool("dropbox_get", "dropbox", true),
      }),
      server("another_server", {
        ignored: tool("ignored", "github", true),
      }),
    ];

    expect(
      resolveThreadTitleReadOnlyAppToolAllowlist({
        prompt:
          "Compare plugin://github@openai-curated-remote with https://docs.google.com/document/d/abc and https://dropbox.com/s/abc",
        apps,
        mcpServerStatuses: statuses,
      }),
    ).toEqual([
      { appId: "github", toolNames: ["github_search", "github_get"] },
      { appId: "google-drive", toolNames: ["drive_get"] },
    ]);
  });
});
