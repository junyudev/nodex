import type { NodexModelPricing, NodexTokenPrices } from "../../shared/nodex-account";

export const NODEX_PRICE_COLUMNS = [
  { key: "input", label: "Input" },
  { key: "cacheRead", label: "Cache hit" },
  { key: "cacheWrite", label: "Cache write" },
  { key: "output", label: "Output" },
] as const;

export type NodexPriceKey = (typeof NODEX_PRICE_COLUMNS)[number]["key"];

const samePrices = (left: NodexTokenPrices, right: NodexTokenPrices) =>
  NODEX_PRICE_COLUMNS.every((column) => left[column.key] === right[column.key]);

/** A column earns its place only when some row has a price for it. */
export const visibleNodexPriceColumns = (pricing: NodexModelPricing) =>
  NODEX_PRICE_COLUMNS.filter((column) =>
    pricing.groups.some((group) =>
      group.models.some((model) => model.effective[column.key] !== null),
    ),
  );

export interface NodexPriceRow {
  readonly key: string;
  /** Named only when there is more than one group to tell apart. */
  readonly groupLabel: string | null;
  readonly available: boolean;
  /** The rate to show beside the row; unmarked rows bill at the API list price. */
  readonly multiplier: number | null;
  readonly effective: NodexTokenPrices;
  readonly reference: NodexTokenPrices;
  /** Whether to cross out the list price, unless a row of this model already states it. */
  readonly crossesOutReference: boolean;
}

export interface NodexModelPriceRows {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
  readonly rows: readonly NodexPriceRow[];
}

/** One model, one block: every way to buy it, in the order the server lists its groups. */
export function nodexModelPriceRows(pricing: NodexModelPricing): readonly NodexModelPriceRows[] {
  const named = pricing.groups.length > 1;
  const ids = [...new Set(pricing.groups.flatMap((group) => group.models.map(({ id }) => id)))];
  return ids.flatMap((id) => {
    // A row with nothing to say about cost isn't worth a row of dashes.
    const offers = pricing.groups.flatMap((group) =>
      group.models
        .filter(
          (model) =>
            model.id === id &&
            NODEX_PRICE_COLUMNS.some((column) => model.effective[column.key] !== null),
        )
        .map((model) => ({ group, model })),
    );
    const first = offers[0]?.model;
    if (!first) return [];
    const listed = offers.some(({ model }) => samePrices(model.effective, model.reference));
    return [
      {
        id,
        label: first.label,
        provider: first.provider,
        rows: offers.map(({ group, model }) => {
          const discounted = !samePrices(model.effective, model.reference);
          return {
            key: `${id}:${group.id}`,
            groupLabel: named && discounted ? group.label : null,
            available: group.available,
            multiplier: discounted && model.multiplier !== 1 ? model.multiplier : null,
            effective: model.effective,
            reference: model.reference,
            crossesOutReference: discounted && !listed,
          };
        }),
      },
    ];
  });
}

/** The header's ×1 stands for every unmarked row, so it appears only when one exists. */
export const hasNodexListPriceRow = (models: readonly NodexModelPriceRows[]) =>
  models.some(({ rows }) =>
    rows.some((row) => row.multiplier === null && !row.crossesOutReference),
  );

/** Prices keep what precision they need; only a balance rounds to whole credits. */
export const formatNodexCreditPrice = (usd: number | null, creditsPerUsd: number): string =>
  usd === null
    ? "—"
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(usd * creditsPerUsd);

export const formatNodexUsdPrice = (usd: number): string =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(usd);

export const formatNodexMultiplier = (multiplier: number): string => `×${multiplier}`;

export const formatNodexTokenUnit = (perTokens: number): string =>
  perTokens === 1_000_000 ? "1M" : new Intl.NumberFormat("en-US").format(perTokens);
