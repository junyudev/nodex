import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { connectAppToolsPipe } from "./pipe";
import { createAppToolsMcpServer } from "./server";

const main = async () => {
  const descriptor = z
    .strictObject({
      path: z.string().min(1),
      instanceId: z.string().uuid(),
      token: z.string().min(32).max(256),
    })
    .parse({
      path: process.env.NODEX_APP_TOOLS_PIPE,
      instanceId: process.env.NODEX_APP_TOOLS_INSTANCE,
      token: process.env.NODEX_APP_TOOLS_TOKEN,
    });
  const host = await connectAppToolsPipe(descriptor);
  const server = createAppToolsMcpServer(host);
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP SDK exposes a callback property, not EventTarget.
  server.onclose = () => host.close();
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    host.close();
    void server.close();
  };
  process.stdin.once("end", close);
  process.stdin.once("close", close);
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    close();
    throw error;
  }
};
void main().catch(() => {
  process.stderr.write("Nodex application tools are unavailable. Reconnect the task in Nodex.\n");
  process.exitCode = 1;
});
