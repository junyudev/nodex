import { describe, expect, test } from "vite-plus/test";
import { projectCodexMcpToolCall } from "./codex-mcp-tool-call";
import {
  decodeCodexWebMcpCalls,
  resolveCodexBrowserPageUrl,
  resolveCodexWebMcpActivities,
} from "./codex-webmcp-tool-call";
import type { ProtocolMcpToolCallItem } from "./types";

const calls = [
  { kind: "listTools", name: "webmcp_list_tools", outputJson: "[]" },
  {
    kind: "invokeTool",
    name: "search_API",
    title: "Search catalog",
    sourceHostname: "example.com",
    inputJson: '{"query":"lamp"}',
    readOnlyHint: true,
    outputJson: "[1,…",
    outputTruncated: true,
  },
] as const;
const metadata = {
  "codex/toolSurface": {
    kind: "browserUse",
    backend: "iab",
    webMcpCalls: [...calls],
    screenshot: { pageUrl: "https://example.com/catalog" },
  },
};

function buildItem(server = "node_repl"): ProtocolMcpToolCallItem {
  return {
    type: "mcpToolCall",
    id: "call-1",
    server,
    tool: "js",
    arguments: {},
    status: "completed",
    result: { content: [], structuredContent: null, _meta: metadata },
    error: null,
    durationMs: 10,
    pluginId: null,
    appContext: null,
    readOnlyHint: null,
  };
}

describe("WebMCP metadata", () => {
  test("retains the ordered list/invoke batch through the protocol projection", () => {
    for (const server of ["node_repl", "cua_repl"]) {
      const projected = projectCodexMcpToolCall(buildItem(server), "completed");
      expect(projected.source).toEqual({ kind: "browserUse", backend: "iab" });
      expect(resolveCodexWebMcpActivities(projected)).toEqual({
        calls,
        fallbackPageUrl: "https://example.com/catalog",
      });
    }
  });

  test("ignores a malformed batch without partially reporting executions", () => {
    for (const invalid of [
      { kind: "invokeTool", name: " " },
      { kind: "listTools", name: "other" },
      { kind: "invokeTool", name: "run", title: "" },
      { kind: "invokeTool", name: "run", inputTruncated: false },
      { kind: "invokeTool", name: "run", outputJson: {} },
    ]) {
      expect(
        decodeCodexWebMcpCalls({
          "codex/toolSurface": { kind: "browserUse", webMcpCalls: [calls[0], invalid] },
        }),
      ).toEqual([]);
    }
  });

  test("only completed browser js success results produce child activities", () => {
    const call = projectCodexMcpToolCall(buildItem(), "completed");
    for (const candidate of [
      { ...call, completed: false },
      { ...call, invocation: { ...call.invocation, server: "browser" } },
      { ...call, invocation: { ...call.invocation, tool: "getState" } },
      { ...call, result: null },
    ])
      expect(resolveCodexWebMcpActivities(candidate).calls).toEqual([]);
  });

  test("uses browser-use URL before screenshot URL and validates the whole URL envelope", () => {
    expect(
      resolveCodexBrowserPageUrl({ ...metadata, browser_use: { url: "https://other.example/" } }),
    ).toBe("https://other.example/");
    expect(
      resolveCodexBrowserPageUrl({ ...metadata, browser_use: { url: "file:///private" } }),
    ).toBeNull();
    expect(
      resolveCodexBrowserPageUrl({ browser_use: { url: "https://other.example/" } }),
    ).toBeNull();
  });
});
