import type * as Y from "yjs";

const participants = new WeakMap<Y.Doc, Set<() => Promise<void>>>();

/** A save barrier, not a Document mutation or a shared history owner. */
export const registerDocumentHistoryRetention = (
  document: Y.Doc,
  prepare: () => Promise<void>,
): (() => void) => {
  let active = participants.get(document);
  if (!active) {
    active = new Set();
    participants.set(document, active);
  }
  active.add(prepare);
  return () => {
    active.delete(prepare);
    if (active.size === 0) participants.delete(document);
  };
};

export const prepareDocumentHistoryRetention = async (document: Y.Doc): Promise<void> => {
  await Promise.all([...(participants.get(document) ?? [])].map((prepare) => prepare()));
};
