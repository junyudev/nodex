import { expect, test } from "vite-plus/test";
import { startScriptedChatCompletionsServer } from "./scripted-chat-completions-server";

test("scripts a streaming tool request and its result, and rejects other routes", async () => {
  const server = await startScriptedChatCompletionsServer(({ messages }) => {
    const result = messages.find(({ tool_call_id }) => tool_call_id === "browser");
    return result
      ? { text: `Saw ${result.content}` }
      : { tool: "node_repl_js", id: "browser", arguments: { code: "2 + 2" } };
  });
  try {
    const send = (messages: unknown[]) =>
      fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model: "fixture", stream: true, messages }),
      });
    const first = await send([{ role: "user", content: "Run JavaScript" }]);
    expect(first.headers.get("content-type")).toBe("text/event-stream");
    const [call, finish, done] = (await first.text()).trim().split("\n\n");
    expect(JSON.parse(call!.slice(6)).choices[0].delta.tool_calls).toEqual([
      {
        index: 0,
        id: "browser",
        type: "function",
        function: {
          name: "node_repl_js",
          arguments: '{"code":"2 + 2"}',
        },
      },
    ]);
    expect(JSON.parse(finish!.slice(6)).choices[0].finish_reason).toBe("tool_calls");
    expect(done).toBe("data: [DONE]");
    const second = await send([{ role: "tool", tool_call_id: "browser", content: "4" }]);
    expect(await second.text()).toContain("Saw 4");
    expect((await fetch(`${server.baseUrl}/models`)).status).toBe(400);
    expect(server.errors).toEqual(["Error: Unexpected model route: GET /v1/models"]);
  } finally {
    await server.close();
  }
});
