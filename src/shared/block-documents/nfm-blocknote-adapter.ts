/**
 * Bidirectional adapter between NfmBlock[] and BlockNote Block[]/PartialBlock[].
 */
import type {
  NfmBlock,
  NfmInlineContent,
  NfmStyleSet,
  NfmColor,
  NfmBgColor,
  NfmTextColor,
  NfmTable,
  NfmTableAlignment,
  NfmTableCell,
  NfmTableColumn,
} from "../nfm/types";
import { NFM_BG_COLORS, NFM_TEXT_COLORS } from "../nfm/types";
import { normalizeOrderedListStart } from "../nfm/ordered-list";
import { normalizeTable } from "../nfm/table";
import {
  normalizeDateMention,
  type NfmDateMentionDateFormat,
  type NfmDateMentionTimeFormat,
} from "../nfm/date-mention";
import { parseInlineContent } from "../nfm/parser-inline";
import { serializeInlineContent } from "../nfm/serializer-inline";
import { MAX_BLOCK_ID_LENGTH } from "./contracts";
import { normalizeBlockChildrenForest } from "./block-children-policy";
import { nfmBlockAcceptsChildren } from "../nfm/block-children";
import { normalizeCodeLanguageId } from "../nfm/code-language-catalog";
import {
  canonicalizePortableRichText,
  type PortableRichText,
  type PortableRichTextItem,
  type PortableRichTextStyles,
} from "./portable-rich-text";

// Portable BlockNote-shaped values keep the codec independent from one schema's
// generated generic types while retaining strict validation-friendly fields.
export interface BlockNoteInlineContentValue {
  readonly type?: string;
  readonly text?: string;
  readonly href?: string;
  readonly styles?: Readonly<Record<string, boolean | string>>;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly content?: readonly BlockNoteInlineContentValue[] | string;
}

export interface BlockNoteBlockValue {
  readonly id?: string;
  readonly type: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly content?: unknown;
  readonly children?: readonly BlockNoteBlockValue[];
}

type BNBlock = BlockNoteBlockValue;
type BNPartialBlock = BlockNoteBlockValue;
type BNInlineContent = BlockNoteInlineContentValue;

// --- NFM → BlockNote ---

/**
 * Convert NFM blocks to BlockNote partial blocks.
 * When `toggleStates` is provided, toggle blocks receive explicit IDs and their
 * open/closed state is recorded in the map (keyed by block ID).
 */
export function nfmToBlockNote(
  blocks: NfmBlock[],
  toggleStates?: Map<string, boolean>,
): BNPartialBlock[] {
  return normalizeBlockChildrenForest(blocks, nfmBlockAcceptsChildren).blocks.map((block) =>
    nfmBlockToBN(block, toggleStates),
  );
}

export function nfmToBlockNoteWithIds(
  blocks: NfmBlock[],
  allocateBlockId: () => string,
): BNPartialBlock[] {
  const allocatedIds = new Set<string>();

  const assignIds = (sourceBlocks: readonly BNPartialBlock[]): BNPartialBlock[] =>
    sourceBlocks.map((block) => {
      const id = allocateBlockId();
      if (
        typeof id !== "string" ||
        id !== id.trim() ||
        id.length === 0 ||
        id.length > MAX_BLOCK_ID_LENGTH ||
        allocatedIds.has(id)
      ) {
        throw new TypeError("Block ID allocator returned an invalid or duplicate identity");
      }
      allocatedIds.add(id);

      const children = Array.isArray(block.children) ? assignIds(block.children) : [];
      return {
        ...block,
        id,
        children,
      };
    });

  return assignIds(nfmToBlockNote(blocks));
}

function nfmBlockToBN(block: NfmBlock, toggleStates?: Map<string, boolean>): BNPartialBlock {
  const children = block.children.map((b) => nfmBlockToBN(b, toggleStates));
  const props = colorToProps(block.color);

  switch (block.type) {
    case "paragraph":
      return {
        type: "paragraph",
        props,
        content: nfmInlineToBN(block.content),
        children,
      };

    case "heading": {
      const isToggleHeading = block.isToggleable === true;
      const headingId = isToggleHeading && toggleStates ? crypto.randomUUID() : undefined;
      if (headingId && toggleStates) {
        toggleStates.set(headingId, block.isOpen === true);
      }
      return {
        ...(headingId ? { id: headingId } : {}),
        type: "heading",
        props: {
          ...props,
          level: block.level,
          ...(isToggleHeading ? { isToggleable: true } : {}),
        },
        content: nfmInlineToBN(block.content),
        children,
      };
    }

    case "bulletListItem":
      return {
        type: "bulletListItem",
        props,
        content: nfmInlineToBN(block.content),
        children,
      };

    case "numberedListItem": {
      const start = normalizeOrderedListStart(block.start);
      return {
        type: "numberedListItem",
        props: {
          ...props,
          ...(start !== undefined ? { start } : {}),
        },
        content: nfmInlineToBN(block.content),
        children,
      };
    }

    case "checkListItem":
      return {
        type: "checkListItem",
        props: { ...props, checked: block.checked },
        content: nfmInlineToBN(block.content),
        children,
      };

    case "toggle": {
      const toggleId = toggleStates ? crypto.randomUUID() : undefined;
      if (toggleId && toggleStates) {
        toggleStates.set(toggleId, block.isOpen === true);
      }
      return {
        ...(toggleId ? { id: toggleId } : {}),
        type: "toggleListItem",
        props,
        content: nfmInlineToBN(block.content),
        children,
      };
    }

    case "blockquote":
      return {
        type: "quote",
        props,
        content: nfmInlineToBN(block.content),
        children,
      };

    case "codeBlock":
      return {
        type: "codeBlock",
        props: { language: normalizeCodeLanguageId(block.language) },
        content: [{ type: "text", text: block.code, styles: {} }],
        children,
      };

    case "mathBlock":
      return {
        type: "mathBlock",
        props: {},
        content: [{ type: "text", text: block.source, styles: {} }],
        children: [],
      };

    case "table": {
      const table = normalizeTable(block);
      return {
        type: "table",
        props,
        content: nfmTableToBN(table),
        children: [],
      };
    }

    case "callout":
      return {
        type: "callout",
        props: { ...props, icon: block.icon || "💡" },
        content: nfmInlineToBN(block.content),
        children,
      };

    case "image":
      return {
        type: "image",
        props: {
          ...props,
          url: block.source,
          caption: serializeInlineContent(block.caption),
          ...(block.previewWidth !== undefined ? { previewWidth: block.previewWidth } : {}),
          ...(block.sourceWidth !== undefined && block.sourceHeight !== undefined
            ? { sourceWidth: block.sourceWidth, sourceHeight: block.sourceHeight }
            : {}),
        },
        children,
      };

    case "databaseViewRef":
      return {
        type: "databaseViewRef",
        props: {
          databaseViewId: block.databaseViewId,
          displayHint: block.displayHint ?? "",
        },
        children: [],
      };

    case "database":
      return {
        id: block.uuid,
        type: "database",
        props: {},
        children: [],
      };

    case "canvas":
      return {
        id: block.uuid,
        type: "canvas",
        props: {},
        children: [],
      };

    case "syncedBlockRef":
      return {
        type: "syncedBlockRef",
        props: { sourceBlockId: block.sourceBlockId },
        children: [],
      };

    case "templateRef":
      return {
        type: "templateRef",
        props: {
          sourceBlockId: block.sourceBlockId,
          displayHint: block.displayHint ?? "",
        },
        children: [],
      };

    case "page":
      return {
        id: block.uuid,
        type: "page",
        props: {},
        children: [],
      };

    case "pageRef": {
      return {
        type: "pageRef",
        props: {
          targetBlockId: block.targetBlockId,
        },
        children: [],
      };
    }

    case "threadSection":
      return {
        type: "threadSection",
        props: {
          label: block.label ?? "",
          threadId: block.threadId ?? "",
        },
        children,
      };

    case "divider":
      return {
        type: "divider",
        children,
      };

    case "emptyBlock":
      return {
        type: "paragraph",
        content: [],
        children,
      };
  }
}

export function nfmInlineToBlockNote(items: NfmInlineContent[]): BlockNoteInlineContentValue[] {
  return nfmInlineToBN(items);
}

function nfmInlineToBN(items: NfmInlineContent[]): BNInlineContent[] {
  return items.map((item) => {
    if (item.type === "linebreak") {
      // BlockNote represents hard breaks as newlines within text
      return { type: "text", text: "\n", styles: {} };
    }

    if (item.type === "attachment") {
      return {
        type: "attachment",
        props: {
          kind: item.kind,
          mode: item.mode,
          source: item.source,
          name: item.name,
          ...(item.mimeType ? { mimeType: item.mimeType } : {}),
          ...(item.kind !== "folder" && item.bytes !== undefined ? { bytes: item.bytes } : {}),
          ...(item.origin ? { origin: item.origin } : {}),
        },
      };
    }

    if (item.type === "agentConfig") {
      return {
        type: "agentConfig",
        props: {
          mode: item.mode ?? "",
          provider: item.provider ?? "",
          model: item.model ?? "",
          reasoning: item.reasoning ?? "",
          speed: item.speed ?? "",
          permission: item.permission ?? "",
          unknownAttributes: item.unknownAttributes?.join(",") ?? "",
          rawAttributes: item.rawAttributes ?? "",
        },
      };
    }

    if (item.type === "threadMention") {
      return {
        type: "threadMention",
        props: {
          uuid: item.uuid,
        },
      };
    }

    if (item.type === "pageMention") {
      return {
        type: "pageMention",
        props: {
          targetPageId: item.targetPageId,
        },
      };
    }

    if (item.type === "dateMention") {
      return {
        type: "dateMention",
        props: {
          start: item.start,
          end: item.end ?? "",
          tz: item.tz ?? "",
          format: item.format ?? "",
          timeFormat: item.timeFormat ?? "",
          reminder: item.reminder ?? "",
        },
      };
    }

    if (item.type === "math") {
      return {
        type: "math",
        props: {},
        content: item.source,
      };
    }

    if (item.type === "link") {
      return {
        type: "link",
        href: item.href,
        content: [{ type: "text", text: item.text, styles: nfmStylesToBN(item.styles) }],
      };
    }

    // text
    return {
      type: "text",
      text: item.text,
      styles: nfmStylesToBN(item.styles),
    };
  });
}

function nfmTableToBN(table: NfmTable): Record<string, unknown> {
  return {
    type: "tableContent",
    columnWidths: table.columns.map((column) => column.width),
    ...(table.headerRow ? { headerRows: 1 } : {}),
    ...(table.headerColumn ? { headerCols: 1 } : {}),
    rows: table.rows.map((row) => ({
      cells: row.cells.map((cell, columnIndex) => {
        const column = table.columns[columnIndex];
        return {
          type: "tableCell",
          props: {
            backgroundColor: tableCellBackgroundToBN(cell, row, column),
            textColor: "default",
            textAlignment: column?.align ?? "left",
            ...(cell.colspan ? { colspan: cell.colspan } : {}),
            ...(cell.rowspan ? { rowspan: cell.rowspan } : {}),
          },
          content: nfmInlineToBN(cell.content),
        };
      }),
    })),
  };
}

function tableCellBackgroundToBN(
  cell: NfmTableCell,
  row: { color?: NfmColor },
  column: NfmTableColumn | undefined,
): string {
  const color = cell.color ?? row.color ?? column?.color;
  if (!color) return "default";
  if (NFM_BG_COLORS.includes(color as NfmBgColor)) {
    return nfmBgToBlockNoteBackground(color as NfmBgColor);
  }
  return color;
}

function nfmStylesToBN(styles: NfmStyleSet): Record<string, boolean | string> {
  const result: Record<string, boolean | string> = {};
  if (styles.bold) result.bold = true;
  if (styles.italic) result.italic = true;
  if (styles.strikethrough) result.strike = true;
  if (styles.underline) result.underline = true;
  if (styles.code) result.code = true;
  if (styles.color) {
    if (NFM_BG_COLORS.includes(styles.color as NfmBgColor)) {
      result.backgroundColor = nfmBgToBlockNoteBackground(styles.color as NfmBgColor);
    } else {
      result.textColor = styles.color;
    }
  }
  return result;
}

function colorToProps(color?: NfmColor): Record<string, string> {
  if (!color) return {};
  if (NFM_BG_COLORS.includes(color as NfmBgColor)) {
    return { backgroundColor: nfmBgToBlockNoteBackground(color as NfmBgColor) };
  }
  return { textColor: color };
}

// --- BlockNote → NFM ---

export function blockNoteToNfm(blocks: readonly unknown[]): NfmBlock[] {
  const converted = blocks
    .map((block) => bnBlockToNfm(readBlockNoteBlock(block)))
    .filter((block): block is NfmBlock => block !== null);
  return [...normalizeBlockChildrenForest(converted, nfmBlockAcceptsChildren).blocks];
}

function readBlockNoteBlock(value: unknown): BNBlock {
  if (!isRecord(value)) {
    throw new TypeError("BlockNote block must be an object");
  }

  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    type: typeof value.type === "string" ? value.type : "",
    ...(isRecord(value.props) ? { props: value.props } : {}),
    ...(Object.prototype.hasOwnProperty.call(value, "content") ? { content: value.content } : {}),
    ...(Array.isArray(value.children) ? { children: value.children.map(readBlockNoteBlock) } : {}),
  };
}

function normalizeCodeBlockLanguage(language: unknown): string {
  const normalizedLanguage = normalizeCodeLanguageId(language);
  return normalizedLanguage === "text" ? "" : normalizedLanguage;
}

function bnBlockToNfm(block: BNBlock): NfmBlock | null {
  const children = block.children ? blockNoteToNfm(block.children) : [];
  const color = propsToColor(block.props);

  switch (block.type) {
    case "paragraph": {
      const content = bnInlineToNfm(block.content);
      if (content.length === 0 && color === undefined) {
        return { type: "emptyBlock", children };
      }

      return { type: "paragraph", content, color, children };
    }

    case "heading": {
      const rawLevel = block.props?.level;
      const levelValue = typeof rawLevel === "number" ? rawLevel : 1;
      const level = Math.min(Math.max(levelValue, 1), 4) as 1 | 2 | 3 | 4;
      return {
        type: "heading",
        level,
        ...(block.props?.isToggleable === true ? { isToggleable: true } : {}),
        content: bnInlineToNfm(block.content),
        color,
        children,
      };
    }

    case "bulletListItem":
      return {
        type: "bulletListItem",
        content: bnInlineToNfm(block.content),
        color,
        children,
      };

    case "numberedListItem": {
      const start = normalizeOrderedListStart(block.props?.start);
      return {
        type: "numberedListItem",
        ...(start !== undefined ? { start } : {}),
        content: bnInlineToNfm(block.content),
        color,
        children,
      };
    }

    case "checkListItem":
      return {
        type: "checkListItem",
        checked: block.props?.checked === true,
        content: bnInlineToNfm(block.content),
        color,
        children,
      };

    case "toggleListItem":
      return {
        type: "toggle",
        content: bnInlineToNfm(block.content),
        color,
        children,
      };

    case "quote":
      return {
        type: "blockquote",
        content: bnInlineToNfm(block.content),
        color,
        children,
      };

    case "codeBlock": {
      // Extract plain text from inline content
      const code = extractCodeText(block.content);
      return {
        type: "codeBlock",
        language: normalizeCodeBlockLanguage(block.props?.language),
        code,
        children,
      };
    }

    case "mathBlock":
      return {
        type: "mathBlock",
        source: extractPlainBlockSource(block.content),
        children: [],
      };

    case "table":
      return bnTableToNfm(block, color);

    case "callout":
      return {
        type: "callout",
        icon: normalizeString(block.props?.icon),
        content: bnInlineToNfm(block.content),
        color,
        children,
      };

    case "image": {
      const source = normalizeImageUrl(block.props?.url);
      if (source === null) return null;
      const caption = normalizeImageCaption(block.props?.caption);
      const previewWidth = normalizePreviewWidth(block.props?.previewWidth);
      const sourceWidth = normalizePreviewWidth(block.props?.sourceWidth);
      const sourceHeight = normalizePreviewWidth(block.props?.sourceHeight);

      return {
        type: "image",
        source,
        caption,
        ...(previewWidth !== undefined ? { previewWidth } : {}),
        ...(sourceWidth !== undefined && sourceHeight !== undefined
          ? { sourceWidth, sourceHeight }
          : {}),
        color,
        children,
      };
    }

    case "databaseViewRef": {
      const databaseViewId = normalizeString(block.props?.databaseViewId) ?? "";
      const displayHint = normalizeString(block.props?.displayHint);

      return {
        type: "databaseViewRef",
        databaseViewId,
        ...(displayHint !== undefined ? { displayHint } : {}),
        children: [],
      };
    }

    case "database":
      if (!block.id) {
        throw new TypeError("Canonical Database Block requires an identity");
      }
      return {
        type: "database",
        uuid: block.id,
        children: [],
      };

    case "canvas":
      if (!block.id) {
        throw new TypeError("Canonical Canvas Block requires an identity");
      }
      return {
        type: "canvas",
        uuid: block.id,
        children: [],
      };

    case "syncedBlockRef":
      return {
        type: "syncedBlockRef",
        sourceBlockId: normalizeString(block.props?.sourceBlockId) ?? "",
        children: [],
      };

    case "templateRef":
      return {
        type: "templateRef",
        sourceBlockId: normalizeString(block.props?.sourceBlockId) ?? "",
        ...(normalizeString(block.props?.displayHint) === undefined
          ? {}
          : { displayHint: normalizeString(block.props?.displayHint) }),
        children: [],
      };

    case "page":
      if (!block.id) {
        throw new TypeError("Canonical Page Block requires an identity");
      }
      return {
        type: "page",
        uuid: block.id,
        children: [],
      };

    case "pageRef": {
      const targetBlockId = normalizeString(block.props?.targetBlockId);
      return {
        type: "pageRef",
        targetBlockId: targetBlockId ?? "",
        children: [],
      };
    }

    case "threadSection": {
      const label = normalizeString(block.props?.label);
      const threadId = normalizeString(block.props?.threadId);

      return {
        type: "threadSection",
        ...(label !== undefined && label.length > 0 ? { label } : {}),
        ...(threadId !== undefined && threadId.length > 0 ? { threadId } : {}),
        children,
      };
    }

    case "divider":
      return { type: "divider", children };

    default:
      // Unknown block type - convert to paragraph if it has content
      if (block.content && Array.isArray(block.content)) {
        return {
          type: "paragraph",
          content: bnInlineToNfm(block.content),
          color,
          children,
        };
      }
      return null;
  }
}

function bnTableToNfm(block: BNBlock, color: NfmColor | undefined): NfmTable {
  const content = isRecord(block.content) ? block.content : {};
  const sourceRows = Array.isArray(content.rows) ? content.rows : [];
  const rows = sourceRows.map((row: { cells?: unknown[] }) => ({
    cells: Array.isArray(row.cells) ? row.cells.map(readBNTableCell) : [],
  }));
  const columnCount = Math.max(
    Array.isArray(content.columnWidths) ? content.columnWidths.length : 0,
    ...rows.map((row: { cells: NfmTableCell[] }) => row.cells.length),
    1,
  );
  const columns = Array.from({ length: columnCount }, (_value, index) => {
    const width = Array.isArray(content.columnWidths)
      ? normalizePositiveNumber(content.columnWidths[index])
      : undefined;
    const align = resolveBNTableColumnAlignment(sourceRows, index);
    return {
      ...(width !== undefined ? { width } : {}),
      ...(align ? { align } : {}),
    };
  });

  return normalizeTable({
    type: "table",
    ...(color ? { color } : {}),
    rows,
    columns,
    ...(normalizePositiveNumber(content.headerRows) !== undefined ? { headerRow: true } : {}),
    ...(normalizePositiveNumber(content.headerCols) !== undefined ? { headerColumn: true } : {}),
    children: [],
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBNTableCell(cell: unknown): NfmTableCell {
  if (Array.isArray(cell)) {
    return { content: bnInlineToNfm(cell) };
  }

  if (!cell || typeof cell !== "object") {
    return { content: [] };
  }

  const candidate = cell as {
    content?: BNInlineContent[];
    props?: Record<string, unknown>;
  };
  const color = propsToColor(candidate.props);
  const colspan = normalizePositiveNumber(candidate.props?.colspan);
  const rowspan = normalizePositiveNumber(candidate.props?.rowspan);

  return {
    content: bnInlineToNfm(candidate.content),
    ...(color ? { color } : {}),
    ...(colspan !== undefined && colspan > 1 ? { colspan } : {}),
    ...(rowspan !== undefined && rowspan > 1 ? { rowspan } : {}),
  };
}

function resolveBNTableColumnAlignment(
  rows: unknown[],
  columnIndex: number,
): NfmTableAlignment | undefined {
  const alignments = rows
    .map((row) => {
      if (!row || typeof row !== "object") return undefined;
      const cells = (row as { cells?: unknown[] }).cells;
      if (!Array.isArray(cells)) return undefined;
      const cell = cells[columnIndex];
      if (!cell || typeof cell !== "object" || Array.isArray(cell)) return undefined;
      return normalizeTableAlignment(
        (cell as { props?: Record<string, unknown> }).props?.textAlignment,
      );
    })
    .filter((value): value is NfmTableAlignment => value !== undefined);

  if (alignments.length === 0) return undefined;
  const first = alignments[0];
  if (first === "left") return undefined;
  return alignments.every((alignment) => alignment === first) ? first : undefined;
}

function normalizeTableAlignment(value: unknown): NfmTableAlignment | undefined {
  if (value === "left" || value === "center" || value === "right") return value;
  return undefined;
}

export function blockNoteInlineToNfm(content: unknown): NfmInlineContent[] {
  return bnInlineToNfm(content);
}

/** Converts the title-safe inline subset used by atomic Page mention mutations. */
export function blockNoteInlineToPortableRichText(content: unknown): PortableRichText {
  if (!Array.isArray(content)) {
    throw new TypeError("Page mention mutation content must be an inline content array");
  }
  const supportedTypes = new Set(["text", "link", "threadMention", "pageMention", "dateMention"]);
  for (const item of content) {
    const type = isRecord(item) && typeof item.type === "string" ? item.type : null;
    if (type && supportedTypes.has(type)) continue;
    throw new TypeError(
      `Inline ${type ?? "content"} cannot participate in a Page mention mutation`,
    );
  }
  const portableStyles = (styles: NfmStyleSet): PortableRichTextStyles => ({
    ...(styles.bold ? { bold: true } : {}),
    ...(styles.italic ? { italic: true } : {}),
    ...(styles.underline ? { underline: true } : {}),
    ...(styles.strikethrough ? { strikethrough: true } : {}),
    ...(styles.code ? { code: true } : {}),
    ...(styles.color ? { color: styles.color } : {}),
  });
  const items = bnInlineToNfm(content).map((item): PortableRichTextItem => {
    if (item.type === "text" || item.type === "link") {
      return { ...item, styles: portableStyles(item.styles) };
    }
    if (
      item.type === "linebreak" ||
      item.type === "threadMention" ||
      item.type === "pageMention" ||
      item.type === "dateMention"
    ) {
      return item;
    }
    throw new TypeError(`Inline ${item.type} cannot participate in a Page mention mutation`);
  });
  return canonicalizePortableRichText(items);
}

function bnInlineToNfm(content: unknown): NfmInlineContent[] {
  if (!content || !Array.isArray(content)) return [];
  const items: NfmInlineContent[] = [];

  for (const item of content) {
    if (!item || !item.type) continue;

    if (item.type === "attachment") {
      const kind = normalizeString(item.props?.kind);
      const mode = normalizeString(item.props?.mode);
      const source = normalizeString(item.props?.source);
      const name = normalizeString(item.props?.name);
      const mimeType = normalizeString(item.props?.mimeType);
      const bytes = normalizeNonNegativeNumber(item.props?.bytes);
      const origin = normalizeString(item.props?.origin);

      if (
        (kind !== "text" && kind !== "file" && kind !== "folder") ||
        (mode !== "materialized" && mode !== "link") ||
        !source ||
        !name
      ) {
        continue;
      }

      items.push({
        type: "attachment",
        kind,
        mode,
        source,
        name,
        ...(mimeType ? { mimeType } : {}),
        ...(kind !== "folder" && bytes !== undefined ? { bytes } : {}),
        ...(origin ? { origin } : {}),
      });
    } else if (item.type === "agentConfig") {
      const props = item.props ?? {};
      const mode = normalizeString(props.mode);
      const provider = normalizeString(props.provider);
      const model = normalizeString(props.model);
      const reasoning = normalizeString(props.reasoning);
      const speed = normalizeString(props.speed);
      const permission = normalizeString(props.permission);
      const unknownAttributes = (normalizeString(props.unknownAttributes) ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      const rawAttributes = normalizeString(props.rawAttributes);

      items.push({
        type: "agentConfig",
        ...(mode ? { mode } : {}),
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(reasoning ? { reasoning } : {}),
        ...(speed ? { speed } : {}),
        ...(permission ? { permission } : {}),
        ...(unknownAttributes.length > 0 ? { unknownAttributes } : {}),
        ...(rawAttributes ? { rawAttributes } : {}),
      });
    } else if (item.type === "threadMention") {
      const uuid = normalizeString(item.props?.uuid)?.trim();
      if (!uuid) continue;

      items.push({
        type: "threadMention",
        uuid,
      });
    } else if (item.type === "pageMention") {
      const targetPageId = normalizeString(item.props?.targetPageId)?.trim();
      if (!targetPageId) continue;

      items.push({
        type: "pageMention",
        targetPageId,
      });
    } else if (item.type === "dateMention") {
      const normalized = normalizeDateMention({
        type: "dateMention",
        start: normalizeString(item.props?.start),
        end: normalizeString(item.props?.end),
        tz: normalizeString(item.props?.tz),
        format: normalizeString(item.props?.format) as NfmDateMentionDateFormat | undefined,
        timeFormat: normalizeString(item.props?.timeFormat) as NfmDateMentionTimeFormat | undefined,
        reminder: normalizeString(item.props?.reminder),
      });
      if (!normalized) continue;

      items.push(normalized);
    } else if (item.type === "math") {
      if (typeof item.content !== "string") continue;
      items.push({ type: "math", source: item.content });
    } else if (item.type === "link") {
      // Link content is StyledText[]. Flatten to plain text + first style set.
      // NFM links don't support per-span formatting, so we take the dominant style.
      const contentArr = Array.isArray(item.content) ? item.content : [];
      const text = contentArr.map((c: BNInlineContent) => c.text || "").join("");
      const styles =
        contentArr.length > 0 && contentArr[0].styles ? bnStylestoNfm(contentArr[0].styles) : {};
      pushLinkWithLinebreaks(items, text, item.href ?? "", styles);
    } else if (item.type === "text") {
      pushTextWithLinebreaks(items, item.text ?? "", bnStylestoNfm(item.styles || {}));
    }
  }

  return items;
}

function pushTextWithLinebreaks(items: NfmInlineContent[], text: string, styles: NfmStyleSet) {
  const parts = text.split("\n");

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part) {
      items.push({
        type: "text",
        text: part,
        styles,
      });
    }

    if (index < parts.length - 1) {
      items.push({ type: "linebreak" });
    }
  }
}

function pushLinkWithLinebreaks(
  items: NfmInlineContent[],
  text: string,
  href: string,
  styles: NfmStyleSet,
) {
  const parts = text.split("\n");

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part) {
      items.push({
        type: "link",
        text: part,
        href,
        styles,
      });
    }

    if (index < parts.length - 1) {
      items.push({ type: "linebreak" });
    }
  }
}

function bnStylestoNfm(styles: Record<string, boolean | string>): NfmStyleSet {
  const result: NfmStyleSet = {};
  if (styles.bold) result.bold = true;
  if (styles.italic) result.italic = true;
  if (styles.strike) result.strikethrough = true;
  if (styles.underline) result.underline = true;
  if (styles.code) result.code = true;

  // Map textColor/backgroundColor to NfmColor
  const textColor = toNfmTextColor(styles.textColor);
  if (textColor) {
    result.color = textColor;
  }
  if (styles.backgroundColor && styles.backgroundColor !== "default") {
    const mapped = blockNoteBackgroundToNfmBg(styles.backgroundColor);
    if (mapped) result.color = mapped;
  }

  return result;
}

function propsToColor(props?: Record<string, unknown>): NfmColor | undefined {
  if (!props) return undefined;
  if (props.backgroundColor && props.backgroundColor !== "default") {
    return blockNoteBackgroundToNfmBg(props.backgroundColor);
  }
  return toNfmTextColor(props.textColor);
}

function toNfmTextColor(value: unknown): NfmTextColor | undefined {
  if (typeof value !== "string" || value === "default") return undefined;
  return NFM_TEXT_COLORS.includes(value as NfmTextColor) ? (value as NfmTextColor) : undefined;
}

function nfmBgToBlockNoteBackground(color: NfmBgColor): string {
  const mapping: Record<NfmBgColor, string> = {
    gray_bg: "gray",
    brown_bg: "brown",
    orange_bg: "orange",
    yellow_bg: "yellow",
    green_bg: "green",
    blue_bg: "blue",
    purple_bg: "purple",
    pink_bg: "pink",
    red_bg: "red",
  };

  return mapping[color];
}

function blockNoteBackgroundToNfmBg(value: unknown): NfmBgColor | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  const mapping: Record<string, NfmBgColor> = {
    gray: "gray_bg",
    brown: "brown_bg",
    orange: "orange_bg",
    yellow: "yellow_bg",
    green: "green_bg",
    blue: "blue_bg",
    purple: "purple_bg",
    pink: "pink_bg",
    red: "red_bg",
  };

  return mapping[normalized];
}

function extractPlainBlockSource(content: unknown): string {
  if (!content || !Array.isArray(content)) return "";
  return content.map((item: BNInlineContent) => item.text || "").join("");
}

const extractCodeText = extractPlainBlockSource;

function normalizeImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim();
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function normalizeNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function normalizePositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function normalizeImageCaption(value: unknown): NfmInlineContent[] {
  if (typeof value !== "string" || value.length === 0) return [];
  return parseInlineContent(value);
}

function normalizePreviewWidth(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
