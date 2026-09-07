import { z } from "zod";
import definition from "../desktop-mcp.json";

const approvalMode = z.enum(["approve", "prompt", "deny"]);
const manifestSchema = z.strictObject({
  mcpServers: z.strictObject({
    nodex_app: z.strictObject({
      command: z.string().min(1),
      args: z.array(z.string()),
      cwd: z.string().min(1),
      enabled: z.boolean(),
      default_tools_approval_mode: approvalMode,
      tools: z.record(z.string(), z.strictObject({ approval_mode: approvalMode })),
      env_vars: z.array(z.string()),
      startup_timeout_sec: z.number().positive(),
      tool_timeout_sec: z.number().positive(),
    }),
  }),
});

/** The bundled definition is shared by the Main launch adapter and standalone timeout. */
export const appToolsManifest = manifestSchema.parse(definition);
export const APP_TOOLS_CALL_TIMEOUT_MS =
  appToolsManifest.mcpServers.nodex_app.tool_timeout_sec * 1000;
