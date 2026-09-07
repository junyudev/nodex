import { appendFile } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAppToolsMcpServer } from "@nodex/app-tools-mcp/server";

const journal = process.env.NODEX_MCP_PROBE_JOURNAL;
if (!journal) throw new Error("The MCP probe requires its disposable journal");
const record = (value: unknown) => appendFile(journal, `${JSON.stringify(value)}\n`);
const server = createAppToolsMcpServer({
  listTools: async () => [
    {
      name: "probe_context",
      description: "Return the isolated Nodex MCP protocol probe marker.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "probe_wait",
      description: "Wait until the isolated protocol probe is cancelled.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
  ],
  callTool: async ({ name, metadata, signal }) => {
    await record({ event: "call", name, metadata });
    if (name === "probe_wait") {
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await record({ event: "cancelled", name });
    }
    const data = { marker: "nodex-mcp-probe", metadata };
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: data,
    };
  },
});
void server.connect(new StdioServerTransport()).catch((error: unknown) => {
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
});
