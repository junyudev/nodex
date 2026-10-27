import type { MarketplaceAddParams } from "@nodex/codex-app-server-protocol/v2/MarketplaceAddParams";

export interface AddMarketplaceFormValues {
  readonly source: string;
  readonly refName: string;
  readonly sparsePaths: string;
}

/**
 * Reads the Add marketplace form: a required source, an optional Git ref, and sparse paths
 * separated by newlines or commas. The marketplace owner parses the source itself.
 */
export function parseAddMarketplaceForm(
  values: AddMarketplaceFormValues,
): MarketplaceAddParams | null {
  const source = values.source.trim();
  if (source.length === 0) return null;
  const refName = values.refName.trim();
  const sparsePaths = values.sparsePaths
    .split(/[\n,]/u)
    .map((path) => path.trim())
    .filter((path) => path.length > 0);
  return {
    source,
    refName: refName.length > 0 ? refName : null,
    sparsePaths: sparsePaths.length > 0 ? sparsePaths : null,
  };
}
