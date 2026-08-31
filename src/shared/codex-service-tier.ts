import type { CodexExecutionProfile } from "./codex-execution-profile";

const STANDARD_SERVICE_TIER_ALIASES = new Set(["default", "standard"]);

/**
 * Projects app-server service-tier values into Nodex's domain model.
 *
 * The app-server uses `"default"` as the wire/config sentinel for an explicitly
 * selected standard tier. Nodex represents that same selection as `null`.
 */
export function normalizeCodexServiceTier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return STANDARD_SERVICE_TIER_ALIASES.has(normalized.toLocaleLowerCase()) ? null : normalized;
}

export function normalizeCodexExecutionProfile(
  profile: CodexExecutionProfile,
): CodexExecutionProfile {
  return { ...profile, serviceTier: normalizeCodexServiceTier(profile.serviceTier) };
}
