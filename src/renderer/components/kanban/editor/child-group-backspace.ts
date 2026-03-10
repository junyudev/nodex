/**
 * Backspace handler for child blocks inside any inline parent with child blocks.
 *
 * When Backspace is pressed at the start of a child block (empty or not),
 * merges its content into the previous sibling (if one exists), otherwise into
 * the parent block's content. This prevents BlockNote's default unindent for
 * nested child groups.
 */

interface BlockCursor {
  id: string;
  type: string;
}

interface BlockWithChildren {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown; // InlineContent[] at runtime; checked via Array.isArray
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

export interface EditorForChildGroupBackspace {
  schema: { blockSchema: Record<string, BlockSchemaEntry> };
  getTextCursorPosition: () => { block: BlockCursor };
  getBlock: (id: string) => BlockWithChildren | undefined;
  getParentBlock: (id: string) => BlockWithChildren | undefined;
  getPrevBlock: (id: string) => BlockWithChildren | undefined;
  /** Merge source block's content into target block, position cursor at join point, remove source. */
  mergeIntoBlock: (targetId: string, sourceId: string) => void;
  focus: () => void;
  transact: {
    <T>(fn: (tr: { selection: TiptapView["state"]["selection"] }) => T): T;
    (fn: () => void): void;
  };
}

function isInlineParentBlock(
  editor: EditorForChildGroupBackspace,
  block?: BlockWithChildren,
): boolean {
  if (!block) return false;
  return editor.schema.blockSchema[block.type]?.content === "inline";
}

function isCursorAtBlockStart(editor: EditorForChildGroupBackspace): boolean {
  return editor.transact((tr) => {
    const { anchor, head, $anchor } = tr.selection;
    if (anchor !== head) return false;
    return $anchor.parentOffset === 0;
  });
}

export function handleChildGroupBackspace(
  editor: EditorForChildGroupBackspace,
): boolean {
  const cursor = editor.getTextCursorPosition();
  const currentBlock = editor.getBlock(cursor.block.id);
  if (!currentBlock) return false;
  if (currentBlock.children.length > 0) return false;

  const parent = editor.getParentBlock(currentBlock.id);
  if (!parent) return false;
  if (!isInlineParentBlock(editor, parent)) return false;
  if (!isCursorAtBlockStart(editor)) return false;

  // Merge target: previous sibling if exists, otherwise parent.
  const previousSibling = editor.getPrevBlock(currentBlock.id);
  const targetBlock = previousSibling
    ? editor.getBlock(previousSibling.id)
    : parent;
  if (!targetBlock) return false;

  // Both blocks must have array content to merge
  if (!Array.isArray(targetBlock.content) || !Array.isArray(currentBlock.content))
    return false;

  editor.mergeIntoBlock(targetBlock.id, currentBlock.id);
  editor.focus();

  return true;
}

// Backwards-compatible export while downstream call-sites migrate naming.
export const handleToggleChildBackspace = handleChildGroupBackspace;
export type EditorForToggleBackspace = EditorForChildGroupBackspace;
