type ClaudeAgentSdk = typeof import("@anthropic-ai/claude-agent-sdk");
let loaded: Promise<ClaudeAgentSdk> | undefined;

/** Provider discovery and execution share one SDK import, acquired only when Claude is used. */
export const loadClaudeAgentSdk = (): Promise<ClaudeAgentSdk> =>
  (loaded ??= import("@anthropic-ai/claude-agent-sdk"));
