/**
 * OpenCode internals the server's replay testkits and live tests drive
 * directly: the 2.x client, server, adapter, and text generation, plus the
 * 1.x transcript identifiers.
 *
 * @module provider-opencode/testing
 */
export {
  OPENCODE_DEFAULT_INSTANCE_ID,
  OPENCODE_PROVIDER,
  OPENCODE_SDK_PROTOCOL,
} from "./server/adapter.ts";
export { OPENCODE_2_STILL_STOPPING, nodexAppMcpServerName } from "./server/v2/adapter.ts";
export {
  source as nativeExecutionPluginSource,
  sourceV1 as nativeExecutionPluginSourceV1,
  environment as nativeExecutionPluginEnvironment,
} from "./server/NativeExecutionPlugin.ts";
