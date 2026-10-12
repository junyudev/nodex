import type { CodexAppServerCapabilitySnapshot } from "../codex-runtime/CodexAppServerCapabilities";

/** History readers and live reducers share the policy of the admitted physical host. */
export const canUseCodexThreadTimeline = (
  capability: CodexAppServerCapabilitySnapshot,
  enabled: boolean | null | undefined,
): boolean =>
  capability.hostId !== "durable" && capability.flags.threadTimeline && enabled === true;
