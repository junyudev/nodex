/** The Runtime's application MCP server, registered under this name for every provider. */
export const NODEX_APP_MCP_SERVER = "nodex_app";

export const SESSION_SINGLE_WAIT_DEFAULT_MS = 10 * 60_000;
export const SESSION_SINGLE_WAIT_MAX_MS = 60 * 60_000;
export const SESSION_MULTI_WAIT_DEFAULT_MS = 2 * 60_000;
export const SESSION_MULTI_WAIT_MAX_MS = 2 * 60_000;
/** Ordinary tools retain their bounded call lifetime; waits own a separate semantic deadline. */
export const APP_TOOLS_CALL_TIMEOUT_MS = 185_000;
export const APP_TOOLS_WAIT_REPLY_GRACE_MS = 60_000;
export const APP_TOOLS_PIPE_REPLY_GRACE_MS = 5_000;
/** A provider must leave time for the host and private pipe to deliver the wait's final read. */
export const APP_TOOLS_PROVIDER_TIMEOUT_MS =
  SESSION_SINGLE_WAIT_MAX_MS + APP_TOOLS_WAIT_REPLY_GRACE_MS + 2 * APP_TOOLS_PIPE_REPLY_GRACE_MS;

export const sessionWaitLimits = (targetCount: number) =>
  targetCount === 1
    ? { defaultMs: SESSION_SINGLE_WAIT_DEFAULT_MS, maximumMs: SESSION_SINGLE_WAIT_MAX_MS }
    : { defaultMs: SESSION_MULTI_WAIT_DEFAULT_MS, maximumMs: SESSION_MULTI_WAIT_MAX_MS };

/** Transport admission only derives a lifetime; the public tool schema validates the arguments. */
export const appToolsHostCallTimeoutMs = (
  name: string,
  args: Readonly<Record<string, unknown>>,
): number => {
  if (name !== "wait_sessions" || !Array.isArray(args.targets)) return APP_TOOLS_CALL_TIMEOUT_MS;
  if (args.targets.length < 1 || args.targets.length > 8) return APP_TOOLS_CALL_TIMEOUT_MS;
  const limits = sessionWaitLimits(args.targets.length);
  const requested =
    typeof args.timeoutMs === "number" && Number.isSafeInteger(args.timeoutMs)
      ? Math.max(0, Math.min(limits.maximumMs, args.timeoutMs))
      : limits.defaultMs;
  return Math.max(APP_TOOLS_CALL_TIMEOUT_MS, requested + APP_TOOLS_WAIT_REPLY_GRACE_MS);
};

/**
 * Providers respell server names (`nodex_app`, `nodex-app`, `nodexapp`), so
 * loose matches use this pattern and stay gated on the known tool inventory.
 */
export const NODEX_APP_MCP_SERVER_PATTERN = "nodex[-_ ]?app";

const NODEX_APP_MCP_SERVER_NAME = new RegExp(`^${NODEX_APP_MCP_SERVER_PATTERN}$`, "i");

/** Whether a provider-reported MCP server name is the Runtime's application server. */
export function isNodexAppMcpServer(server: string): boolean {
  return NODEX_APP_MCP_SERVER_NAME.test(server.trim());
}

/**
 * Tools the Runtime serves itself on `nodex_app`. Host Session and content tools
 * share the server but are attached at runtime from the host's catalog.
 */
export const NODEX_APP_TASK_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_agent_models",
  "delegate_task",
  "task_status",
  "task_wait",
  "task_send",
  "task_read",
  "task_cancel",
  "stop_workflow",
]);

const NAMESPACED_TOOL = new RegExp(
  `^(?<server>${NODEX_APP_MCP_SERVER_PATTERN})(?:[.:/]|\\s*·\\s*)(?<tool>.+)$`,
  "i",
);
const PREFIXED_TOOL = new RegExp(
  `^(?:mcp[-_]{1,2})?${NODEX_APP_MCP_SERVER_PATTERN}(?:__|[-_.:/ ])(?<tool>.+)$`,
  "i",
);
const PER_THREAD_SERVER = new RegExp(`^${NODEX_APP_MCP_SERVER_PATTERN}-`, "i");

function normalizeToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

/**
 * Providers disagree on how they prefix MCP tools: `mcp__nodex_app__x`
 * (Claude), `nodex_app.x` (Codex), `nodex_app_x` (OpenCode 1),
 * `nodex_app-<thread>_x` (OpenCode 2) and assorted separators from ACP agents.
 * Loose prefixes only count for a known Runtime tool.
 */
function resolveToolName(value: string): string | null {
  const label = normalizeToolLabel(value);
  const qualified = /^mcp__(?<server>.+?)__(?<tool>.+)$/i.exec(label);
  if (qualified?.groups) {
    const { server, tool } = qualified.groups;
    return server !== undefined && tool !== undefined && isNodexAppMcpServer(server) ? tool : null;
  }
  const namespaced = NAMESPACED_TOOL.exec(label);
  if (namespaced?.groups) return namespaced.groups.tool ?? null;

  const candidate = PREFIXED_TOOL.exec(label)?.groups?.tool ?? label;
  if (NODEX_APP_TASK_TOOL_NAMES.has(candidate)) return candidate;
  // OpenCode 2 joins its per-thread server to the tool with `_`. Thread ids can
  // hold `_` too, so take the longest known tool name that ends the label.
  if (!PER_THREAD_SERVER.test(label)) return null;
  let longest: string | null = null;
  for (const tool of NODEX_APP_TASK_TOOL_NAMES) {
    if (label.endsWith(`_${tool}`) && tool.length > (longest?.length ?? 0)) longest = tool;
  }
  return longest;
}

/** The bare Runtime tool name (`delegate_task`) for any provider's spelling of it. */
export function resolveNodexAppTaskTool(toolName: string | null | undefined): string | null {
  const name = toolName == null ? null : resolveToolName(toolName);
  return name !== null && NODEX_APP_TASK_TOOL_NAMES.has(name) ? name : null;
}
