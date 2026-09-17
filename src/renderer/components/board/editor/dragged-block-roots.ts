export interface DraggableEditorBlock {
  readonly id: string;
  readonly type: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly content?: unknown;
  readonly children?: readonly DraggableEditorBlock[];
}

const inlinePromotionTitle = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(inlinePromotionTitle).join("");
  if (!value || typeof value !== "object") return "";
  const item = value as Readonly<Record<string, unknown>>;
  if (typeof item.text === "string") return item.text;
  if (typeof item.label === "string") return item.label;
  return inlinePromotionTitle(item.content);
};

/**
 * Promotion previews must respect typed-owner identity. A Page Block is only a
 * shell and intentionally owns no inline content, so its title comes from the
 * Page read model rather than from Block content.
 */
export const resolveDraggedBlockPromotionTitle = (
  block: DraggableEditorBlock,
  resolvePageTitle: (pageId: string) => string | null,
): string => {
  const title =
    block.type === "page" ? resolvePageTitle(block.id) : inlinePromotionTitle(block.content);
  return title?.trim() || "Untitled";
};

/** Remove selected descendants so one transfer never duplicates a subtree. */
export const resolveTopLevelDraggedBlocks = <Block extends DraggableEditorBlock>(
  editor: {
    getBlock: (id: string) => Block | undefined;
    getParentBlock: (id: string) => Block | undefined;
  },
  draggedIds: readonly string[],
): readonly Block[] => {
  const selected = new Set(draggedIds);
  return draggedIds
    .filter((id) => {
      let parent = editor.getParentBlock(id);
      while (parent) {
        if (selected.has(parent.id)) return false;
        parent = editor.getParentBlock(parent.id);
      }
      return true;
    })
    .map((id) => editor.getBlock(id))
    .filter((block): block is Block => block !== undefined);
};
