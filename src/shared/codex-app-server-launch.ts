/** Canonical stdio launch grammar for the standalone Codex app-server package. */
export const standaloneCodexAppServerArgs = (): string[] => [
  "--listen",
  "stdio://",
  "--session-source",
  "app-server",
];

/** Canonical stdio launch grammar when a remote host exposes the umbrella `codex` CLI. */
export const codexCliAppServerArgs = (): string[] => [
  "app-server",
  "--listen",
  "stdio://",
  "--session-source",
  "app-server",
];
