import { useSyncExternalStore } from "react";

interface DatabaseRemovalProjection {
  readonly projectId: string;
  readonly storeEpoch: string;
  readonly dataSourceId: string;
  readonly pageIds: readonly string[];
  materialized: boolean;
}

interface LocalStructuralOperation {
  readonly operationId: string;
  readonly sequence: number;
  readonly storeEpoch: string;
  readonly ownedKeys: Set<string>;
  readonly supersededKeys: Set<string>;
  databaseRemoval?: DatabaseRemovalProjection;
  receipt?: {
    readonly storeEpoch: string;
    readonly commitSeq: number;
    readonly resultPageIds: readonly string[];
  };
  targetMaterialized: boolean;
}

const pageKey = (storeEpoch: string, pageId: string): string => `page:${storeEpoch}:${pageId}`;

/**
 * Presentation authority for cross-surface structural transactions.
 *
 * Core remains the durable owner. This registry only decides which local
 * predicted revision may still be shown while Core and bounded projections
 * converge. A later operation permanently supersedes an older operation for
 * the same Page identity, so an old receipt cannot resurrect stale UI.
 */
export class LocalStructuralTransactionPresentationStore {
  private readonly listeners = new Set<() => void>();
  private readonly operations = new Map<string, LocalStructuralOperation>();
  private readonly owners = new Map<string, string>();
  private nextSequence = 1;
  private revision = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): number => this.revision;

  begin = (operationId: string, storeEpoch: string): void => {
    const existing = this.operations.get(operationId);
    if (existing) {
      if (existing.storeEpoch !== storeEpoch)
        throw new Error("A structural operation cannot cross Store generations");
      return;
    }
    this.operations.set(operationId, {
      operationId,
      sequence: this.nextSequence++,
      storeEpoch,
      ownedKeys: new Set(),
      supersededKeys: new Set(),
      targetMaterialized: false,
    });
  };

  beginDatabasePageMove = (input: {
    readonly operationId: string;
    readonly projectId: string;
    readonly storeEpoch: string;
    readonly dataSourceId: string;
    readonly pageIds: readonly string[];
  }): void => {
    this.begin(input.operationId, input.storeEpoch);
    const operation = this.require(input.operationId);
    this.claimPageIds(input.operationId, input.storeEpoch, input.pageIds);
    operation.databaseRemoval = {
      projectId: input.projectId,
      storeEpoch: input.storeEpoch,
      dataSourceId: input.dataSourceId,
      pageIds: [...input.pageIds],
      materialized: false,
    };
    this.changed();
  };

  claimPageIds = (operationId: string, storeEpoch: string, pageIds: readonly string[]): boolean => {
    this.begin(operationId, storeEpoch);
    const operation = this.require(operationId);
    const result = this.claimPageIdsForOperation(operation, storeEpoch, pageIds);
    if (result.changed) this.changed();
    return result.ownsAll;
  };

  private claimPageIdsForOperation(
    operation: LocalStructuralOperation,
    storeEpoch: string,
    pageIds: readonly string[],
  ): { readonly ownsAll: boolean; readonly changed: boolean } {
    let ownsAll = true;
    let changed = false;
    for (const pageId of pageIds) {
      const key = pageKey(storeEpoch, pageId);
      if (operation.supersededKeys.has(key)) {
        ownsAll = false;
        continue;
      }
      const currentId = this.owners.get(key);
      if (currentId === operation.operationId) continue;
      const current = currentId ? this.operations.get(currentId) : undefined;
      if (current && current.sequence > operation.sequence) {
        operation.supersededKeys.add(key);
        ownsAll = false;
        changed = true;
        continue;
      }
      if (current) {
        current.ownedKeys.delete(key);
        current.supersededKeys.add(key);
      }
      this.owners.set(key, operation.operationId);
      operation.ownedKeys.add(key);
      changed = true;
    }
    return { ownsAll, changed };
  }

  replacePageClaims = (input: {
    readonly operationId: string;
    readonly storeEpoch: string;
    readonly previousPageIds: readonly string[];
    readonly nextPageIds: readonly string[];
  }): boolean => {
    const operation = this.operations.get(input.operationId);
    if (!operation || operation.storeEpoch !== input.storeEpoch) return false;
    // A planner-to-receipt identity handoff is one ownership transaction. Subscribers
    // must never observe the old claims released before the receipt claims are owned.
    const nextKeys = new Set(input.nextPageIds.map((pageId) => pageKey(input.storeEpoch, pageId)));
    let changed = false;
    for (const pageId of input.previousPageIds) {
      const key = pageKey(input.storeEpoch, pageId);
      if (nextKeys.has(key)) continue;
      if (this.owners.get(key) !== input.operationId) continue;
      this.owners.delete(key);
      operation.ownedKeys.delete(key);
      changed = true;
    }
    const claimed = this.claimPageIdsForOperation(operation, input.storeEpoch, input.nextPageIds);
    if (changed || claimed.changed) this.changed();
    return claimed.ownsAll;
  };

  ownsPage = (operationId: string, storeEpoch: string, pageId: string): boolean =>
    this.owners.get(pageKey(storeEpoch, pageId)) === operationId;

  acknowledge = (input: {
    readonly operationId: string;
    readonly storeEpoch: string;
    readonly commitSeq: number;
    readonly resultPageIds: readonly string[];
  }): void => {
    const operation = this.operations.get(input.operationId);
    if (!operation || operation.storeEpoch !== input.storeEpoch) return;
    operation.receipt = {
      storeEpoch: input.storeEpoch,
      commitSeq: input.commitSeq,
      resultPageIds: [...input.resultPageIds],
    };
    this.changed();
  };

  reject = (operationId: string): void => {
    this.release(operationId);
  };

  markTargetMaterialized = (operationId: string): void => {
    const operation = this.operations.get(operationId);
    if (!operation || operation.targetMaterialized) return;
    operation.targetMaterialized = true;
    this.maybeRelease(operation);
    this.changed();
  };

  observeDatabaseProjection = (input: {
    readonly projectId: string;
    readonly storeEpoch: string;
    readonly dataSourceId: string;
    readonly commitSeq: number;
    readonly pageIds: ReadonlySet<string>;
  }): void => {
    let changed = false;
    for (const operation of [...this.operations.values()]) {
      const removal = operation.databaseRemoval;
      const receipt = operation.receipt;
      if (!removal || removal.materialized || !receipt) continue;
      if (
        removal.projectId !== input.projectId ||
        removal.storeEpoch !== input.storeEpoch ||
        removal.dataSourceId !== input.dataSourceId ||
        receipt.storeEpoch !== input.storeEpoch ||
        input.commitSeq < receipt.commitSeq ||
        removal.pageIds.some((pageId) => input.pageIds.has(pageId))
      )
        continue;
      removal.materialized = true;
      this.maybeRelease(operation);
      changed = true;
    }
    if (changed) this.changed();
  };

  hiddenDatabasePageIds = (input: {
    readonly projectId: string;
    readonly storeEpoch: string;
    readonly dataSourceId: string;
  }): ReadonlySet<string> => {
    const hidden = new Set<string>();
    for (const operation of this.operations.values()) {
      const removal = operation.databaseRemoval;
      if (
        !removal ||
        removal.materialized ||
        removal.projectId !== input.projectId ||
        removal.storeEpoch !== input.storeEpoch ||
        removal.dataSourceId !== input.dataSourceId
      )
        continue;
      for (const pageId of removal.pageIds) {
        if (this.ownsPage(operation.operationId, input.storeEpoch, pageId)) hidden.add(pageId);
      }
    }
    return hidden;
  };

  release = (operationId: string): void => {
    const operation = this.operations.get(operationId);
    if (!operation) return;
    for (const key of operation.ownedKeys) {
      if (this.owners.get(key) === operationId) this.owners.delete(key);
    }
    this.operations.delete(operationId);
    this.changed();
  };

  private require(operationId: string): LocalStructuralOperation {
    const operation = this.operations.get(operationId);
    if (!operation) throw new Error("Structural operation is not registered");
    return operation;
  }

  private maybeRelease(operation: LocalStructuralOperation): void {
    const sourceMaterialized = !operation.databaseRemoval || operation.databaseRemoval.materialized;
    if (!sourceMaterialized || !operation.targetMaterialized) return;
    for (const key of operation.ownedKeys) {
      if (this.owners.get(key) === operation.operationId) this.owners.delete(key);
    }
    this.operations.delete(operation.operationId);
  }

  private changed(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }
}

export const localStructuralTransactionPresentation =
  new LocalStructuralTransactionPresentationStore();

export const useHiddenDatabasePageIds = (input: {
  readonly projectId: string;
  readonly storeEpoch: string;
  readonly dataSourceId: string;
}): ReadonlySet<string> => {
  useSyncExternalStore(
    localStructuralTransactionPresentation.subscribe,
    localStructuralTransactionPresentation.getSnapshot,
    localStructuralTransactionPresentation.getSnapshot,
  );
  return localStructuralTransactionPresentation.hiddenDatabasePageIds(input);
};
