// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const desktopFixtureResult = "Desktop fixture result";

export async function startDesktopMcpFixture(options: {
  readonly authorization: () => string | undefined;
  readonly block?: boolean;
}) {
  const callStarted = Promise.withResolvers<unknown>();
  const callClosed = Promise.withResolvers<void>();
  const methods: string[] = [];
  const server = createServer(async (request, response) => {
    if (
      request.url !== "/mcp/node_repl" ||
      request.headers.authorization !== options.authorization() ||
      request.headers.authorization === undefined
    ) {
      response.writeHead(401).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body) as {
      readonly id?: number | string;
      readonly method: string;
      readonly params?: {
        readonly name?: string;
        readonly arguments?: unknown;
        readonly _meta?: { readonly progressToken?: string };
      };
    };
    methods.push(message.method);
    const reply = (result: unknown) =>
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    switch (message.method) {
      case "initialize":
        reply({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "node_repl", version: "fixture" },
        });
        return;
      case "tools/list":
        reply({ tools: [{ name: "js", inputSchema: { type: "object" } }] });
        return;
      case "tools/call":
        if (message.params?.name !== "js") {
          response.writeHead(400).end();
          return;
        }
        callStarted.resolve(message.params.arguments);
        if (options.block === true) {
          response.once("close", () => callClosed.resolve());
          response.writeHead(200, { "content-type": "text/event-stream" }).flushHeaders();
          const progressToken = message.params._meta?.progressToken;
          if (progressToken !== undefined) {
            response.write(
              `data: ${JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/progress",
                params: { progressToken, progress: 1 },
              })}\n\n`,
            );
          }
          return;
        }
        reply({ content: [{ type: "text", text: desktopFixtureResult }] });
        return;
      default:
        response.writeHead(202).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/node_repl`,
    callStarted: callStarted.promise,
    callClosed: callClosed.promise,
    methods,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      }),
  };
}
