/** These packages cannot remain runtime require calls in Electron's CommonJS Main output. */
export const BUNDLED_ELECTRON_MAIN_DEPENDENCIES = [
  "@agentclientprotocol/sdk",
  "@nodex/effect-codex-app-server",
  "@nodex/app-tools-mcp",
  "@opencode-ai/sdk",
] as const;
