import type { MarkdownBlock } from "./index";
import { MAX_BLOCK_ID_LENGTH } from "../block-documents/contracts";

/** Add document identities and the table cell shape BlockNote expects at its input boundary. */
export function markdownBlocksForEditor(
  blocks: readonly MarkdownBlock[],
  allocateBlockId?: () => string,
): MarkdownBlock[] {
  const ids = new Set<string>();
  const visit = (items: readonly MarkdownBlock[]): MarkdownBlock[] =>
    items.map((block) => {
      const id = block.id ?? allocateBlockId?.();
      if (id !== undefined) {
        if (!id || id !== id.trim() || id.length > MAX_BLOCK_ID_LENGTH || ids.has(id))
          throw new TypeError("Block identities must be unique, non-empty stable ids");
        ids.add(id);
      }
      const content = block.type === "table" ? tableForEditor(block.content) : block.content;
      return {
        ...block,
        ...(id ? { id } : {}),
        ...(content !== undefined ? { content } : {}),
        children: visit(block.children ?? []),
      };
    });
  return visit(blocks);
}

function tableForEditor(content: unknown): unknown {
  if (!content || typeof content !== "object") return content;
  const table = content as {
    columnWidths?: (number | null)[];
    rows?: { cells: Record<string, unknown>[] }[];
  };
  return {
    ...table,
    columnWidths: table.columnWidths?.map((width) => width ?? undefined),
    rows: table.rows?.map((row) => ({
      ...row,
      cells: row.cells.map((cell) => ({ type: "tableCell", ...cell })),
    })),
  };
}
