/**
 * Enter key handlers for parent-child block groups.
 *
 * - Generic child-group handling:
 *   - Enter at start of an empty leaf child creates a sibling child block.
 *   - Enter in the middle/end of an inline parent with children splits trailing
 *     parent text into a new first child.
 * - Toggle-specific fallback:
 *   - Preserve legacy behaviour for expanded toggles with no children:
 *     Enter at end of non-empty header creates first child.
 */

interface BlockCursor {
  id: string;
  type: string;
}

interface BlockWithChildren {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children: { id: string }[];
}

interface BlockSchemaEntry {
  content?: string;
}

interface TiptapView {
  state: {
    selection: {
      anchor: number;
      head: number;
      $anchor: { parentOffset: number; parent: { content: { size: number } } };
    };
  };
}

export interface EditorForChildGroupEnter {
  schema: { blockSchema: Record<string, BlockSchemaEntry> };
  domElement?: ParentNode;
  getTextCursorPosition: () => { block: BlockCursor };
  getBlock: (id: string) => BlockWithChildren | undefined;
  getParentBlock: (id: string) => BlockWithChildren | undefined;
  insertBlocks: (
    blocks: Record<string, never>[],
    referenceId: string,
    placement: "after",
  ) => { id: string }[];
  updateBlock: (
    block: BlockWithChildren,
    update: { children: Record<string, never>[] },
  ) => BlockWithChildren;
  setTextCursorPosition: (id: string, placement: "end") => void;
  focus: () => void;
  /**
   * ProseMirror-level helper injected by nfm-editor-extensions:
   * split parent content at cursor and insert new first child.
   */
  splitParentIntoFirstChild: (parentId: string) => boolean;
  transact: {
    <T>(fn: (tr: { selection: TiptapView["state"]["selection"] }) => T): T;
    (fn: () => void): void;
  };
}

export function isToggleOpenInDom(
  dom: ParentNode | undefined,
  blockId: string,
): boolean {
  if (!dom) return false;
  const escaped = CSS.escape(blockId);
  const wrapper = dom.querySelector(
    `.bn-block[data-id="${escaped}"] .bn-toggle-wrapper`,
  );
  return wrapper?.getAttribute("data-show-children") === "true";
}

function isInlineParentBlock(
  editor: EditorForChildGroupEnter,
  block: BlockWithChildren,
): boolean {
  return editor.schema.blockSchema[block.type]?.content === "inline";
}

function isToggleBlock(type: string, block?: BlockWithChildren): boolean {
  if (type === "toggleListItem") return true;
  if (type === "cardToggle") return true;
  if (type === "heading" && block?.props?.isToggleable === true) return true;
  return false;
}

export function handleParentEnterSplitToFirstChild(
  editor: EditorForChildGroupEnter,
): boolean {
  const cursor = editor.getTextCursorPosition();
  const parent = editor.getBlock(cursor.block.id);
  if (!parent) return false;
  if (!isInlineParentBlock(editor, parent)) return false;
  if (parent.children.length === 0) return false;

  const splitEligible = editor.transact((tr) => {
    const { anchor, head, $anchor } = tr.selection;
    if (anchor !== head) return false;
    if ($anchor.parentOffset === 0) return false;
    return $anchor.parentOffset <= $anchor.parent.content.size;
  });
  if (!splitEligible) return false;

  if (!editor.splitParentIntoFirstChild(parent.id)) return false;
  editor.focus();
  return true;
}

export function handleToggleEnterToChild(
  editor: EditorForChildGroupEnter,
): boolean {
  // 1. Must be a toggle block (toggleListItem / cardToggle / toggle heading)
  const cursor = editor.getTextCursorPosition();
  const block = editor.getBlock(cursor.block.id);
  if (!block || !isToggleBlock(cursor.block.type, block)) return false;

  // 2. Must have no children
  if (block.children.length > 0) return false;

  // 3. Toggle must be open
  if (!isToggleOpenInDom(editor.domElement, cursor.block.id)) return false;

  // 4. Selection must be empty, header non-empty, cursor at end of content
  const cursorAtEnd = editor.transact((tr) => {
    const { anchor, head, $anchor } = tr.selection;
    if (anchor !== head) return false;
    if ($anchor.parent.content.size === 0) return false;
    return $anchor.parentOffset === $anchor.parent.content.size;
  });
  if (!cursorAtEnd) return false;

  // 5. Create child paragraph and move cursor
  editor.transact(() => {
    const updated = editor.updateBlock(block, { children: [{}] });
    editor.setTextCursorPosition(updated.children[0].id, "end");
    editor.focus();
  });

  return true;
}

/**
 * Enter at position 0 of an empty leaf child block:
 * create a new sibling paragraph after the current block instead of unindenting.
 */
export function handleChildGroupEmptyEnter(
  editor: EditorForChildGroupEnter,
): boolean {
  const cursor = editor.getTextCursorPosition();
  const currentBlock = editor.getBlock(cursor.block.id);
  if (!currentBlock) return false;

  // Must be a leaf child (no nested children)
  if (currentBlock.children.length > 0) return false;

  // Parent must support inline content (generic child-group parent).
  const parent = editor.getParentBlock(currentBlock.id);
  if (!parent) return false;
  if (!isInlineParentBlock(editor, parent)) return false;

  // Cursor at position 0, empty block, selection empty
  const atStartOfEmpty = editor.transact((tr) => {
    const { anchor, head, $anchor } = tr.selection;
    if (anchor !== head) return false;
    if ($anchor.parentOffset !== 0) return false;
    return $anchor.parent.content.size === 0;
  });
  if (!atStartOfEmpty) return false;

  // Insert new empty paragraph after current block (stays inside toggle)
  editor.transact(() => {
    const [inserted] = editor.insertBlocks(
      [{} as Record<string, never>],
      currentBlock.id,
      "after",
    );
    editor.setTextCursorPosition(inserted.id, "end");
    editor.focus();
  });

  return true;
}

// Backwards-compatible export while downstream call-sites migrate naming.
export const handleToggleChildEmptyEnter = handleChildGroupEmptyEnter;
export type EditorForToggleEnter = EditorForChildGroupEnter;
