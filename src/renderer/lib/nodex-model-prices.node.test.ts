import { describe, expect, it } from "vite-plus/test";
import type { NodexModelPricing } from "../../shared/nodex-account";
import {
  formatNodexCreditPrice,
  hasNodexListPriceRow,
  nodexModelPriceRows,
  visibleNodexPriceColumns,
} from "./nodex-model-prices";

const LIST = { input: 5, cacheRead: 0.5, cacheWrite: null, output: 30 };
const HALF = { input: 2.5, cacheRead: 0.25, cacheWrite: null, output: 15 };
const CLAUDE = { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 };

const offer = (
  id: string,
  reference: typeof LIST | typeof CLAUDE,
  effective = reference,
  multiplier: number | null = 1,
) => ({
  id,
  label: id,
  provider: "openai",
  reference,
  effective,
  multiplier,
});
const pricing = (...groups: NodexModelPricing["groups"]): NodexModelPricing => ({
  currency: "USD",
  perTokens: 1_000_000,
  notes: [],
  groups,
});
const group = (id: string, ...models: NodexModelPricing["groups"][number]["models"]) => ({
  id,
  label: id,
  description: null,
  available: true,
  models,
});

describe("nodexModelPriceRows", () => {
  it("leaves list-price rows unmarked and lets the header state ×1", () => {
    const rows = nodexModelPriceRows(pricing(group("nodex", offer("sol", LIST))));
    expect(rows[0]?.rows[0]).toMatchObject({ multiplier: null, crossesOutReference: false });
    expect(hasNodexListPriceRow(rows)).toBe(true);
  });

  it("marks a rate on the only group and crosses out the list price nothing else shows", () => {
    const rows = nodexModelPriceRows(pricing(group("nodex", offer("sol", LIST, HALF, 0.5))));
    expect(rows[0]?.rows[0]).toMatchObject({
      multiplier: 0.5,
      groupLabel: null,
      crossesOutReference: true,
    });
    expect(hasNodexListPriceRow(rows)).toBe(false);
  });

  it("names a separate group and spares the crossing out when a list row is right above", () => {
    const rows = nodexModelPriceRows(
      pricing(group("nodex", offer("sol", LIST)), group("saver", offer("sol", LIST, HALF, 0.5))),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rows).toMatchObject([
      { groupLabel: null, multiplier: null, crossesOutReference: false },
      { groupLabel: "saver", multiplier: 0.5, crossesOutReference: false },
    ]);
  });

  it("leaves out a model the server has no price for", () => {
    const unpriced = { input: null, cacheRead: null, cacheWrite: null, output: null };
    const rows = nodexModelPriceRows(
      pricing(group("nodex", offer("sol", LIST), { ...offer("luna", LIST), effective: unpriced })),
    );
    expect(rows.map(({ id }) => id)).toEqual(["sol"]);
  });

  it("claims no rate when no single factor explains the prices", () => {
    const uneven = { ...HALF, output: 30 };
    const rows = nodexModelPriceRows(pricing(group("nodex", offer("sol", LIST, uneven, null))));
    expect(rows[0]?.rows[0]).toMatchObject({ multiplier: null, crossesOutReference: true });
    // A crossed-out row isn't at list price, so the header makes no ×1 claim for it.
    expect(hasNodexListPriceRow(rows)).toBe(false);
  });
});

describe("visibleNodexPriceColumns", () => {
  it("drops a column no model has a price for", () => {
    const keys = (value: NodexModelPricing) =>
      visibleNodexPriceColumns(value).map(({ key }) => key);
    expect(keys(pricing(group("nodex", offer("sol", LIST))))).toEqual([
      "input",
      "cacheRead",
      "output",
    ]);
    expect(keys(pricing(group("nodex", offer("sol", LIST), offer("opus", CLAUDE))))).toEqual([
      "input",
      "cacheRead",
      "cacheWrite",
      "output",
    ]);
  });
});

describe("formatNodexCreditPrice", () => {
  it.each([
    [5, "125"],
    [0.5, "12.5"],
    [0.075, "1.88"],
    [30, "750"],
    [null, "—"],
  ])("formats %s USD at 25 credits per dollar as %s", (usd, expected) => {
    expect(formatNodexCreditPrice(usd, 25)).toBe(expected);
  });
});
