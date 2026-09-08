import type { OwnedDocumentDescriptor } from "../../shared/block-documents";
import { contentAccessContextKey } from "../../shared/content-access-context";
import { createInteractionHistory, type InteractionHistory } from "./surface-history/owner";
import { contentEditIssues } from "./content-edit-issues";
import { createContentHistoryIssueSource } from "./content-history-issues";

export type ContentInteractionHistoryScope = Pick<
  OwnedDocumentDescriptor,
  "libraryId" | "accessContext" | "storeEpoch"
>;

export const contentInteractionHistoryScopeKey = (scope: ContentInteractionHistoryScope): string =>
  [scope.libraryId, contentAccessContextKey(scope.accessContext), scope.storeEpoch].join("\0");

interface RealmLease {
  readonly history: InteractionHistory;
  readonly unsubscribe: () => void;
  references: number;
}
const realms = new Map<string, RealmLease>();

/** Runtime participants, not DOM mounts, retain each window-local content timeline. */
export function acquireContentInteractionHistory(scope: ContentInteractionHistoryScope): {
  readonly history: InteractionHistory;
  release(): void;
} {
  const key = contentInteractionHistoryScopeKey(scope);
  let realm = realms.get(key);
  if (!realm) {
    const history = createInteractionHistory({
      scopeKey: key,
      limits: { maxEntries: 500, maxBytes: 64 * 1024 * 1024, maxPending: 101 },
      onError: (error) => console.error("Content history failed", error),
    });
    realm = {
      history,
      unsubscribe: contentEditIssues.register(createContentHistoryIssueSource(scope, history)),
      references: 0,
    };
    realms.set(key, realm);
  }
  const retained = realm;
  retained.references += 1;
  let released = false;
  return {
    history: retained.history,
    release() {
      if (released) return;
      released = true;
      retained.references -= 1;
      if (retained.references !== 0) return;
      realms.delete(key);
      retained.unsubscribe();
      retained.history.close();
    },
  };
}

/** Settle admitted local work before the window flushes its durable Documents. */
export async function flushContentInteractionHistories(): Promise<void> {
  await Promise.all([...realms.values()].map((realm) => realm.history.whenIdle()));
}
