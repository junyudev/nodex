import { createServer } from "node:http";
import { z } from "zod";

const requestSchema = z.object({
  model: z.string(),
  stream: z.literal(true),
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.unknown(),
      tool_call_id: z.string().optional(),
    }),
  ),
  tools: z
    .array(
      z.object({
        function: z.object({ name: z.string(), description: z.string().optional() }),
      }),
    )
    .optional(),
});

export type ChatCompletionRequest = z.infer<typeof requestSchema>;
type ChatCompletionReply =
  | { text: string }
  | { tool: string; id: string; arguments: Record<string, unknown> };

/** A loopback-only streaming model. Every request must be answered by the script. */
export async function startScriptedChatCompletionsServer(
  reply: (request: ChatCompletionRequest) => ChatCompletionReply | Promise<ChatCompletionReply>,
) {
  const errors: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        throw new Error(`Unexpected model route: ${request.method} ${request.url}`);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 8 * 1024 * 1024) throw new Error("Model request exceeds fixture limit");
        chunks.push(bytes);
      }
      const input = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const result = await reply(input);
      const delta =
        "tool" in result
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: result.id,
                  type: "function",
                  function: { name: result.tool, arguments: JSON.stringify(result.arguments) },
                },
              ],
            }
          : { content: result.text };
      const event = (delta: object, finish_reason: string | null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-nodex-fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: input.model,
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        event({ role: "assistant", ...delta }, null) +
          event({}, "tool" in result ? "tool_calls" : "stop") +
          "data: [DONE]\n\n",
      );
    } catch (error) {
      errors.push(String(error));
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Unexpected scripted model request" } }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Scripted model has no port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    errors,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
