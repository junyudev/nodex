import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

/** MCP is a transport adapter. The host owns catalog admission, authorization and execution. */
export interface AppToolsHost {
  listTools(signal: AbortSignal): Promise<Tool[]>;
  callTool(input: {
    name: string;
    arguments: Record<string, unknown>;
    metadata: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<CallToolResult>;
}

export const createAppToolsMcpServer = (host: AppToolsHost): Server => {
  const server = new Server(
    { name: "nodex_app", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => ({
    tools: await host.listTools(extra.signal),
  }));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    host.callTool({
      name: request.params.name,
      arguments: request.params.arguments ?? {},
      metadata: request.params._meta ?? {},
      signal: extra.signal,
    }),
  );
  return server;
};
