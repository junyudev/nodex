import type * as Y from "yjs";
import type { DocumentHistoryFence } from "../../shared/block-documents/document-history-fence";

interface DocumentFences {
  headSeq: number;
  readonly listeners: Set<(fence: DocumentHistoryFence) => void>;
}

const documents = new WeakMap<Y.Doc, DocumentFences>();
const stateFor = (document: Y.Doc): DocumentFences => {
  const existing = documents.get(document);
  if (existing) return existing;
  const state: DocumentFences = { headSeq: -1, listeners: new Set() };
  documents.set(document, state);
  return state;
};

/** Only canonical Document delivery calls this; view code cannot infer relocation. */
export const publishDocumentHistoryFence = (
  document: Y.Doc,
  fence: DocumentHistoryFence | undefined,
): void => {
  if (!fence) return;
  const state = stateFor(document);
  if (fence.headSeq <= state.headSeq) return;
  state.headSeq = fence.headSeq;
  for (const listener of state.listeners) listener(fence);
};

export const subscribeDocumentHistoryFences = (
  document: Y.Doc,
  listener: (fence: DocumentHistoryFence) => void,
): (() => void) => {
  const state = stateFor(document);
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
};
