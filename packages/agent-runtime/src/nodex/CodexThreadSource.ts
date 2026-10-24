/**
 * Marks native Codex Threads the Runtime creates in the shared Codex home, so the native
 * conversation catalog never offers a Runtime chat's backing Thread for import.
 */
export const AGENT_RUNTIME_CODEX_THREAD_SOURCE = "agent_runtime";

/** Import operation markers remain Runtime-owned in the shared native catalog. */
export const isAgentRuntimeCodexThreadSource = (source: string | null | undefined): boolean =>
  source === AGENT_RUNTIME_CODEX_THREAD_SOURCE ||
  source?.startsWith(`${AGENT_RUNTIME_CODEX_THREAD_SOURCE}:`) === true;
