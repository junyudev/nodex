import { fileURLToPath } from "node:url";

/**
 * The process environment every test run shares, so results do not depend on the machine:
 * UTC time, and git configuration from this repository only. Without it, git fixtures inherit
 * the developer's own settings, and commit signing alone makes them slow and flaky.
 */
export const TEST_ENVIRONMENT = {
  TZ: "UTC",
  GIT_CONFIG_GLOBAL: fileURLToPath(new URL("./test.gitconfig", import.meta.url)),
  GIT_CONFIG_NOSYSTEM: "1",
} as const satisfies Record<string, string>;
