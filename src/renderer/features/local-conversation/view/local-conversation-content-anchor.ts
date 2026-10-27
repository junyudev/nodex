export interface ConversationContentAnchor {
  readonly element: HTMLElement | null;
  readonly attribute:
    | "data-content-search-unit-key"
    | "data-native-realtime-item-id"
    | "data-conversation-item-key";
  readonly key: string;
  readonly topWithinViewportPx: number;
}

/** Sample visible content without walking every message in a long Turn. */
export function readConversationContentAnchors(input: {
  readonly scrollElement: HTMLElement;
  readonly rows: ReadonlyMap<string, HTMLElement>;
  readonly windowZoom: number;
}): readonly ConversationContentAnchor[] {
  const { scrollElement, rows, windowZoom } = input;
  const document = scrollElement.ownerDocument;
  const viewport = scrollElement.getBoundingClientRect();
  if (!document.elementFromPoint || viewport.width <= 0 || viewport.height <= 0) return [];
  const anchors: ConversationContentAnchor[] = [];
  const seen = new Set<HTMLElement>();
  const sample = (hit: Element | null) => {
    const element = hit?.closest<HTMLElement>("[data-content-search-unit-key]");
    const row = element?.closest<HTMLElement>("[data-turn-key]");
    if (!element || seen.has(element) || !row || rows.get(row.dataset.turnKey ?? "") !== row)
      return;
    seen.add(element);
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0 || rect.bottom <= viewport.top || rect.top >= viewport.bottom) return;
    // Search ordinals and voice row names can change when older messages prepend.
    const attribute = element.hasAttribute("data-native-realtime-item-id")
      ? "data-native-realtime-item-id"
      : element.hasAttribute("data-conversation-item-key")
        ? "data-conversation-item-key"
        : "data-content-search-unit-key";
    const key = element.getAttribute(attribute);
    if (!key) return;
    anchors.push({
      element,
      attribute,
      key,
      topWithinViewportPx: (rect.top - viewport.top) / windowZoom,
    });
  };
  sample(document.activeElement);
  for (const y of [
    viewport.top + 1,
    viewport.top + 24,
    (viewport.top + viewport.bottom) / 2,
    viewport.bottom - 1,
  ]) {
    for (const fraction of [0.5, 0.25, 0.75])
      sample(document.elementFromPoint(viewport.left + viewport.width * fraction, y));
  }
  return anchors;
}

/** Resolve native content after layout, including a remount under a renamed virtual row. */
export function resolveConversationContentAnchor(
  anchors: readonly ConversationContentAnchor[],
  root: HTMLElement,
): { readonly anchor: ConversationContentAnchor; readonly element: HTMLElement } | null {
  for (const anchor of anchors) {
    const element =
      anchor.element &&
      root.contains(anchor.element) &&
      anchor.element.getAttribute(anchor.attribute) === anchor.key
        ? anchor.element
        : root.querySelector<HTMLElement>(`[${anchor.attribute}="${CSS.escape(anchor.key)}"]`);
    if (element) return { anchor, element };
  }
  return null;
}
