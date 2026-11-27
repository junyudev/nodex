import type { MarkdownBlock, MarkdownInline } from "../nodex-markdown";

function visibleText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as MarkdownInline[])
    .map((item) => (typeof item.text === "string" ? item.text : visibleText(item.content)))
    .join("");
}

export function visualBlockSource(block: MarkdownBlock): string | undefined {
  return block.type === "codeBlock" && block.props?.language === "visual"
    ? visibleText(block.content)
    : undefined;
}

export function visualTableCells(block: MarkdownBlock): string[][] | undefined {
  if (block.type !== "table") return undefined;
  const table = block.content as {
    headerRows?: number;
    rows?: { cells: { content?: unknown }[] }[];
  };
  if (!table?.rows || !table.headerRows) return undefined;
  return table.rows.map((row) => row.cells.map((cell) => visibleText(cell.content)));
}
