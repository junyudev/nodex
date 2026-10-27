import { z } from "zod";
import definition from "../desktop-mcp.json";
export {
  APP_TOOLS_CALL_TIMEOUT_MS,
  APP_TOOLS_PIPE_REPLY_GRACE_MS,
  APP_TOOLS_PROVIDER_TIMEOUT_MS,
  appToolsHostCallTimeoutMs,
  sessionWaitLimits,
} from "@t3tools/shared/nodexAppMcp";

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

/** The bundled definition advertises enough time for the longest supported tool call. */
export const appToolsManifest = manifestSchema.parse(definition);
