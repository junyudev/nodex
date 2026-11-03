import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentRuntimeEntrypoint } from "./AgentRuntimeEntrypoint";

/** Packaged Main and its history workers share the verified standalone SDK closure. */
export function claudeSdkModuleUrl(input: Parameters<typeof agentRuntimeEntrypoint>[0]): string {
  const modulePath = input.isPackaged
    ? join(
        dirname(agentRuntimeEntrypoint(input)),
        "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
      )
    : createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
  return pathToFileURL(modulePath).href;
}
