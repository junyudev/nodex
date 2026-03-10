export function escapeAttributeValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

export function findBlockElementById(
  editorDom: ParentNode | undefined,
  blockId: string,
): HTMLElement | null {
  if (!editorDom) return null;
  if (!blockId) return null;

  const escapedBlockId = escapeAttributeValue(blockId);
  return editorDom.querySelector<HTMLElement>(`.bn-block[data-id="${escapedBlockId}"]`);
}

export function findBlockDescendantById<TElement extends Element>(
  editorDom: ParentNode | undefined,
  blockId: string,
  selector: string,
): TElement | null {
  if (!editorDom) return null;
  if (!blockId) return null;

  const escapedBlockId = escapeAttributeValue(blockId);
  return editorDom.querySelector<TElement>(
    `.bn-block[data-id="${escapedBlockId}"] ${selector}`,
  );
}
