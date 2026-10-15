/**
 * Every provider registers the Runtime's MCP server as `nodex_app`, the product's
 * application MCP server name. Native call capture and transcript presentation
 * recognize calls by this name.
 */
export { NODEX_APP_MCP_SERVER, isNodexAppMcpServer } from "@t3tools/shared/nodexAppMcp";
