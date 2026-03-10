interface BlockLike {
  type?: string;
  props?: Record<string, unknown>;
}

interface SelectionLike {
  blocks?: BlockLike[];
}

export interface ImageSelectionEditor {
  getSelection: () => SelectionLike | undefined;
  getTextCursorPosition: () => { block: BlockLike };
}

export interface ImageBlockLookupEditor {
  getBlock: (id: string) => BlockLike | undefined;
}

export interface FocusedImagePreview {
  source: string;
  alt: string;
}

function readStringProp(
  props: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = props?.[key];
  return typeof value === "string" ? value : "";
}

export function isSpaceShortcut(event: Pick<KeyboardEvent, "key" | "code">): boolean {
  return event.code === "Space" || event.key === " " || event.key === "Spacebar";
}

export function resolveFocusedImagePreview(
  editor: ImageSelectionEditor,
): FocusedImagePreview | null {
  const selectedBlocks = editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block];
  if (selectedBlocks.length !== 1) return null;

  const selectedBlock = selectedBlocks[0];
  if (!selectedBlock || selectedBlock.type !== "image") return null;

  const source = readStringProp(selectedBlock.props, "url").trim();
  if (!source) return null;

  const caption = readStringProp(selectedBlock.props, "caption").trim();
  const name = readStringProp(selectedBlock.props, "name").trim();

  return {
    source,
    alt: caption || name || "Image preview",
  };
}

export function resolveImagePreviewByBlockId(
  editor: ImageBlockLookupEditor,
  blockId: string,
): FocusedImagePreview | null {
  if (!blockId) return null;

  const block = editor.getBlock(blockId);
  if (!block || block.type !== "image") return null;

  const source = readStringProp(block.props, "url").trim();
  if (!source) return null;

  const caption = readStringProp(block.props, "caption").trim();
  const name = readStringProp(block.props, "name").trim();

  return {
    source,
    alt: caption || name || "Image preview",
  };
}
