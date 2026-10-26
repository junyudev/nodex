import type { PluginContext, PluginMutationResult } from "../codex-plugin-management";

export interface McpAppDataCapabilities {
  readonly available: boolean;
}
/** Profile-wide Electron sandbox data; independent of native agent authentication/readiness. */
export interface McpAppDataIpcApi {
  "mcp-app:data:capabilities": { args: [context: PluginContext]; result: McpAppDataCapabilities };
  "mcp-app:data:clear": { args: [context: PluginContext]; result: PluginMutationResult };
}
