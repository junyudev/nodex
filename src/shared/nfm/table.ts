import type {
  NfmColor,
  NfmInlineContent,
  NfmTable,
  NfmTableAlignment,
  NfmTableCell,
  NfmTableColumn,
  NfmTableRow,
} from "./types";
import { NFM_COLORS } from "./types";
import { formatDateMentionPlainText } from "./date-mention";
import { parseInlineContent } from "./parser-inline";
import { serializeInlineContent } from "./serializer-inline";
import { getXmlAttr } from "./xml-attributes";
import { serializeAttachmentClipboardText } from "./clipboard-attachment";

export interface ParsedNfmTable {
  block: NfmTable;
  nextLine: number;
}

export function tryParseGfmTable(
  lines: string[],
  startLine: number,
  indent: number,
): ParsedNfmTable | null {
  const headerLine = getLineAtIndent(lines[startLine], indent);
  const delimiterLine = getLineAtIndent(lines[startLine + 1], indent);
  if (headerLine === null || delimiterLine === null) return null;
  if (!looksLikeTableRow(headerLine) || !looksLikeTableRow(delimiterLine)) return null;

  const headerCells = splitGfmTableRow(headerLine);
  const delimiterCells = splitGfmTableRow(delimiterLine);
  if (headerCells.length === 0 || headerCells.length !== delimiterCells.length) {
    return null;
  }

  const alignments = delimiterCells.map(parseDelimiterCell);
  if (alignments.some((alignment) => alignment === null)) return null;

  const columnCount = headerCells.length;
  const rows: NfmTableRow[] = [{ cells: headerCells.map((cell) => createCellFromGfm(cell)) }];

  let cursor = startLine + 2;
  while (cursor < lines.length) {
    const rowLine = getLineAtIndent(lines[cursor], indent);
    if (rowLine === null) break;
    if (rowLine.trim() === "") break;
    if (!looksLikeTableRow(rowLine)) break;

    const rowCells = normalizeCellCount(splitGfmTableRow(rowLine), columnCount).map((cell) =>
      createCellFromGfm(cell),
    );
    rows.push({ cells: rowCells });
    cursor += 1;
  }

  return {
    block: normalizeTable({
      type: "table",
      rows,
      columns: alignments.map((alignment) => (alignment ? { align: alignment } : {})),
      headerRow: true,
      sourceSyntax: "gfm",
      children: [],
    }),
    nextLine: cursor,
  };
}

export function tryParseNfmTableXml(
  lines: string[],
  startLine: number,
  indent: number,
): ParsedNfmTable | null {
  const openLine = getLineAtIndent(lines[startLine], indent);
  if (openLine === null) return null;

  const openMatch = openLine.trim().match(/^<table(?:\s+([^>]*))?>$/);
  if (!openMatch) return null;

  const attrString = openMatch[1] ?? "";
  const rows: NfmTableRow[] = [];
  const columns: NfmTableColumn[] = [];
  let cursor = startLine + 1;
  let closed = false;

  while (cursor < lines.length) {
    const current = getLineAtMinimumIndent(lines[cursor], indent);
    if (current === null) return null;

    const trimmed = current.trim();
    if (trimmed === "</table>") {
      cursor += 1;
      closed = true;
      break;
    }

    if (trimmed === "<colgroup>") {
      cursor += 1;
      while (cursor < lines.length) {
        const colLine = getLineAtMinimumIndent(lines[cursor], indent);
        if (colLine === null) return null;
        const colTrimmed = colLine.trim();
        if (colTrimmed === "</colgroup>") {
          cursor += 1;
          break;
        }

        const column = parseColumnLine(colTrimmed);
        if (column) columns.push(column);
        cursor += 1;
      }
      continue;
    }

    if (trimmed.startsWith("<tr")) {
      const parsedRow = parseXmlRow(lines, cursor, indent);
      if (!parsedRow) return null;
      rows.push(parsedRow.row);
      cursor = parsedRow.nextLine;
      continue;
    }

    cursor += 1;
  }

  if (!closed) return null;

  return {
    block: normalizeTable({
      type: "table",
      color: parseColorAttr(attrString, "color"),
      rows,
      columns,
      headerRow: getXmlAttr(attrString, "header-row") === "true",
      headerColumn: getXmlAttr(attrString, "header-column") === "true",
      fitPageWidth: getXmlAttr(attrString, "fit-page-width") === "true",
      sourceSyntax: "nfmTable",
      children: [],
    }),
    nextLine: cursor,
  };
}

export function serializeNfmTable(block: NfmTable, indent: number): string[] {
  const normalized = normalizeTable(block);
  if (canSerializeAsGfm(normalized)) {
    return serializeGfmTable(normalized, indent);
  }

  return serializeXmlTable(normalized, indent);
}

export function serializeNfmTablePlainText(block: NfmTable, indent: number): string[] {
  const prefix = "\t".repeat(indent);
  const normalized = normalizeTable(block);
  return normalized.rows.map(
    (row) => prefix + row.cells.map((cell) => serializeInlinePlainText(cell.content)).join("\t"),
  );
}

export function normalizeTable(block: NfmTable): NfmTable {
  const columnCount = Math.max(
    block.columns.length,
    ...block.rows.map((row) => row.cells.length),
    1,
  );

  const columns = Array.from({ length: columnCount }, (_value, index) => {
    const column = block.columns[index];
    if (!column) return {};
    return {
      ...(normalizePositiveInteger(column.width) !== undefined
        ? { width: normalizePositiveInteger(column.width) }
        : {}),
      ...(column.color ? { color: column.color } : {}),
      ...(column.align ? { align: column.align } : {}),
    } satisfies NfmTableColumn;
  });

  const sourceRows = block.rows.length > 0 ? block.rows : [{ cells: [] }];
  const rows = sourceRows.map((row) => ({
    ...(row.color ? { color: row.color } : {}),
    cells: Array.from({ length: columnCount }, (_value, index) =>
      normalizeTableCell(row.cells[index]),
    ),
  }));

  return {
    type: "table",
    ...(block.color ? { color: block.color } : {}),
    rows,
    columns,
    ...(block.headerRow ? { headerRow: true } : {}),
    ...(block.headerColumn ? { headerColumn: true } : {}),
    ...(block.fitPageWidth ? { fitPageWidth: true } : {}),
    ...(block.sourceSyntax ? { sourceSyntax: block.sourceSyntax } : {}),
    children: [],
  };
}

function getLineAtIndent(line: string | undefined, indent: number): string | null {
  if (line === undefined) return null;
  let count = 0;
  for (const char of line) {
    if (char === "\t") count += 1;
    else break;
  }
  if (count !== indent) return null;
  return line.slice(indent);
}

function getLineAtMinimumIndent(line: string | undefined, indent: number): string | null {
  if (line === undefined) return null;
  let count = 0;
  for (const char of line) {
    if (char === "\t") count += 1;
    else break;
  }
  if (count < indent) return null;
  return line.slice(indent);
}

function looksLikeTableRow(line: string): boolean {
  return splitGfmTableRow(line).length > 1;
}

export function splitGfmTableRow(line: string): string[] {
  const trimmed = line.trim();
  const cells: string[] = [];
  let buffer = "";
  let inCode = false;

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    const next = trimmed[index + 1];

    if (char === "\\" && next !== undefined) {
      buffer += char + next;
      index += 1;
      continue;
    }

    if (char === "`") {
      inCode = !inCode;
      buffer += char;
      continue;
    }

    if (char === "|" && !inCode) {
      cells.push(buffer.trim());
      buffer = "";
      continue;
    }

    buffer += char;
  }
  cells.push(buffer.trim());

  if (cells[0] === "") cells.shift();
  if (cells[cells.length - 1] === "") cells.pop();
  return cells;
}

function parseDelimiterCell(value: string): NfmTableAlignment | undefined | null {
  const trimmed = value.trim();
  if (!/^:?-{3,}:?$/.test(trimmed)) return null;
  const starts = trimmed.startsWith(":");
  const ends = trimmed.endsWith(":");
  if (starts && ends) return "center";
  if (starts) return "left";
  if (ends) return "right";
  return undefined;
}

function normalizeCellCount(cells: string[], count: number): string[] {
  return Array.from({ length: count }, (_value, index) => cells[index] ?? "");
}

function createCellFromGfm(value: string): NfmTableCell {
  return { content: parseInlineContent(value) };
}

function parseColumnLine(line: string): NfmTableColumn | null {
  const match = line.match(/^<col(?:\s+([^>]*))?\s*\/?>$/);
  if (!match) return null;

  const attrString = match[1] ?? "";
  const width = normalizePositiveInteger(
    Number.parseInt(getXmlAttr(attrString, "width") ?? "", 10),
  );
  const alignValue = getXmlAttr(attrString, "align");
  const align =
    alignValue === "left" || alignValue === "center" || alignValue === "right"
      ? alignValue
      : undefined;

  return {
    ...(width !== undefined ? { width } : {}),
    ...(parseColorAttr(attrString, "color") ? { color: parseColorAttr(attrString, "color") } : {}),
    ...(align ? { align } : {}),
  };
}

function parseXmlRow(
  lines: string[],
  startLine: number,
  indent: number,
): { row: NfmTableRow; nextLine: number } | null {
  const openLine = getLineAtMinimumIndent(lines[startLine], indent);
  if (openLine === null) return null;

  const openMatch = openLine.trim().match(/^<tr(?:\s+([^>]*))?>$/);
  if (!openMatch) return null;

  const row: NfmTableRow = {
    ...(parseColorAttr(openMatch[1] ?? "", "color")
      ? { color: parseColorAttr(openMatch[1] ?? "", "color") }
      : {}),
    cells: [],
  };
  let cursor = startLine + 1;

  while (cursor < lines.length) {
    const current = getLineAtMinimumIndent(lines[cursor], indent);
    if (current === null) return null;

    const trimmed = current.trim();
    if (trimmed === "</tr>") {
      return { row, nextLine: cursor + 1 };
    }

    const cell = parseXmlCell(trimmed);
    if (cell) row.cells.push(cell);
    cursor += 1;
  }

  return null;
}

function parseXmlCell(line: string): NfmTableCell | null {
  const match = line.match(/^<t[dh](?:\s+([^>]*))?>([\s\S]*)<\/t[dh]>$/);
  if (!match) return null;

  const attrString = match[1] ?? "";
  const colspan = normalizePositiveInteger(
    Number.parseInt(getXmlAttr(attrString, "colspan") ?? "", 10),
  );
  const rowspan = normalizePositiveInteger(
    Number.parseInt(getXmlAttr(attrString, "rowspan") ?? "", 10),
  );

  return {
    content: parseInlineContent(match[2] ?? ""),
    ...(parseColorAttr(attrString, "color") ? { color: parseColorAttr(attrString, "color") } : {}),
    ...(colspan !== undefined && colspan > 1 ? { colspan } : {}),
    ...(rowspan !== undefined && rowspan > 1 ? { rowspan } : {}),
  };
}

function parseColorAttr(attrs: string, name: string): NfmColor | undefined {
  const value = getXmlAttr(attrs, name);
  return value && NFM_COLORS.includes(value as NfmColor) ? (value as NfmColor) : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function normalizeTableCell(cell: NfmTableCell | undefined): NfmTableCell {
  if (!cell) return { content: [] };
  const colspan = normalizePositiveInteger(cell.colspan);
  const rowspan = normalizePositiveInteger(cell.rowspan);
  return {
    content: cell.content,
    ...(cell.color ? { color: cell.color } : {}),
    ...(colspan !== undefined && colspan > 1 ? { colspan } : {}),
    ...(rowspan !== undefined && rowspan > 1 ? { rowspan } : {}),
  };
}

function canSerializeAsGfm(block: NfmTable): boolean {
  if (!block.headerRow) return false;
  if (block.headerColumn || block.fitPageWidth || block.color) return false;
  if (block.rows.length === 0) return false;

  for (const column of block.columns) {
    if (column.width !== undefined || column.color) return false;
  }

  for (const row of block.rows) {
    if (row.color) return false;
    for (const cell of row.cells) {
      if (cell.color || cell.colspan || cell.rowspan) return false;
    }
  }

  return true;
}

function serializeGfmTable(block: NfmTable, indent: number): string[] {
  const prefix = "\t".repeat(indent);
  const header = block.rows[0] ?? { cells: [] };
  const delimiter = block.columns.map((column) => serializeAlignmentDelimiter(column.align));
  return [
    prefix + serializeGfmRow(header.cells),
    prefix + `| ${delimiter.join(" | ")} |`,
    ...block.rows.slice(1).map((row) => prefix + serializeGfmRow(row.cells)),
  ];
}

function serializeGfmRow(cells: readonly Pick<NfmTableCell, "content">[]): string {
  return `| ${cells.map((cell) => serializeInlineContent(cell.content)).join(" | ")} |`;
}

function serializeAlignmentDelimiter(align: NfmTableAlignment | undefined): string {
  if (align === "left") return ":---";
  if (align === "center") return ":---:";
  if (align === "right") return "---:";
  return "---";
}

function serializeXmlTable(block: NfmTable, indent: number): string[] {
  const prefix = "\t".repeat(indent);
  const attrs: string[] = [
    `header-row="${block.headerRow ? "true" : "false"}"`,
    `header-column="${block.headerColumn ? "true" : "false"}"`,
    `fit-page-width="${block.fitPageWidth ? "true" : "false"}"`,
  ];
  if (block.color) attrs.push(`color="${block.color}"`);

  const lines = [`${prefix}<table ${attrs.join(" ")}>`];
  if (block.columns.some((column) => column.width !== undefined || column.color || column.align)) {
    lines.push(`${prefix}\t<colgroup>`);
    for (const column of block.columns) {
      const colAttrs: string[] = [];
      if (column.width !== undefined) colAttrs.push(`width="${column.width}"`);
      if (column.color) colAttrs.push(`color="${column.color}"`);
      if (column.align) colAttrs.push(`align="${column.align}"`);
      lines.push(`${prefix}\t\t<col${colAttrs.length ? ` ${colAttrs.join(" ")}` : ""} />`);
    }
    lines.push(`${prefix}\t</colgroup>`);
  }

  for (const row of block.rows) {
    const rowAttrs = row.color ? ` color="${row.color}"` : "";
    lines.push(`${prefix}\t<tr${rowAttrs}>`);
    for (const cell of row.cells) {
      const cellAttrs: string[] = [];
      if (cell.color) cellAttrs.push(`color="${cell.color}"`);
      if (cell.colspan) cellAttrs.push(`colspan="${cell.colspan}"`);
      if (cell.rowspan) cellAttrs.push(`rowspan="${cell.rowspan}"`);
      lines.push(
        `${prefix}\t\t<td${cellAttrs.length ? ` ${cellAttrs.join(" ")}` : ""}>` +
          `${serializeInlineContent(cell.content)}</td>`,
      );
    }
    lines.push(`${prefix}\t</tr>`);
  }

  lines.push(`${prefix}</table>`);
  return lines;
}

function serializeInlinePlainText(items: NfmInlineContent[]): string {
  const parts: string[] = [];
  let text = "";
  for (const item of items) {
    if (item.type !== "attachment") {
      text += serializeTableInlineText(item);
      continue;
    }
    // Collapse table text across mark boundaries without changing literal file paths.
    parts.push(text.replace(/\s+/gu, " "), serializeAttachmentClipboardText(item));
    text = "";
  }
  parts.push(text.replace(/\s+/gu, " "));
  return parts.join("").trim();
}

function serializeTableInlineText(item: Exclude<NfmInlineContent, { type: "attachment" }>): string {
  if (item.type === "linebreak") return " ";
  if (item.type === "agentConfig") return "<agent-config />";
  if (item.type === "threadMention") return `[Thread: ${item.uuid}]`;
  if (item.type === "pageMention") return `[Page: ${item.targetPageId}]`;
  if (item.type === "dateMention") return formatDateMentionPlainText(item);
  if (item.type === "math") return item.source;
  if (item.type === "link") return item.text;
  return item.text;
}
