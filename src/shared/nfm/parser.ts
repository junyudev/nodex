import type {
  NfmBlock,
  NfmPageRef,
  NfmPage,
  NfmDatabase,
  NfmDatabaseViewRef,
  NfmColor,
  NfmInlineContent,
  NfmCallout,
  NfmCanvas,
  NfmImage,
  NfmThreadSection,
  NfmSyncedBlockRef,
  NfmReusableTemplateRef,
} from "./types";
import { NFM_COLORS } from "./types";
import { nfmBlockAcceptsChildren } from "./block-children";
import { normalizeOrderedListStart } from "./ordered-list";
import { parseInlineContent } from "./parser-inline";
import { tryParseGfmTable, tryParseNfmTableXml } from "./table";
import { getXmlAttr } from "./xml-attributes";
import { parsePageDeepLink } from "../nodex-deeplink";

/**
 * Parse a Notion-flavored Markdown string into a block tree.
 */
export function parseNfm(input: string): NfmBlock[] {
  if (!input.trim()) return [];

  const lines = input.split("\n");
  const rootBlocks: NfmBlock[] = [];

  // Stack for tracking nesting: each entry is { indent, block }
  const stack: Array<{ indent: number; block: NfmBlock }> = [];

  let i = 0;

  function addBlock(block: NfmBlock, indent: number) {
    // Pop stack until we find a parent at a lower indent level
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    if (stack.length === 0) {
      rootBlocks.push(block);
    } else {
      stack[stack.length - 1].block.children.push(block);
    }

    stack.push({ indent, block });
  }

  while (i < lines.length) {
    const line = lines[i];

    // Count leading tabs for indentation
    const indent = countLeadingTabs(line);
    const content = line.slice(indent);

    // Skip empty lines (without <empty-block/>)
    if (content.trim() === "") {
      i++;
      continue;
    }

    // Empty block
    if (content.trim() === "<empty-block/>") {
      addBlock({ type: "emptyBlock", children: [] }, indent);
      i++;
      continue;
    }

    // Divider: exactly ---
    if (content.trim() === "---") {
      addBlock({ type: "divider", children: [] }, indent);
      i++;
      continue;
    }

    const gfmTable = tryParseGfmTable(lines, i, indent);
    if (gfmTable) {
      addBlock(gfmTable.block, indent);
      i = gfmTable.nextLine;
      continue;
    }

    const mathFenceLength = parseMathFenceOpen(content);
    if (mathFenceLength !== null) {
      const closingLine = findClosingMathFence(lines, i + 1, indent, mathFenceLength);
      if (closingLine !== -1) {
        const sourceLines = lines
          .slice(i + 1, closingLine)
          .map((sourceLine) => sourceLine.slice(indent));
        addBlock(
          {
            type: "mathBlock",
            source: sourceLines.join("\n"),
            children: [],
          },
          indent,
        );
        i = closingLine + 1;
        continue;
      }
    }

    const codeFence = parseCodeFenceOpen(content);
    if (codeFence) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length) {
        const codeLine = lines[i];
        const codeContent = codeLine.slice(indent); // strip same indent level
        if (isClosingCodeFence(codeContent, codeFence.marker, codeFence.length)) {
          i++;
          break;
        }
        codeLines.push(codeContent);
        i++;
      }
      addBlock(
        {
          type: "codeBlock",
          language: codeFence.language,
          code: codeLines.join("\n"),
          children: [],
        },
        indent,
      );
      continue;
    }

    // Callout: <callout icon="..." color="...">
    if (content.trimStart().startsWith("<callout")) {
      const callout = parseCallout(lines, i, indent);
      if (callout) {
        addBlock(callout.block, indent);
        i = callout.nextLine;
        continue;
      }
    }

    if (content.trimStart().startsWith("<table")) {
      const table = tryParseNfmTableXml(lines, i, indent);
      if (table) {
        addBlock(table.block, indent);
        i = table.nextLine;
        continue;
      }
    }

    // Image: <image source="...">Caption</image>
    if (content.trimStart().startsWith("<image")) {
      const image = parseImage(content.trim());
      if (image) {
        addBlock(image, indent);
        i++;
        continue;
      }
    }

    if (content.trimStart().startsWith("<database-view-ref")) {
      const databaseViewRef = parseDatabaseViewRef(content.trim());
      if (databaseViewRef) {
        addBlock(databaseViewRef, indent);
        i++;
        continue;
      }
    }

    if (content.trimStart().startsWith("<database")) {
      const database = parseDatabase(content.trim());
      if (database) {
        addBlock(database, indent);
        i++;
        continue;
      }
    }

    if (content.trimStart().startsWith("<canvas")) {
      const canvas = parseCanvas(content.trim());
      if (canvas) {
        addBlock(canvas, indent);
        i++;
        continue;
      }
    }

    if (content.trimStart().startsWith("<synced-block-ref")) {
      const syncedBlockRef = parseSyncedBlockRef(content.trim());
      if (syncedBlockRef) {
        addBlock(syncedBlockRef, indent);
        i++;
        continue;
      }
    }

    if (content.trimStart().startsWith("<template-ref")) {
      const templateRef = parseReusableTemplateRef(content.trim());
      if (templateRef) {
        addBlock(templateRef, indent);
        i++;
        continue;
      }
    }

    if (content.trimStart().startsWith("<thread-section")) {
      const threadSection = parseThreadSection(content.trim());
      if (threadSection) {
        addBlock(threadSection, indent);
        i++;
        continue;
      }
    }

    if (content.trimStart().startsWith("<page-ref")) {
      const pageRef = parsePageRef(content.trim());
      if (pageRef) {
        addBlock(pageRef, indent);
        i++;
        continue;
      }
    }

    if (content.trimStart().startsWith("<page")) {
      const page = parsePage(content.trim());
      if (page) {
        addBlock(page, indent);
        i++;
        continue;
      }
    }

    // Extract color attribute from end of line
    const { text: stripped, color } = extractBlockColor(content);

    // Toggle heading: ▶# or ▼# through ▶#### or ▼####
    const toggleHeadingMatch = stripped.match(/^([▶▼])(#{1,4})\s+(.*)$/);
    if (toggleHeadingMatch) {
      const isOpen = toggleHeadingMatch[1] === "▼";
      const level = toggleHeadingMatch[2].length as 1 | 2 | 3 | 4;
      addBlock(
        {
          type: "heading",
          level,
          isToggleable: true,
          ...(isOpen ? { isOpen } : {}),
          content: parseInlineContent(toggleHeadingMatch[3]),
          color,
          children: [],
        },
        indent,
      );
      i++;
      continue;
    }

    // Heading: # through ####
    const headingMatch = stripped.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3 | 4;
      addBlock(
        {
          type: "heading",
          level,
          content: parseInlineContent(headingMatch[2]),
          color,
          children: [],
        },
        indent,
      );
      i++;
      continue;
    }

    // Toggle: ▶ text (collapsed) or ▼ text (expanded)
    if (stripped.startsWith("▶ ") || stripped.startsWith("▼ ")) {
      const isOpen = stripped.startsWith("▼");
      addBlock(
        {
          type: "toggle",
          ...(isOpen ? { isOpen } : {}),
          content: parseInlineContent(stripped.slice(2)),
          color,
          children: [],
        },
        indent,
      );
      i++;
      continue;
    }

    // Checkbox: - [ ] or - [x]
    const checkMatch = stripped.match(/^- \[([ x])\]\s+(.*)$/);
    if (checkMatch) {
      addBlock(
        {
          type: "checkListItem",
          checked: checkMatch[1] === "x",
          content: parseInlineContent(checkMatch[2]),
          color,
          children: [],
        },
        indent,
      );
      i++;
      continue;
    }

    // Bulleted list: - text
    if (stripped.startsWith("- ")) {
      addBlock(
        {
          type: "bulletListItem",
          content: parseInlineContent(stripped.slice(2)),
          color,
          children: [],
        },
        indent,
      );
      i++;
      continue;
    }

    // Numbered list: N. text
    const numMatch = stripped.match(/^(\d+)\.\s+(.*)$/);
    if (numMatch) {
      const start = normalizeOrderedListStart(Number.parseInt(numMatch[1], 10));
      addBlock(
        {
          type: "numberedListItem",
          ...(start !== undefined ? { start } : {}),
          content: parseInlineContent(numMatch[2]),
          color,
          children: [],
        },
        indent,
      );
      i++;
      continue;
    }

    // Blockquote: > text
    if (stripped.startsWith("> ") || stripped === ">") {
      const quoteText = stripped === ">" ? "" : stripped.slice(2);
      addBlock(
        {
          type: "blockquote",
          content: parseInlineContent(quoteText),
          color,
          children: [],
        },
        indent,
      );
      i++;
      continue;
    }

    // Paragraph (default)
    addBlock(
      {
        type: "paragraph",
        content: parseInlineContent(stripped),
        color,
        children: [],
      },
      indent,
    );
    i++;
  }

  normalizeChildlessChildren(rootBlocks);
  return rootBlocks;
}

type CodeFenceMarker = "`" | "~";

function parseMathFenceOpen(content: string): number | null {
  const trimmed = content.trimEnd();
  if (trimmed.length < 2) return null;
  for (const char of trimmed) {
    if (char !== "$") return null;
  }
  return trimmed.length;
}

function findClosingMathFence(
  lines: readonly string[],
  startLine: number,
  indent: number,
  fenceLength: number,
): number {
  const fence = "$".repeat(fenceLength);
  for (let lineIndex = startLine; lineIndex < lines.length; lineIndex += 1) {
    if (lines[lineIndex]!.slice(indent).trimEnd() === fence) return lineIndex;
  }
  return -1;
}

interface CodeFenceOpen {
  marker: CodeFenceMarker;
  length: number;
  language: string;
}

function parseCodeFenceOpen(content: string): CodeFenceOpen | null {
  const marker = content[0];
  if (marker !== "`" && marker !== "~") return null;

  let length = 0;
  while (content[length] === marker) {
    length += 1;
  }
  if (length < 3) return null;

  return {
    marker,
    length,
    language: content.slice(length).trim(),
  };
}

function isClosingCodeFence(
  content: string,
  marker: CodeFenceMarker,
  minimumLength: number,
): boolean {
  const trimmed = content.trimEnd();
  if (trimmed.length < minimumLength) return false;

  for (const char of trimmed) {
    if (char !== marker) return false;
  }

  return true;
}

function countLeadingTabs(line: string): number {
  let count = 0;
  for (const ch of line) {
    if (ch === "\t") count++;
    else break;
  }
  return count;
}

/**
 * Extract a trailing {color="Color"} attribute from a line.
 * Returns the stripped text and the color (if any).
 */
function extractBlockColor(text: string): { text: string; color?: NfmColor } {
  const colorRe = /\s*\{color="([^"]+)"\}\s*$/;
  const match = text.match(colorRe);
  if (match && NFM_COLORS.includes(match[1] as NfmColor)) {
    return {
      text: text.slice(0, match.index).trimEnd(),
      color: match[1] as NfmColor,
    };
  }
  return { text };
}

/**
 * Parse a <callout> block spanning multiple lines.
 */
function parseCallout(
  lines: string[],
  startLine: number,
  baseIndent: number,
): { block: NfmCallout; nextLine: number } | null {
  const openLine = lines[startLine].slice(baseIndent);
  const openMatch = openLine.match(/^<callout(?:\s+icon="([^"]*)")?(?:\s+color="([^"]*)")?\s*>/);
  if (!openMatch) return null;

  const icon = openMatch[1] || undefined;
  const color = openMatch[2] as NfmColor | undefined;

  // Collect content lines until </callout>
  const contentLines: string[] = [];
  let i = startLine + 1;
  while (i < lines.length) {
    const line = lines[i];
    const lineContent = line.slice(baseIndent);
    if (lineContent.trimEnd() === "</callout>") {
      i++;
      break;
    }
    // Strip one level of indentation (callout children are indented)
    const innerContent = lineContent.startsWith("\t") ? lineContent.slice(1) : lineContent;
    contentLines.push(innerContent);
    i++;
  }

  // Parse the content lines as NFM blocks (recursive)
  const innerBlocks = parseNfm(contentLines.join("\n"));

  // The first text line is the inline content; rest are children
  // In NFM, callout contains: inline rich text on first line, then children
  let inlineContent: NfmInlineContent[] = [];
  const childBlocks: NfmBlock[] = [];

  for (const block of innerBlocks) {
    if (inlineContent.length === 0 && block.type === "paragraph") {
      inlineContent = block.content;
    } else {
      childBlocks.push(block);
    }
  }

  return {
    block: {
      type: "callout",
      icon,
      color,
      content: inlineContent,
      children: childBlocks,
    },
    nextLine: i,
  };
}

function parseImage(line: string): NfmImage | null {
  const match = line.match(/^<image\s+([^>]*)>([\s\S]*?)<\/image>$/);
  if (!match) return null;

  const attrString = match[1];
  const caption = match[2];

  const source = getXmlAttr(attrString, "source");
  if (source === undefined) return null;

  const colorValue = getXmlAttr(attrString, "color");
  const color =
    colorValue && NFM_COLORS.includes(colorValue as NfmColor)
      ? (colorValue as NfmColor)
      : undefined;

  const previewWidthRaw =
    getXmlAttr(attrString, "preview-width") ?? getXmlAttr(attrString, "previewWidth");
  const previewWidth = previewWidthRaw ? Number.parseInt(previewWidthRaw, 10) : undefined;
  const sourceWidthRaw =
    getXmlAttr(attrString, "source-width") ?? getXmlAttr(attrString, "sourceWidth");
  const sourceHeightRaw =
    getXmlAttr(attrString, "source-height") ?? getXmlAttr(attrString, "sourceHeight");
  const sourceWidth = sourceWidthRaw ? Number.parseInt(sourceWidthRaw, 10) : undefined;
  const sourceHeight = sourceHeightRaw ? Number.parseInt(sourceHeightRaw, 10) : undefined;
  const hasSourceDimensions =
    sourceWidth !== undefined &&
    Number.isFinite(sourceWidth) &&
    sourceWidth > 0 &&
    sourceHeight !== undefined &&
    Number.isFinite(sourceHeight) &&
    sourceHeight > 0;

  return {
    type: "image",
    source,
    caption: parseInlineContent(caption),
    ...(previewWidth !== undefined && Number.isFinite(previewWidth) && previewWidth > 0
      ? { previewWidth }
      : {}),
    ...(hasSourceDimensions ? { sourceWidth, sourceHeight } : {}),
    color,
    children: [],
  };
}

function parseDatabaseViewRef(line: string): NfmDatabaseViewRef | null {
  const match = line.match(/^<database-view-ref(?:\s+([^>]*))?\s*\/>$/);
  if (!match) return null;

  const attrString = match[1] ?? "";
  const databaseViewId = getXmlAttr(attrString, "database-view") ?? "";
  const displayHint = getXmlAttr(attrString, "display-hint");

  return {
    type: "databaseViewRef",
    databaseViewId,
    ...(displayHint !== undefined ? { displayHint } : {}),
    children: [],
  };
}

function parseSyncedBlockRef(line: string): NfmSyncedBlockRef | null {
  const match = line.match(/^<synced-block-ref(?:\s+([^>]*))?\s*\/>$/);
  if (!match) return null;
  return {
    type: "syncedBlockRef",
    sourceBlockId: getXmlAttr(match[1] ?? "", "source-block") ?? "",
    children: [],
  };
}

function parseReusableTemplateRef(line: string): NfmReusableTemplateRef | null {
  const match = line.match(/^<template-ref(?:\s+([^>]*))?\s*\/>$/);
  if (!match) return null;
  const attributes = match[1] ?? "";
  const displayHint = getXmlAttr(attributes, "display-hint");
  return {
    type: "templateRef",
    sourceBlockId: getXmlAttr(attributes, "source-block") ?? "",
    ...(displayHint === undefined ? {} : { displayHint }),
    children: [],
  };
}

function parsePage(line: string): NfmPage | null {
  const match = line.match(/^<page(?:\s+([^>]*))?\s*\/>$/);
  if (!match) return null;
  const uuid = getXmlAttr(match[1] ?? "", "uuid");
  if (!uuid || uuid !== uuid.trim()) {
    throw new TypeError("Canonical Page NFM requires an exact non-empty uuid");
  }
  return { type: "page", uuid, children: [] };
}

function parseDatabase(line: string): NfmDatabase | null {
  const match = line.match(/^<database(?:\s+([^>]*))?\s*\/>$/);
  if (!match) return null;
  const uuid = getXmlAttr(match[1] ?? "", "uuid");
  if (!uuid || uuid !== uuid.trim()) {
    throw new TypeError("Canonical Database NFM requires an exact non-empty uuid");
  }
  return { type: "database", uuid, children: [] };
}

function parseCanvas(line: string): NfmCanvas | null {
  const match = line.match(/^<canvas(?:\s+([^>]*))?\s*\/>$/);
  if (!match) return null;
  const uuid = getXmlAttr(match[1] ?? "", "uuid");
  if (!uuid || uuid !== uuid.trim()) {
    throw new TypeError("Canonical Canvas NFM requires an exact non-empty uuid");
  }
  return { type: "canvas", uuid, children: [] };
}

function parsePageRef(line: string): NfmPageRef | null {
  const match = line.match(/^<page-ref(?:\s+([^>]*))?\s*\/>$/);
  if (!match) return null;
  const url = getXmlAttr(match[1] ?? "", "url") ?? "";
  const target = parsePageDeepLink(url);
  if (!target) {
    throw new TypeError("Page reference URL must identify a Nodex Page");
  }
  return {
    type: "pageRef",
    targetBlockId: target.pageId,
    children: [],
  };
}

function parseThreadSection(line: string): NfmThreadSection | null {
  const match = line.match(/^<thread-section(?:\s+([^>]*))?\s*\/>$/);
  if (!match) return null;

  const attrString = match[1] ?? "";
  const label = getXmlAttr(attrString, "label") ?? "";
  const threadId = getXmlAttr(attrString, "thread") ?? "";

  return {
    type: "threadSection",
    ...(label.length > 0 ? { label } : {}),
    ...(threadId.length > 0 ? { threadId } : {}),
    children: [],
  };
}

function normalizeChildlessChildren(blocks: NfmBlock[]): void {
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (supportsNestedChildren(block)) {
      normalizeChildlessChildren(block.children);
      continue;
    }

    if (block.children.length === 0) continue;
    blocks.splice(index + 1, 0, ...block.children);
    block.children = [];
  }
}

function supportsNestedChildren(block: NfmBlock): boolean {
  return nfmBlockAcceptsChildren(block);
}
