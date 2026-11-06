import http from "node:http";
type ContentBlockParam =
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "text"; text: string };
type MessageParam = {
  role: string;
  content:
    | string
    | {
        type: string;
        tool_use_id?: string;
        content?: unknown;
        text?: string;
        is_error?: boolean;
      }[];
};
type Tool = { name: string; description?: string; input_schema: unknown };

export interface AnthropicRequest {
  readonly model: string;
  readonly stream?: boolean;
  readonly messages: MessageParam[];
  readonly tools: (Tool & { defer_loading?: boolean })[];
  readonly system?: unknown;
}

/** Real Claude CLI model boundary. Unexpected traffic fails closed; no upstream forwarding. */
export async function startScriptedAnthropicServer(
  respond: (request: AnthropicRequest) => ContentBlockParam | Promise<ContentBlockParam>,
) {
  const requests: AnthropicRequest[] = [];
  const paths: string[] = [];
  const errors: string[] = [];
  const server = http.createServer(async (request, response) => {
    try {
      paths.push(request.url ?? "");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 16_000_000) throw new Error("Oversized scripted Messages request");
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AnthropicRequest;
      if (request.url?.startsWith("/v1/messages/count_tokens")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ input_tokens: 100 }));
        return;
      }
      if (!request.url?.match(/^\/v1\/messages(?:\?|$)/u)) {
        throw new Error(`Unexpected Claude endpoint: ${request.method} ${request.url}`);
      }
      requests.push(body);
      const block = await respond(body);
      const isTool = block.type === "tool_use";
      const message = {
        id: `msg_scripted_${requests.length}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 10 },
      };
      if (!body.stream) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ...message,
            content: [block],
            stop_reason: isTool ? "tool_use" : "end_turn",
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type: string, fields: object) =>
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
      send("message_start", { message });
      send("content_block_start", {
        index: 0,
        content_block: isTool ? { ...block, input: {} } : { type: "text", text: "" },
      });
      send("content_block_delta", {
        index: 0,
        delta: isTool
          ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
          : { type: "text_delta", text: block.type === "text" ? block.text : "" },
      });
      send("content_block_stop", { index: 0 });
      send("message_delta", {
        delta: { stop_reason: isTool ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: 10 },
      });
      send("message_stop", {});
      response.end();
    } catch (error) {
      errors.push(String(error));
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ type: "error", error: { type: "api_error", message: String(error) } }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No scripted Anthropic port");
  return {
    requests,
    paths,
    errors,
    environment: {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      ANTHROPIC_API_KEY: "nodex-loopback-test-key",
      ANTHROPIC_AUTH_TOKEN: "",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      CLAUDE_CODE_ENABLE_TELEMETRY: "0",
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      ALL_PROXY: "",
      http_proxy: "",
      https_proxy: "",
      all_proxy: "",
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function anthropicToolResult(request: AnthropicRequest, id: string) {
  return request.messages
    .flatMap((message) => (typeof message.content === "string" ? [] : message.content))
    .find((block) => block.type === "tool_result" && block.tool_use_id === id);
}
