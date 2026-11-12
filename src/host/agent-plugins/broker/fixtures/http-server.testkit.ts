import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { json } from "node:stream/consumers";
import { JSONRPCRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as Effect from "effect/Effect";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, resolve: release };
}

const tool = (name: string) => ({ name, inputSchema: { type: "object" as const } });

export const httpFixture = Effect.acquireRelease(
  Effect.promise(async () => {
    const seen: IncomingMessage["headers"][] = [];
    const started = latch();
    const disconnected = latch();
    const reply = latch();
    const replied = latch();
    const calls: string[] = [];
    const sessionId = "upstream-only";
    const server = createServer(async (request, response) => {
      seen.push(request.headers);
      if (request.method === "DELETE") return response.writeHead(200).end();
      if (request.method !== "POST") return response.writeHead(405).end();
      if (request.headers.authorization !== "Bearer from-host-secret-port")
        return response.writeHead(401).end();
      const parsed = JSONRPCRequestSchema.safeParse(await json(request));
      if (!parsed.success) return response.writeHead(202).end();
      const { id, method, params } = parsed.data;
      const name = String(params?.name ?? "");
      if (method === "tools/call") calls.push(name);
      if (name === "hang") {
        response.once("close", disconnected.resolve);
        started.resolve();
        await Promise.race([reply.promise, disconnected.promise]);
        if (response.destroyed) return;
        response.once("finish", replied.resolve);
      }
      const result = method === "initialize"
        ? {
            protocolVersion: params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "http-fixture", version: "1" },
          }
        : method === "tools/list"
          ? { tools: [tool("inspect"), tool("hang")] }
          : { content: [{ type: "text", text: "from HTTP" }], _meta: { sessionId } };
      return response.writeHead(200, {
        "content-type": "application/json",
        ...(method === "initialize" && { "mcp-session-id": sessionId }),
      }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture failed to listen");
    return {
      url: "http://127.0.0.1:" + address.port + "/mcp",
      server, seen, started: started.promise, disconnected: disconnected.promise, calls,
      reply: reply.resolve, replied: replied.promise,
    };
  }),
  ({ server }) => Effect.callback<void>((resume) => {
    server.close(() => resume(Effect.void));
    server.closeAllConnections();
  }),
);
