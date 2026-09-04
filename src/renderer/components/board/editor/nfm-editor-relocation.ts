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

/** Settles editor-only drag/focus state before Core observes a causal head. */
export const prepareNfmEditorStructuralMutation = async (
  editor: NfmEditorStructuralMutationRuntime,
  container: HTMLElement,
  barrier: BlockDocumentMutationBarrier,
  input: DocumentWaitOptions = {},
): Promise<DocumentHeadFence> => {
  const options = {
    ...input,
    deadlineAt: input.deadlineAt ?? Date.now() + DOCUMENT_STRUCTURAL_WAIT_TIMEOUT_MS,
  };
  assertDocumentWaitActive(options);
  finalizeSideMenuBlockDrag(editor);
  await prepareNfmEditorForMutation(editor, container);
  assertDocumentWaitActive(options);
  return await barrier.flushAndFence(options);
};
