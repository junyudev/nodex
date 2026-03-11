import type {
  NfmBlock,
  NfmCardToggle,
  NfmCardRef,
  NfmColor,
  NfmInlineContent,
  NfmCallout,
  NfmImage,
  NfmToggleListInlineView,
} from "./types";
import { NFM_COLORS } from "./types";
import { isChildlessNfmBlockType } from "./childless";
import { parseInlineContent } from "./parser-inline";
import { getXmlAttr } from "./xml-attributes";

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

    // Image: <image source="...">Caption</image>
    if (content.trimStart().startsWith("<image")) {
      const image = parseImage(content.trim());
      if (image) {
        addBlock(image, indent);
        i++;
        continue;
      }
    }

    if (content.trimStart().startsWith("<toggle-list-inline-view")) {
      const inlineView = parseToggleListInlineView(content.trim());
      if (inlineView) {
        addBlock(inlineView, indent);
        i++;
        continue;
      }
    }

    // Card reference: <card-ref project="..." card="..." />
    if (content.trimStart().startsWith("<card-ref")) {
      const cardRef = parseCardRef(content.trim());
      if (cardRef) {
        addBlock(cardRef, indent);
        i++;
        continue;
      }
    }

    // Card toggle: <card-toggle ...> ... </card-toggle>
    if (content.trimStart().startsWith("<card-toggle")) {
      const cardToggle = parseCardToggle(lines, i, indent);
      if (cardToggle) {
        addBlock(cardToggle.block, indent);
        i = cardToggle.nextLine;
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
    const numMatch = stripped.match(/^\d+\.\s+(.*)$/);
    if (numMatch) {
      addBlock(
        {
          type: "numberedListItem",
          content: parseInlineContent(numMatch[1]),
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
  const openMatch = openLine.match(
    /^<callout(?:\s+icon="([^"]*)")?(?:\s+color="([^"]*)")?\s*>/,
  );
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
    const innerContent = lineContent.startsWith("\t")
      ? lineContent.slice(1)
      : lineContent;
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
  if (!source) return null;

  const colorValue = getXmlAttr(attrString, "color");
  const color = colorValue && NFM_COLORS.includes(colorValue as NfmColor)
    ? (colorValue as NfmColor)
    : undefined;

  const previewWidthRaw = getXmlAttr(attrString, "preview-width")
    ?? getXmlAttr(attrString, "previewWidth");
  const previewWidth = previewWidthRaw ? Number.parseInt(previewWidthRaw, 10) : undefined;

  return {
    type: "image",
    source,
    caption: parseInlineContent(caption),
    ...(previewWidth !== undefined && Number.isFinite(previewWidth) && previewWidth > 0
      ? { previewWidth }
      : {}),
    color,
    children: [],
  };
}

function parseToggleListInlineView(line: string): NfmToggleListInlineView | null {
  const match = line.match(/^<toggle-list-inline-view(?:\s+([^>]*))?\s*\/>$/);
  if (!match) return null;

  const attrString = match[1] ?? "";
  const sourceProjectId = getXmlAttr(attrString, "project") ?? "default";
  const rulesV2B64 = getXmlAttr(attrString, "rules-v2");
  const propertyOrder = parseCsvAttr(getXmlAttr(attrString, "property-order"))
    .filter(isToggleListPropertyKey);
  const hiddenProperties = parseCsvAttr(getXmlAttr(attrString, "hidden-properties"))
    .filter(isToggleListPropertyKey);
  const showEmptyEstimate = getXmlAttr(attrString, "show-empty-estimate");

  return {
    type: "toggleListInlineView",
    sourceProjectId,
    ...(typeof rulesV2B64 === "string" && rulesV2B64.length > 0 ? { rulesV2B64 } : {}),
    ...(propertyOrder.length > 0 ? { propertyOrder } : {}),
    ...(hiddenProperties.length > 0 ? { hiddenProperties } : {}),
    ...(showEmptyEstimate === "true" || showEmptyEstimate === "false"
      ? { showEmptyEstimate: showEmptyEstimate === "true" }
      : {}),
    children: [],
  };
}

function parseCsvAttr(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isToggleListPropertyKey(
  value: string,
): value is NonNullable<NfmToggleListInlineView["propertyOrder"]>[number] {
  return value === "priority" || value === "estimate" || value === "status" || value === "tags";
}

function parseCardRef(line: string): NfmCardRef | null {
  const match = line.match(/^<card-ref(?:\s+([^>]*))?\s*\/>$/);
  if (!match) return null;

  const attrString = match[1] ?? "";
  const sourceProjectId = getXmlAttr(attrString, "project") ?? "default";
  const cardId = getXmlAttr(attrString, "card") ?? "";

  return {
    type: "cardRef",
    sourceProjectId,
    cardId,
    children: [],
  };
}

function parseCardToggle(
  lines: string[],
  startLine: number,
  baseIndent: number,
): { block: NfmCardToggle; nextLine: number } | null {
  const openLine = lines[startLine].slice(baseIndent);
  const openMatch = openLine.match(/^<card-toggle(?:\s+([^>]*))?\s*>$/);
  if (!openMatch) return null;

  const attrString = openMatch[1] ?? "";
  const cardId = getXmlAttr(attrString, "card") ?? "";
  const meta = getXmlAttr(attrString, "meta") ?? "";
  const snapshot = getXmlAttr(attrString, "snapshot");
  const sourceProjectId = getXmlAttr(attrString, "project");
  const sourceStatus = getXmlAttr(attrString, "status");
  const sourceStatusName = getXmlAttr(attrString, "status-name");

  const titleLines: string[] = [];
  const childrenLines: string[] = [];
  let foundTitle = false;
  let i = startLine + 1;
  while (i < lines.length) {
    const currentLine = lines[i];
    const currentContent = currentLine.slice(baseIndent);
    if (currentContent.trimEnd() === "</card-toggle>") {
      i++;
      break;
    }

    if (!foundTitle) {
      titleLines.push(currentContent.startsWith("\t") ? currentContent.slice(1) : currentContent);
      foundTitle = true;
    } else {
      childrenLines.push(currentContent.startsWith("\t") ? currentContent.slice(1) : currentContent);
    }
    i++;
  }

  const titleSource = titleLines.join("\n");
  const parsedTitleBlocks = parseNfm(titleSource);
  const firstTitleBlock = parsedTitleBlocks[0];
  const hasInlineParagraphTitle = parsedTitleBlocks.length === 1 && firstTitleBlock?.type === "paragraph";
  const titleContent = hasInlineParagraphTitle
    ? firstTitleBlock.content
    : [];
  const childSource = hasInlineParagraphTitle
    ? childrenLines.join("\n")
    : [titleSource, ...childrenLines].join("\n");

  return {
    block: {
      type: "cardToggle",
      cardId,
      meta,
      ...(snapshot ? { snapshot } : {}),
      ...(sourceProjectId ? { sourceProjectId } : {}),
      ...(sourceStatus ? { sourceStatus } : {}),
      ...(sourceStatusName ? { sourceStatusName } : {}),
      content: titleContent,
      children: parseNfm(childSource),
    },
    nextLine: i,
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
  if (isChildlessNfmBlockType(block.type)) return false;
  return true;
}
