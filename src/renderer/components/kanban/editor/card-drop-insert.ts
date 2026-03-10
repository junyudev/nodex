import { hasClosest, resolveBlockId } from "./drag-source-resolver";

interface BlockLike {
  id: string;
  type: string;
  children?: BlockLike[];
}

export interface EditorForCardDropInsert {
  document: BlockLike[];
  getBlock: (id: string) => BlockLike | undefined;
  getParentBlock: (id: string) => BlockLike | undefined;
  insertBlocks: (
    blocks: unknown[],
    referenceBlock: string,
    placement: "before" | "after",
  ) => unknown;
  replaceBlocks: (toRemove: unknown[], replacements: unknown[]) => void;
  transact?: <T>(fn: () => T) => T;
}

export interface CardDropInsertPoint {
  x: number;
  y: number;
}

interface CardDropInsertOptions {
  inlineOnly?: boolean;
}

export interface CardDropResolvedAnchor {
  blockId: string;
  placement: "before" | "after";
  blockElement: HTMLElement;
}

export interface CardDropIndicatorPosition {
  top: number;
  left: number;
  width: number;
}

function runInTransaction<T>(
  editor: EditorForCardDropInsert,
  fn: () => T,
): T {
  if (!editor.transact) return fn();
  return editor.transact(fn);
}

function getPlacement(
  blockElement: HTMLElement,
  pointerY: number,
): "before" | "after" {
  const rect = blockElement.getBoundingClientRect();
  return pointerY <= rect.top + rect.height / 2 ? "before" : "after";
}

function getBlockElements(container: HTMLElement): HTMLElement[] {
  const blocks = Array.from(
    container.querySelectorAll<HTMLElement>(".bn-block[data-id]"),
  );
  return blocks.filter((block) => resolveBlockId(block) !== null);
}

function resolveFromBlockMidlines(
  container: HTMLElement,
  point: CardDropInsertPoint,
): CardDropResolvedAnchor | null {
  const blocks = getBlockElements(container);
  if (blocks.length === 0) return null;

  for (const blockElement of blocks) {
    const blockId = resolveBlockId(blockElement);
    if (!blockId) continue;

    const rect = blockElement.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    if (point.y <= midpoint) {
      return {
        blockId,
        placement: "before",
        blockElement,
      };
    }
  }

  const lastBlock = blocks[blocks.length - 1];
  const lastBlockId = lastBlock ? resolveBlockId(lastBlock) : null;
  if (!lastBlock || !lastBlockId) return null;

  return {
    blockId: lastBlockId,
    placement: "after",
    blockElement: lastBlock,
  };
}

export function resolveCardDropAnchor(
  container: HTMLElement,
  point: CardDropInsertPoint,
): CardDropResolvedAnchor | null {
  const elements = container.ownerDocument.elementsFromPoint(point.x, point.y);
  for (const element of elements) {
    if (!hasClosest(element)) continue;
    if (!container.contains(element)) continue;

    const blockEl = element.closest<HTMLElement>(".bn-block[data-id]");
    if (!blockEl) continue;

    const blockId = resolveBlockId(blockEl);
    if (!blockId) continue;

    return {
      blockId,
      placement: getPlacement(blockEl, point.y),
      blockElement: blockEl,
    };
  }

  return resolveFromBlockMidlines(container, point);
}

function findTopLevelAncestor(
  editor: EditorForCardDropInsert,
  blockId: string,
): BlockLike | null {
  let current = editor.getBlock(blockId);
  if (!current) return null;

  for (;;) {
    const parent = editor.getParentBlock(current.id);
    if (!parent) return current;
    current = parent;
  }
}

function insertIntoInlineTarget(
  editor: EditorForCardDropInsert,
  blocks: unknown[],
  anchorId: string,
  placement: "before" | "after",
): boolean {
  const root = findTopLevelAncestor(editor, anchorId);
  if (!root || root.type !== "cardToggle") return false;

  if (anchorId === root.id) {
    const rootChildren = Array.isArray(root.children) ? root.children : [];
    if (rootChildren.length === 0) {
      runInTransaction(editor, () => {
        editor.replaceBlocks([root.id], [{
          ...root,
          children: blocks,
        }]);
      });
      return true;
    }

    const referenceId = placement === "before"
      ? rootChildren[0]?.id
      : rootChildren[rootChildren.length - 1]?.id;
    if (!referenceId) return false;

    runInTransaction(editor, () => {
      editor.insertBlocks(blocks, referenceId, placement);
    });
    return true;
  }

  runInTransaction(editor, () => {
    editor.insertBlocks(blocks, anchorId, placement);
  });
  return true;
}

function insertIntoDocument(
  editor: EditorForCardDropInsert,
  blocks: unknown[],
  anchor: CardDropResolvedAnchor | null,
): boolean {
  if (anchor) {
    runInTransaction(editor, () => {
      editor.insertBlocks(blocks, anchor.blockId, anchor.placement);
    });
    return true;
  }

  if (editor.document.length === 0) {
    runInTransaction(editor, () => {
      editor.replaceBlocks(editor.document, blocks);
    });
    return true;
  }

  const lastTopLevelBlock = editor.document[editor.document.length - 1];
  if (!lastTopLevelBlock?.id) return false;

  runInTransaction(editor, () => {
    editor.insertBlocks(blocks, lastTopLevelBlock.id, "after");
  });
  return true;
}

export function insertCardTogglesAtPointer(
  editor: EditorForCardDropInsert,
  container: HTMLElement,
  point: CardDropInsertPoint,
  blocks: unknown[],
  options: CardDropInsertOptions = {},
): boolean {
  if (blocks.length === 0) return false;
  const anchor = resolveCardDropAnchor(container, point);

  if (options.inlineOnly) {
    if (!anchor) return false;
    return insertIntoInlineTarget(editor, blocks, anchor.blockId, anchor.placement);
  }

  return insertIntoDocument(editor, blocks, anchor);
}

export function insertCardToggleAtPointer(
  editor: EditorForCardDropInsert,
  container: HTMLElement,
  point: CardDropInsertPoint,
  block: unknown,
  options: CardDropInsertOptions = {},
): boolean {
  return insertCardTogglesAtPointer(editor, container, point, [block], options);
}

export function resolveCardDropIndicatorPosition(
  editor: EditorForCardDropInsert,
  container: HTMLElement,
  point: CardDropInsertPoint,
  options: CardDropInsertOptions = {},
): CardDropIndicatorPosition | null {
  const anchor = resolveCardDropAnchor(container, point);
  if (!anchor) {
    if (options.inlineOnly) return null;
    if (editor.document.length !== 0) return null;

    return {
      top: 10,
      left: 12,
      width: Math.max(container.clientWidth - 24, 24),
    };
  }

  if (options.inlineOnly) {
    const root = findTopLevelAncestor(editor, anchor.blockId);
    if (!root || root.type !== "cardToggle") return null;
  }

  const blockRect = anchor.blockElement.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const top = anchor.placement === "before"
    ? blockRect.top - containerRect.top
    : blockRect.bottom - containerRect.top;
  const left = Math.max(blockRect.left - containerRect.left + 10, 8);
  const width = Math.max(blockRect.width - 20, 32);

  return {
    top,
    left,
    width,
  };
}
