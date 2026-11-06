// A real MCP peer for adapter wiring tests, deliberately independent of the vendored runtime.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
const server = new Server({ name: "desktop-tools-fixture", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "js", inputSchema: { type: "object" } }] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (params.arguments?.elicitation) {
    const answer = await server.request({ method: "elicitation/create", params: params.arguments.elicitation }, ElicitResultSchema);
    return { content: [{ type: "text", text: JSON.stringify(answer) }], structuredContent: answer };
  }
  return { content: [{ type: "text", text: "ok" }], structuredContent: { pid: process.pid } };
});
await server.connect(new StdioServerTransport());
