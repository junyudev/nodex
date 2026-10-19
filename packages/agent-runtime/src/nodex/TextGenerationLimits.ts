/**
 * The longest a structured generation may run. A request without its own `timeoutMs` runs on its
 * provider's default, which is no longer than this.
 */
export const AGENT_RUNTIME_STRUCTURED_GENERATION_MAX_TIMEOUT_MS = 180_000;
