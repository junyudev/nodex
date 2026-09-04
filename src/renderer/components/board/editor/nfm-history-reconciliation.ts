import type { ContentAccessContext } from "../../../../shared/content-access-context";
import {
  MAX_STRUCTURAL_HISTORY_RECONCILIATION_TOKENS,
  type LibraryStructuralHistoryState,
  type LibraryStructuralHistoryToken,
} from "../../../../shared/library-module";
import { readLibraryModule } from "../../../lib/api";
import { resolveRendererTransport } from "../../../lib/renderer-transport";

export interface NfmHistoryReconciliationScope {
  readonly libraryId: string;
  readonly storeEpoch: string;
  readonly accessContext: ContentAccessContext;
}

export interface NfmHistoryReconciliationSnapshot {
  readonly commitSeq: number;
  readonly items: readonly LibraryStructuralHistoryState[];
}

/** Core alone decides recipe lifecycle; projection delivery is a repair signal. */
export interface NfmHistoryReconciliation {
  read(
    scope: NfmHistoryReconciliationScope,
    tokens: readonly LibraryStructuralHistoryToken[],
  ): Promise<NfmHistoryReconciliationSnapshot>;
  subscribe(scope: NfmHistoryReconciliationScope, invalidate: () => void): () => void;
}

export const coreHistoryReconciliation: NfmHistoryReconciliation = {
  async read(scope, tokens) {
    if (tokens.length > MAX_STRUCTURAL_HISTORY_RECONCILIATION_TOKENS)
      throw new Error("History reconciliation exceeds its token bound.");
    const result = await readLibraryModule(scope.accessContext, {
      read: { mode: "structural_history_states", tokens },
    });
    if (!result.ok) throw new Error(result.error.message);
    const snapshot = result.value;
    if (
      snapshot.libraryId !== scope.libraryId ||
      snapshot.storeEpoch !== scope.storeEpoch ||
      snapshot.value.kind !== "structural_history_states"
    )
      throw new Error("History reconciliation returned another authority scope.");
    return { commitSeq: snapshot.commitSeq, items: snapshot.value.items };
  },
  subscribe(scope, invalidate) {
    return resolveRendererTransport().subscribeProjectionStream(
      {
        ...scope.accessContext,
        libraryId: scope.libraryId,
      },
      (message) => {
        if (
          message.kind === "effect" &&
          message.delivery.effect.scope.scope.kind !== "structural_history"
        )
          return;
        invalidate();
      },
    );
  },
};
