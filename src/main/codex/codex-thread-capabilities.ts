import type { ThreadStartParams } from "@nodex/codex-app-server-protocol/v2/ThreadStartParams";
/** Local feature defaults only. Remote execution assignments are materialized per app-server. */
export const CODEX_DEFAULT_FEATURE_OVERRIDES = {} as const satisfies Record<string, true>;

export function buildCodexThreadConfigOverrides(): NonNullable<ThreadStartParams["config"]> {
  return Object.fromEntries(
    Object.entries(CODEX_DEFAULT_FEATURE_OVERRIDES).map(([key, value]) => [
      `features.${key}`,
      value,
    ]),
  ) as NonNullable<ThreadStartParams["config"]>;
}
