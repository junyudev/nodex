/**
 * What a provider reports about the account behind an API key connection: a prepaid balance, a
 * plan's usage windows, or both. Main reads it with the connection's key, which never leaves Main;
 * windows show only what the provider said.
 */
export interface ProviderKeyUsage {
  readonly connectionId: string;
  /** Epoch milliseconds of the latest answer; null until one arrives. */
  readonly observedAt: number | null;
  /** The latest read failed; `balance` and `windows` are the previous reading, if there was one. */
  readonly readFailed: boolean;
  /** A prepaid balance; null when the provider reports none for this key. */
  readonly balance: ProviderKeyBalance | null;
  /** A plan's usage windows, such as five hours and a week; empty without a plan. */
  readonly windows: readonly ProviderKeyUsageWindow[];
}

export interface ProviderKeyBalance {
  /** What can still be spent, in the currency's major unit; zero or less is used up. */
  readonly amount: number;
  /** An ISO 4217 code, such as `CNY` or `USD`. */
  readonly currency: string;
}

export interface ProviderKeyUsageWindow {
  /** Stable within a provider, such as `five_hour` or `weekly`. */
  readonly id: string;
  /** 0 to 100. */
  readonly usedPercent: number;
  readonly durationMins: number | null;
  /** Epoch milliseconds; null when the provider did not say. */
  readonly resetsAt: number | null;
}

/** Every enabled connection whose provider can report usage for its key. */
export interface ProviderKeyUsageSnapshot {
  readonly connections: readonly ProviderKeyUsage[];
}

/** A connection's rail meter preference in the Profile's usage meter settings. */
export const providerKeyMeterPreference = (connectionId: string): string =>
  `apiKey:${connectionId}`;
