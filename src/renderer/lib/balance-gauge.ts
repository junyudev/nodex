import { useEffect } from "react";

/**
 * A prepaid balance as of its last top-up and now. A balance has no full mark of its own, so its
 * meter measures what is left of the last top-up; a top-up refills it.
 */
export interface BalanceGauge {
  readonly baseline: number;
  readonly balance: number;
}

export function nextBalanceGauge(previous: BalanceGauge | null, balance: number): BalanceGauge {
  const refilled = !previous || previous.baseline <= 0 || balance > previous.balance + 0.125;
  return { baseline: refilled ? Math.max(balance, 0) : previous.baseline, balance };
}

/** What is left of the last top-up, as a whole percentage. */
export const balanceGaugePercent = (gauge: BalanceGauge): number =>
  gauge.baseline > 0
    ? Math.round(Math.max(0, Math.min(1, gauge.balance / gauge.baseline)) * 100)
    : 0;

const GAUGE_KEY_PREFIX = "nodex.balance-gauge:";

export function readBalanceGauge(key: string): BalanceGauge | null {
  try {
    return JSON.parse(
      window.localStorage.getItem(GAUGE_KEY_PREFIX + key) ?? "null",
    ) as BalanceGauge | null;
  } catch {
    return null;
  }
}

/**
 * Keeps each balance's gauge across windows and restarts; it is presentation, not a ledger. Every
 * new balance continues from the last stored gauge, written after render.
 */
export function useBalanceGauges(
  balances: readonly { readonly key: string; readonly balance: number }[],
): ReadonlyMap<string, BalanceGauge> {
  const gauges = new Map(
    balances.map(({ key, balance }) => [key, nextBalanceGauge(readBalanceGauge(key), balance)]),
  );
  const stored = JSON.stringify([...gauges]);
  useEffect(() => {
    for (const [key, gauge] of JSON.parse(stored) as [string, BalanceGauge][])
      window.localStorage.setItem(GAUGE_KEY_PREFIX + key, JSON.stringify(gauge));
  }, [stored]);
  return gauges;
}
