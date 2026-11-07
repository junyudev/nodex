const STANDARD_SERVICE_TIER_ALIASES = new Set(["default", "standard"]);
const FAST_SERVICE_TIER_ALIASES = new Set(["fast", "priority"]);

/**
 * Projects app-server service-tier values into Nodex's domain model.
 *
 * The app-server uses `"default"` as the wire/config sentinel for an explicitly
 * selected standard tier. Nodex represents that same selection as `null`.
 * Catalogs and Threads name the Fast tier `"priority"`, and requests may still
 * call it `"fast"`. Nodex represents both as `"fast"`.
 */
export function normalizeCodexServiceTier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  const alias = normalized.toLocaleLowerCase();
  if (STANDARD_SERVICE_TIER_ALIASES.has(alias)) return null;
  return FAST_SERVICE_TIER_ALIASES.has(alias) ? "fast" : normalized;
}

/** The id a model's catalog gives a tier, or null when the model does not offer it. */
export function offeredCodexServiceTier(offered: readonly string[], tier: string): string | null {
  const wanted = normalizeCodexServiceTier(tier);
  return (
    offered.find((id) => id === tier) ??
    offered.find((id) => normalizeCodexServiceTier(id) === wanted) ??
    null
  );
}
