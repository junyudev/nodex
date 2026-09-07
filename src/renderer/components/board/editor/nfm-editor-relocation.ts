import type {
  BlockDocumentMutationBarrier,
  DocumentHeadFence,
} from "@/lib/block-document-surface-runtime";
import {
  DOCUMENT_STRUCTURAL_WAIT_TIMEOUT_MS,
  assertDocumentWaitActive,
  type DocumentWaitOptions,
} from "@/lib/document-wait";
import {
  finalizeSideMenuBlockDrag,
  type SideMenuDragCleanupEditor,
} from "./side-menu-drag-lifecycle";

export interface NfmEditorMutationRuntime {
  readonly isFocused?: () => boolean;
  readonly isWithinEditor?: (element: Element) => boolean;
  readonly blur?: () => void;
  readonly focus?: () => void;
}

export type NfmEditorStructuralMutationRuntime = NfmEditorMutationRuntime &
  SideMenuDragCleanupEditor;

export type NfmEditorObservationRuntime = NfmEditorStructuralMutationRuntime & {
  readonly prosemirrorView?: { readonly composing?: boolean };
};

export function hasNfmEditorTransientInput(editor: NfmEditorObservationRuntime): boolean {
  try {
    return editor.prosemirrorView?.composing === true || editor.prosemirrorView?.dragging != null;
  } catch {
    return true;
  }
}

const isNfmEditorElement = (
  editor: NfmEditorMutationRuntime,
  container: HTMLElement,
  element: Element,
): boolean => container.contains(element) || editor.isWithinEditor?.(element) === true;

const ownsNfmEditorFocus = (editor: NfmEditorMutationRuntime, container: HTMLElement): boolean => {
  const activeElement = container.ownerDocument.activeElement;
  const ownsActiveElement =
    activeElement instanceof Element && isNfmEditorElement(editor, container, activeElement);
  return ownsActiveElement || editor.isFocused?.() === true;
};

const restoreNfmEditorFocus = (
  editor: NfmEditorMutationRuntime,
  container: HTMLElement,
  shouldRestoreFocus: boolean,
): void => {
  if (!shouldRestoreFocus || !container.isConnected) return;
  if (editor.isFocused?.() === true) return;

  const { activeElement, body, documentElement } = container.ownerDocument;
  if (activeElement && activeElement !== body && activeElement !== documentElement) return;

  try {
    editor.focus?.();
  } catch {
    // The surface may have unmounted while the lifecycle command was pending.
  }
};

export const prepareNfmEditorForMutation = async (
  editor: NfmEditorMutationRuntime,
  container: HTMLElement,
): Promise<void> => {
  const activeElement = container.ownerDocument.activeElement;
  const ownsFocus = ownsNfmEditorFocus(editor, container);
  if (
    activeElement instanceof HTMLElement &&
    isNfmEditorElement(editor, container, activeElement)
  ) {
    activeElement.blur();
  }
  if (ownsFocus) editor.blur?.();
  await Promise.resolve();
};

/**
 * Keeps a keyboard-originated structural mutation focused without weakening the
 * blur-before-fence boundary. A later focus choice always wins over recovery.
 */
export const runNfmEditorFocusPreservingMutation = async <Result>(
  editor: NfmEditorMutationRuntime,
  container: HTMLElement,
  mutate: () => Promise<Result>,
): Promise<Result> => {
  const shouldRestoreFocus = ownsNfmEditorFocus(editor, container);
  try {
    return await mutate();
  } finally {
    restoreNfmEditorFocus(editor, container, shouldRestoreFocus);
  }
};

/** Retained Documents can fence without a view; mounted views settle drag/focus first. */
export const prepareNfmEditorStructuralMutation = async (
  editor: NfmEditorStructuralMutationRuntime,
  container: HTMLElement | null,
  barrier: BlockDocumentMutationBarrier,
  input: DocumentWaitOptions = {},
): Promise<DocumentHeadFence> => {
  const options = {
    ...input,
    deadlineAt: input.deadlineAt ?? Date.now() + DOCUMENT_STRUCTURAL_WAIT_TIMEOUT_MS,
  };
  assertDocumentWaitActive(options);
  if (!container?.isConnected) return await barrier.flushAndFence(options);
  finalizeSideMenuBlockDrag(editor);
  await prepareNfmEditorForMutation(editor, container);
  assertDocumentWaitActive(options);
  return await barrier.flushAndFence(options);
};

/** Observational reads preserve focus and leave active composition or drag gestures to the user. */
export async function prepareNfmEditorObservation(
  editor: NfmEditorObservationRuntime,
  container: HTMLElement | null,
  barrier: BlockDocumentMutationBarrier,
  options: DocumentWaitOptions,
): Promise<DocumentHeadFence> {
  if (!container?.isConnected) throw new Error("The Page editor is unavailable");
  if (hasNfmEditorTransientInput(editor)) throw new Error("The Page editor has pending input");
  return runNfmEditorFocusPreservingMutation(editor, container, () =>
    prepareNfmEditorStructuralMutation(editor, container, barrier, options),
  );
}
