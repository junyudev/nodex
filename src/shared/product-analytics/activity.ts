import type { ProductEvent } from "./catalog";

export interface ProductAnalyticsActivityEntry {
  readonly time: number;
  readonly event: ProductEvent;
}

/** Everything a person needs to verify what Nodex reports about their installation. */
export interface ProductAnalyticsActivity {
  readonly active: boolean;
  readonly installationId: string | null;
  /** Fields carried by every event. */
  readonly context: Readonly<Record<string, string>>;
  readonly pending: readonly ProductAnalyticsActivityEntry[];
  readonly sent: readonly ProductAnalyticsActivityEntry[];
}

export interface ProductAnalyticsNotice {
  readonly present: boolean;
}
