import { describe, expect, it } from "vite-plus/test";
import { readToolOutputImage } from "@nodex/runtime-shared/toolOutput";
import { claudeMcpToolCall } from "./ClaudeMcpToolCall.ts";

const input = {
  toolName: "mcp__node_repl__js",
  nativeItemId: "tool-use-1",
  arguments: { code: "capture()" },
  status: "completed",
  startedAtMs: 100,
  updatedAtMs: 350,
} as const;

describe("Claude MCP tool calls", () => {
  it.each([
    {
      content: [{ type: "text", text: "Captured" }],
      structuredContent: { width: 1200 },
      _meta: { "codex/toolSurface": { kind: "browserUse", backend: "iab" } },
    },
    [{ type: "text", text: "Captured" }],
    "Captured",
  ])("normalizes result envelopes: %j", (output) => {
    const call = claudeMcpToolCall({ ...input, output });
    expect(call).toMatchObject({
      type: "mcpToolCall",
      id: "tool-use-1",
      server: "node_repl",
      tool: "js",
      arguments: input.arguments,
      status: "completed",
      durationMs: 250,
      error: null,
      result: { content: [{ type: "text", text: "Captured" }] },
    });
    if (!Array.isArray(output) && typeof output === "object") {
      expect(call?.result?.structuredContent).toEqual(output.structuredContent);
      expect(call?.result?._meta).toEqual(output._meta);
    }
  });

  it("converts Anthropic images, preserving block metadata and subsequent content positions", () => {
    const output = {
      content: [
        { type: "text", text: "Before" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "AQID" },
          _meta: { detail: "original" },
        },
        { type: "text", text: "[Image: source: /temporary/session/tool-results/shot.png]" },
        { type: "text", text: "Between" },
        { type: "image", mimeType: "image/jpeg", data: "BAUG" },
        { type: "text", text: "[Image: source: C:\\temporary\\tool-results\\shot.jpg]" },
      ],
      _meta: { retained: true },
    };
    expect(claudeMcpToolCall({ ...input, output })?.result).toEqual({
      content: [
        output.content[0],
        { type: "image", mimeType: "image/png", data: "AQID", _meta: { detail: "original" } },
        output.content[3],
        output.content[4],
      ],
      structuredContent: null,
      _meta: output._meta,
    });
    expect(output.content).toHaveLength(6);
  });

  it.each([
    "[Image: source: /tmp/shot.png]",
    "[Image: source: relative/tool-results/shot.png]",
    " [Image: source: /tmp/tool-results/shot.png]",
    "[Image: source: /tmp/tool-results/shot.png]\nActual output",
    "[Image: source: /tmp/tool-results/shot.png] extra",
    "[Image: source: /tmp/tool-results/shot.png]\n",
  ])("keeps lookalike tool output: %s", (text) => {
    const content = [
      { type: "image", mimeType: "image/png", data: "AQID" },
      { type: "text", text },
    ];
    expect(claudeMcpToolCall({ ...input, output: content })?.result?.content).toEqual(content);
  });

  it("keeps a marker with no preceding image and non-image content intact", () => {
    const content = [
      { type: "text", text: "[Image: source: /tmp/tool-results/shot.png]" },
      { type: "resource_link", uri: "file:///report", name: "Report" },
    ];
    expect(claudeMcpToolCall({ ...input, output: content })?.result?.content).toEqual(content);
  });

  it("normalizes non-raster images without making them servable", () => {
    const call = claudeMcpToolCall({
      ...input,
      output: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/svg+xml", data: "PHN2Zz4=" },
        },
      ],
    });
    expect(call?.result?.content).toEqual([
      { type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" },
    ]);
    expect(readToolOutputImage(call?.result?.content[0])).toBeNull();
  });

  it.each(["isError", "is_error"])("reports result %s as a failure", (key) => {
    const call = claudeMcpToolCall({
      ...input,
      output: { content: "Permission denied", [key]: true },
    });
    expect(call).toMatchObject({
      status: "failed",
      error: { message: "Permission denied" },
      result: { content: [{ type: "text", text: "Permission denied" }] },
    });
  });

  it.each(["running", "failed", "interrupted", "cancelled"] as const)(
    "projects %s with no result",
    (status) => {
      expect(claudeMcpToolCall({ ...input, output: undefined, status })).toMatchObject({
        status: status === "running" ? "inProgress" : "failed",
        result: null,
        error: status === "running" ? null : { message: `Tool call ${status}` },
        durationMs: status === "running" ? null : 250,
      });
    },
  );

  it("splits only the server delimiter", () => {
    expect(
      claudeMcpToolCall({ ...input, output: [], toolName: "mcp__my_server__namespace__tool" }),
    ).toMatchObject({ server: "my_server", tool: "namespace__tool" });
  });

  it.each([
    "Read",
    "mcp__server",
    "mcp____tool",
    "mcp__server__",
    "mcp__nodex_app__read_page",
    "mcp__nodex_app__namespace__tool",
  ])("leaves %s unchanged", (toolName) => {
    expect(claudeMcpToolCall({ ...input, output: "done", toolName })).toBeUndefined();
  });
});
