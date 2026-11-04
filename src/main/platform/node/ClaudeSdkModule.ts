import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentRuntimeEntrypoint } from "./AgentRuntimeEntrypoint";

/** Packaged Main and its history workers share the verified standalone SDK closure. */
export function claudeSdkModuleUrl(input: Parameters<typeof agentRuntimeEntrypoint>[0]): string {
  const sdkRoot = input.isPackaged ? dirname(agentRuntimeEntrypoint(input)) : input.projectRootPath;
  return pathToFileURL(join(sdkRoot, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs")).href;
}
