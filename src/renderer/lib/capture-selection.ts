import { classifyKeyboardActionPath } from "./keyboard-action-runtime";

function nodePath(node: Node | null): readonly EventTarget[] {
  const path: EventTarget[] = [];
  let current: Node | null = node;
  while (current) {
    path.push(current);
    current = current.parentNode;
  }
  return path;
}

const nodeIsGloballyOwned = (node: Node | null): boolean =>
  classifyKeyboardActionPath(nodePath(node)) === "global";

function rangeCrossesOwnedSurface(range: Range): boolean {
  const commonAncestor = range.commonAncestorContainer;
  const root: Element | null =
    commonAncestor.nodeType === Node.ELEMENT_NODE
      ? (commonAncestor as Element)
      : commonAncestor.parentElement;
  if (!root) return false;

  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let element: Node | null = root;
  while (element) {
    if (range.intersectsNode(element) && !nodeIsGloballyOwned(element)) {
      return true;
    }
    element = walker.nextNode();
  }
  return false;
}

/**
 * Text the user selected on the app's own surfaces, ready to start an Inbox message. Editors,
 * fields and local surfaces keep their selections to themselves.
 */
export function readCaptureSelection(selection: Selection | null): string | null {
  if (!selection || selection.isCollapsed || selection.rangeCount < 1) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (!nodeIsGloballyOwned(selection.anchorNode)) return null;
  if (!nodeIsGloballyOwned(selection.focusNode)) return null;
  if (!nodeIsGloballyOwned(range.commonAncestorContainer)) return null;
  if (rangeCrossesOwnedSurface(range)) return null;

  const text = selection.toString().replace(/\r\n?/gu, "\n").trim();
  return text || null;
}
