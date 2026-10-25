export interface CommandPaletteFocusSnapshot {
  readonly originElement: HTMLElement | null;
  /** Restore after the palette has synchronously released its focus trap. */
  readonly restore: () => void;
}

function selectionEndpointIsConnected(node: Node, offset: number): boolean {
  if (!node.isConnected) return false;
  const length =
    node.nodeType === Node.TEXT_NODE || node.nodeType === Node.COMMENT_NODE
      ? (node.nodeValue?.length ?? 0)
      : node.childNodes.length;
  return offset >= 0 && offset <= length;
}

function elementSelection(element: HTMLElement | null, ownerDocument: Document): Selection | null {
  const root = element?.getRootNode();
  if (!(root instanceof ShadowRoot)) return ownerDocument.getSelection();
  // Chromium exposes the selection inside a shadow editor on its ShadowRoot.
  const shadowRoot = root as ShadowRoot & { getSelection?: () => Selection | null };
  return shadowRoot.getSelection ? shadowRoot.getSelection() : ownerDocument.getSelection();
}

function deepestActiveElement(ownerDocument: Document): HTMLElement | null {
  let activeElement = ownerDocument.activeElement;
  while (activeElement?.shadowRoot?.activeElement) {
    activeElement = activeElement.shadowRoot.activeElement;
  }
  return activeElement instanceof HTMLElement ? activeElement : null;
}

/** Only seed searches from a short, single-line selection owned by the active editor. */
export function readCommandPaletteSelectionQuery(
  ownerDocument: Document = document,
): string | undefined {
  const element = deepestActiveElement(ownerDocument);
  if (!element || (element instanceof HTMLInputElement && element.type === "password")) return;
  const selection = elementSelection(element, ownerDocument);
  const text =
    (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
    element.selectionStart !== null &&
    element.selectionEnd !== null
      ? element.value.slice(element.selectionStart, element.selectionEnd)
      : element.contains(selection?.anchorNode ?? null) &&
          element.contains(selection?.focusNode ?? null)
        ? (selection?.toString() ?? "")
        : "";
  const query = text.trim();
  if (!query || query.length > 256 || /[\r\n\0]/.test(query)) return;
  return query;
}

/** Capture once at the open edge, before search takes focus, including a nested editor selection. */
export function captureCommandPaletteFocus(
  ownerDocument: Document = document,
): CommandPaletteFocusSnapshot {
  const originElement = deepestActiveElement(ownerDocument);
  const selection = elementSelection(originElement, ownerDocument);
  const anchorNode = selection?.anchorNode ?? null;
  const anchorOffset = selection?.anchorOffset ?? 0;
  const focusNode = selection?.focusNode ?? null;
  const focusOffset = selection?.focusOffset ?? 0;
  const inputSelection =
    originElement instanceof HTMLInputElement || originElement instanceof HTMLTextAreaElement
      ? {
          start: originElement.selectionStart,
          end: originElement.selectionEnd,
          direction: originElement.selectionDirection,
        }
      : null;

  return {
    originElement,
    restore: () => {
      if (!originElement?.isConnected) return;
      originElement.focus({ preventScroll: true });
      if (
        inputSelection !== null &&
        inputSelection.start !== null &&
        inputSelection.end !== null &&
        (originElement instanceof HTMLInputElement || originElement instanceof HTMLTextAreaElement)
      ) {
        originElement.setSelectionRange(
          inputSelection.start,
          inputSelection.end,
          inputSelection.direction ?? undefined,
        );
        return;
      }
      if (
        !anchorNode ||
        !focusNode ||
        !selectionEndpointIsConnected(anchorNode, anchorOffset) ||
        !selectionEndpointIsConnected(focusNode, focusOffset)
      ) {
        return;
      }
      elementSelection(originElement, ownerDocument)?.setBaseAndExtent(
        anchorNode,
        anchorOffset,
        focusNode,
        focusOffset,
      );
    },
  };
}
