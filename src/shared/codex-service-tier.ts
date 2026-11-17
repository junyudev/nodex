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

/** The speeds above Standard, slowest first; a catalog tier outside it matches only itself. */
const CODEX_SPEED_LADDER = ["fast", "ultrafast"] as const;
export type CodexSpeed = (typeof CODEX_SPEED_LADDER)[number];

/** A tier as one of the speeds above Standard, or `null` for Standard and tiers off the ladder. */
export function codexSpeed(value: unknown): CodexSpeed | null {
  const tier = normalizeCodexServiceTier(value);
  return CODEX_SPEED_LADDER.find((speed) => speed === tier) ?? null;
}

/** The speed tiers a model offers, slowest first, by their Nodex names. */
export function codexSpeedTiers(offered: readonly string[]): readonly CodexSpeed[] {
  return CODEX_SPEED_LADDER.filter((tier) => offeredCodexServiceTier(offered, tier) !== null);
}

/**
 * The tier a model runs a carried-over speed at, such as the new-chat default or the previous
 * model's choice: that tier when offered, else the fastest offered tier below it, else
 * Standard (`null`). Returns the catalog's id. Saved choices that must hold exactly are checked
 * with `offeredCodexServiceTier` instead.
 */
export function fitCodexServiceTier(
  offered: readonly string[],
  requested: string | null,
): string | null {
  if (requested === null) return null;
  const exact = offeredCodexServiceTier(offered, requested);
  if (exact !== null) return exact;
  const rung = (CODEX_SPEED_LADDER as readonly string[]).indexOf(
    normalizeCodexServiceTier(requested) ?? "",
  );
  for (let index = rung - 1; index >= 0; index -= 1) {
    const slower = offeredCodexServiceTier(offered, CODEX_SPEED_LADDER[index]!);
    if (slower !== null) return slower;
  }
  return null;
}

/**
 * `fitCodexServiceTier` for a selection, by Nodex name. A model the catalog does not describe
 * keeps the requested tier, so a speed is never lost before the catalog loads.
 */
export function fitCodexServiceTierSelection(
  offered: readonly string[] | undefined,
  requested: string | null,
): string | null {
  const tier = normalizeCodexServiceTier(requested);
  return offered === undefined
    ? tier
    : normalizeCodexServiceTier(fitCodexServiceTier(offered, tier));
}
