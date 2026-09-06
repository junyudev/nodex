import * as Y from "yjs";
import {
  acquireContentInteractionHistory,
  contentInteractionHistoryScopeKey,
  type ContentInteractionHistoryScope,
} from "./content-interaction-history";
import { createInteractionHistory, type InteractionHistoryBinding } from "./surface-history/owner";

type StackItem = Y.UndoManager["undoStack"][number];
interface TitleCapture {
  readonly item: StackItem;
  bytes: number;
}
type TitleReceipt = TitleCapture | null;
type TitleBinding = InteractionHistoryBinding<"title", TitleReceipt, TitleCapture>;

export interface PageTitleInteractionHistory {
  readonly controls: TitleBinding;
  retainOrigin(origin: object): () => void;
}
interface TitleOwner extends PageTitleInteractionHistory {
  readonly scopeKey: string;
}
const titles = new WeakMap<Y.Text, TitleOwner>();

/** One native title journal per canonical Y.Text, retained until its Document closes. */
export function getPageTitleInteractionHistory(
  title: Y.Text,
  scope?: ContentInteractionHistoryScope,
): PageTitleInteractionHistory {
  const document = title.doc;
  if (!document || document.isDestroyed)
    throw new TypeError("Page title history requires a live Document.");
  const scopeKey = scope ? contentInteractionHistoryScopeKey(scope) : "standalone-title";
  const existing = titles.get(title);
  if (existing) {
    if (existing.scopeKey !== scopeKey) throw new Error("Page title history changed access scope.");
    return existing;
  }
  const lease = scope ? acquireContentInteractionHistory(scope) : null;
  const history = lease?.history ?? createInteractionHistory({ scopeKey });
  let binding: TitleBinding;
  let replaying = false;
  let closed = false;
  let previousBytes = JSON.stringify(title.toDelta()).length * 2;
  const manager = new Y.UndoManager(title, {
    trackedOrigins: new Set(),
    captureTransaction: (transaction) => {
      const changedTypes: ReadonlyMap<unknown, unknown> = transaction.changedParentTypes;
      if (!replaying && changedTypes.has(title) && manager.trackedOrigins.has(transaction.origin))
        binding.beginLocalCapture();
      return true;
    },
  });
  const captures = new Map<
    StackItem,
    { readonly entryId: number; readonly capture: TitleCapture }
  >();
  const weights = new WeakMap<StackItem, { updates: number; semanticPeak: number }>();
  const capturedTransactions = new WeakMap<Y.Transaction["changedParentTypes"], StackItem>();
  binding = history.bind<"title", never, TitleReceipt, TitleCapture>({
    scopeKey,
    breakCapture: () => manager.stopCapturing(),
    adapter: {
      describe: () => "Edit Page title",
      prepare: async () => {
        throw new Error("Page title edits use native capture.");
      },
      prepareInverse: async () => {
        throw new Error("Page title history is no longer available.");
      },
      submit: async () => {
        throw new Error("Page title history has no remote command.");
      },
      interpret: (receipt) =>
        receipt ? { kind: "reversible", inverse: receipt } : { kind: "noop" },
      inverseBytes: (capture) => capture.bytes,
      available: () => !closed,
      replayLocal: (capture, direction) => {
        replaying = true;
        try {
          const result = manager.replayStackItem(direction, capture.item);
          if (!result) throw new Error("Page title history no longer matches the Document.");
          let inverse: TitleCapture | null = null;
          if (result.inverse) {
            const weight = weights.get(result.inverse) ?? { updates: 0, semanticPeak: 0 };
            const previous = weights.get(capture.item);
            weight.semanticPeak = Math.max(
              weight.semanticPeak,
              previous?.semanticPeak ?? 0,
              previous?.updates ?? 0,
            );
            weights.set(result.inverse, weight);
            inverse = { item: result.inverse, bytes: weight.updates + weight.semanticPeak + 128 };
          }
          return {
            kind: "committed",
            receipt: inverse,
          };
        } finally {
          replaying = false;
        }
      },
      release: (capture) => {
        captures.delete(capture.item);
        manager.discardStackItems([capture.item]);
      },
    },
  });
  // Derive the resource index from the reachable interval, including replayed
  // inverse items. A capture can be trimmed before capture() returns.
  const indexCaptures = (): void => {
    captures.clear();
    for (const entry of binding.retained()) {
      if (!entry.inverse) continue;
      captures.set(entry.inverse.item, { entryId: entry.entryId, capture: entry.inverse });
    }
  };
  const unsubscribeHistory = binding.subscribe(indexCaptures);
  const capture = ({
    stackItem,
    changedParentTypes,
  }: {
    readonly stackItem: StackItem;
    readonly changedParentTypes: Y.Transaction["changedParentTypes"];
  }): void => {
    capturedTransactions.set(changedParentTypes, stackItem);
    const bytes = JSON.stringify(title.toDelta()).length * 2;
    const weight = weights.get(stackItem) ?? { updates: 0, semanticPeak: 0 };
    weight.semanticPeak = Math.max(weight.semanticPeak, previousBytes, bytes);
    weights.set(stackItem, weight);
    previousBytes = bytes;
    if (replaying) return;
    const retainedBytes = weight.updates + weight.semanticPeak + 128;
    const prior = captures.get(stackItem);
    if (prior) {
      prior.capture.bytes = retainedBytes;
      binding.refreshCapture(prior.entryId);
      return;
    }
    binding.capture("title", { item: stackItem, bytes: retainedBytes });
  };
  const accountUpdate = (
    update: Uint8Array,
    _origin: unknown,
    _document: Y.Doc,
    transaction: Y.Transaction,
  ): void => {
    const item = capturedTransactions.get(transaction.changedParentTypes);
    if (!item) return;
    const weight = weights.get(item);
    if (!weight) return;
    weight.updates += update.byteLength;
    const retained = captures.get(item);
    if (replaying || !retained) return;
    retained.capture.bytes = weight.updates + weight.semanticPeak + 128;
    binding.refreshCapture(retained.entryId);
  };
  manager.on("stack-item-added", capture);
  manager.on("stack-item-updated", capture);
  document.on("update", accountUpdate);
  const destroy = (): void => {
    if (closed) return;
    closed = true;
    manager.off("stack-item-added", capture);
    manager.off("stack-item-updated", capture);
    document.off("update", accountUpdate);
    binding.close();
    unsubscribeHistory();
    manager.destroy();
    titles.delete(title);
    document.off("destroy", destroy);
    if (lease) lease.release();
    else history.close();
  };
  document.on("destroy", destroy);
  const owner: TitleOwner = {
    scopeKey,
    controls: { ...binding, reset: history.reset },
    retainOrigin(origin) {
      manager.addTrackedOrigin(origin);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        manager.stopCapturing();
        manager.removeTrackedOrigin(origin);
      };
    },
  };
  titles.set(title, owner);
  return owner;
}
