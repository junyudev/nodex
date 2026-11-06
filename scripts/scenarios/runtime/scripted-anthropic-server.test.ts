import { describe, expect, it } from "vitest";
import { startScriptedAnthropicServer } from "./scripted-anthropic-server";

describe("scripted Anthropic model boundary", () => {
  it("streams a tool call with Messages framing, then receives its result", async () => {
    const server = await startScriptedAnthropicServer((request) =>
      request.messages.length === 1
        ? {
            type: "tool_use",
            id: "toolu_fixture",
            name: "mcp__node_repl__js",
            input: { code: "nodeRepl.write(42)" },
          }
        : { type: "text", text: "Done" },
    );
    try {
      const post = (messages: unknown[]) =>
        fetch(`${server.environment.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "fixture", stream: true, messages, tools: [] }),
        });
      const first = await post([{ role: "user", content: "Run JavaScript" }]);
      expect(first.headers.get("content-type")).toBe("text/event-stream");
      const frames = (await first.text())
        .trim()
        .split("\n\n")
        .map((frame) => JSON.parse(frame.split("\ndata: ")[1]!));
      expect(frames.map((frame) => frame.type)).toEqual([
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ]);
      expect(JSON.parse(frames[2].delta.partial_json)).toEqual({ code: "nodeRepl.write(42)" });
      expect(frames[4].delta.stop_reason).toBe("tool_use");
      const final = await post([
        { role: "user", content: "Run JavaScript" },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_fixture", content: "42" }],
        },
      ]);
      expect(await final.text()).toContain('"text":"Done"');
      expect(server.requests).toHaveLength(2);
      expect(server.errors).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("fails closed on unexpected CLI traffic", async () => {
    const server = await startScriptedAnthropicServer(() => ({ type: "text", text: "Unused" }));
    try {
      const result = await fetch(`${server.environment.ANTHROPIC_BASE_URL}/api/unexpected`, {
        method: "POST",
        body: "{}",
      });
      expect(result.status).toBe(500);
      expect(server.errors).toHaveLength(1);
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
