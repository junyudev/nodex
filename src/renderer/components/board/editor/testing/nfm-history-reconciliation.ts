import type { NfmHistoryReconciliation } from "../nfm-history-reconciliation";

/** Routing/gesture fixtures whose Core inverse executor is also substituted. */
export const availableHistoryReconciliation: NfmHistoryReconciliation = {
  read: async (_scope, tokens) => ({
    commitSeq: 0,
    items: tokens.map((token) => ({ token, state: "available" })),
  }),
  subscribe: () => () => undefined,
};
