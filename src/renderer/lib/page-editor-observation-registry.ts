import type {
  BlockDocumentSurfaceStatus,
  DocumentHeadFence,
} from "./block-document-surface-runtime";
import type { DocumentWaitOptions } from "./document-wait";

export interface PageEditorObservationParticipant {
  readonly readSelection: () => readonly string[];
  readonly subscribeSelection: (listener: () => void) => () => void;
  readonly read: () => {
    readonly mounted: boolean;
    readonly transientInput: boolean;
    readonly status: BlockDocumentSurfaceStatus;
  };
  readonly prepare: (options: DocumentWaitOptions) => Promise<DocumentHeadFence>;
}

/** Capabilities of actual mounted editors. Exact lease keys keep shared-Document views distinct. */
const participants = new Map<string, PageEditorObservationParticipant>();

export function registerPageEditorObservationParticipant(
  editorSurfaceId: string,
  participant: PageEditorObservationParticipant,
): () => void {
  const registration = { ...participant };
  participants.set(editorSurfaceId, registration);
  notifySelectionRegistration(editorSurfaceId);
  return () => {
    if (participants.get(editorSurfaceId) !== registration) return;
    participants.delete(editorSurfaceId);
    notifySelectionRegistration(editorSurfaceId);
  };
}

export const resolvePageEditorObservationParticipant = (
  editorSurfaceId: string,
): PageEditorObservationParticipant | null => participants.get(editorSurfaceId) ?? null;

const selectionListeners = new Map<string, Set<() => void>>();
const EMPTY_SELECTION: readonly string[] = [];
const notifySelectionRegistration = (key: string) => {
  for (const listener of selectionListeners.get(key) ?? []) listener();
};

export const readPageEditorSelection = (key: string): readonly string[] =>
  participants.get(key)?.readSelection() ?? EMPTY_SELECTION;

/** Subscribe across editor mount, replacement and unmount as well as selection changes. */
export function subscribePageEditorSelection(key: string, listener: () => void): () => void {
  let unsubscribe = () => {};
  const rebind = () => {
    unsubscribe();
    unsubscribe = participants.get(key)?.subscribeSelection(listener) ?? (() => {});
    listener();
  };
  const listeners = selectionListeners.get(key) ?? new Set();
  selectionListeners.set(key, listeners);
  listeners.add(rebind);
  rebind();
  return () => {
    unsubscribe();
    listeners.delete(rebind);
    if (listeners.size === 0) selectionListeners.delete(key);
  };
}
