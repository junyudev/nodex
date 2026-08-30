import type { NfmBlock, NfmColor } from "./types";
import { nfmBlockAcceptsChildren } from "./block-children";
import { resolveOrderedListStarts } from "./ordered-list";
import { serializeInlineContent } from "./serializer-inline";
import { serializeNfmTable } from "./table";
import { escapeXmlAttr } from "./xml-attributes";
import { buildPageDeepLink, parsePageDeepLink } from "../nodex-deeplink";

export function serializeNfm(blocks: NfmBlock[]): string {
  return serializeBlocks(blocks, 0)
    .filter((line) => line !== null)
    .join("\n");
}

function serializeBlocks(blocks: NfmBlock[], indent: number): string[] {
  const lines: string[] = [];
  const prefix = "\t".repeat(indent);
  const orderedListStarts = resolveOrderedListStarts(blocks);

  for (const [index, block] of blocks.entries()) {
    switch (block.type) {
      case "paragraph": {
        const text = serializeInlineContent(block.content);
        if (text === "" && block.color === undefined) {
          lines.push(prefix + "<empty-block/>");
          break;
        }
        lines.push(prefix + text + colorSuffix(block.color));
        break;
      }
      case "heading": {
        const togglePrefix = block.isToggleable ? (block.isOpen ? "▼" : "▶") : "";
        const hashes = "#".repeat(block.level);
        const text = serializeInlineContent(block.content);
        lines.push(prefix + togglePrefix + hashes + " " + text + colorSuffix(block.color));
        break;
      }
      case "bulletListItem": {
        lines.push(
          prefix + "- " + serializeInlineContent(block.content) + colorSuffix(block.color),
        );
        break;
      }
      case "numberedListItem": {
        const start = orderedListStarts[index] ?? 1;
        lines.push(
          prefix + `${start}. ` + serializeInlineContent(block.content) + colorSuffix(block.color),
        );
        break;
      }
      case "checkListItem": {
        const check = block.checked ? "x" : " ";
        lines.push(
          prefix +
            `- [${check}] ` +
            serializeInlineContent(block.content) +
            colorSuffix(block.color),
        );
        break;
      }
      case "toggle": {
        const toggleMarker = block.isOpen ? "▼" : "▶";
        lines.push(
          prefix +
            toggleMarker +
            " " +
            serializeInlineContent(block.content) +
            colorSuffix(block.color),
        );
        break;
      }
      case "blockquote": {
        lines.push(
          prefix + "> " + serializeInlineContent(block.content) + colorSuffix(block.color),
        );
        break;
      }
      case "codeBlock": {
        const fence = selectCodeFence(block.code);
        lines.push(prefix + fence + block.language);
        for (const codeLine of block.code.split("\n")) {
          lines.push(prefix + codeLine);
        }
        lines.push(prefix + fence);
        break;
      }
      case "mathBlock": {
        const fence = selectMathFence(block.source);
        lines.push(prefix + fence);
        for (const sourceLine of block.source.split("\n")) {
          lines.push(prefix + sourceLine);
        }
        lines.push(prefix + fence);
        break;
      }
      case "table": {
        lines.push(...serializeNfmTable(block, indent));
        break;
      }
      case "callout": {
        const attrs: string[] = [];
        if (block.icon) attrs.push(`icon="${block.icon}"`);
        if (block.color) attrs.push(`color="${block.color}"`);
        const attrStr = attrs.length ? " " + attrs.join(" ") : "";
        lines.push(prefix + `<callout${attrStr}>`);
        const text = serializeInlineContent(block.content);
        if (text) lines.push(prefix + "\t" + text);
        lines.push(...serializeBlocks(block.children, indent + 1));
        lines.push(prefix + "</callout>");
        break;
      }
      case "image": {
        const attrs = [`source="${escapeXmlAttr(block.source)}"`];
        if (block.color) attrs.push(`color="${block.color}"`);
        if (block.previewWidth !== undefined) attrs.push(`preview-width="${block.previewWidth}"`);
        if (block.sourceWidth !== undefined && block.sourceHeight !== undefined) {
          attrs.push(`source-width="${block.sourceWidth}"`);
          attrs.push(`source-height="${block.sourceHeight}"`);
        }
        lines.push(
          prefix + `<image ${attrs.join(" ")}>${serializeInlineContent(block.caption)}</image>`,
        );
        break;
      }
      case "databaseViewRef": {
        const attrs = [`database-view="${escapeXmlAttr(block.databaseViewId)}"`];
        if (block.displayHint !== undefined) {
          attrs.push(`display-hint="${escapeXmlAttr(block.displayHint)}"`);
        }
        lines.push(prefix + `<database-view-ref ${attrs.join(" ")} />`);
        break;
      }
      case "database": {
        if (!block.uuid || block.uuid !== block.uuid.trim()) {
          throw new TypeError("Canonical Database NFM requires an exact non-empty uuid");
        }
        lines.push(prefix + `<database uuid="${escapeXmlAttr(block.uuid)}" />`);
        break;
      }
      case "canvas": {
        if (!block.uuid || block.uuid !== block.uuid.trim()) {
          throw new TypeError("Canonical Canvas NFM requires an exact non-empty uuid");
        }
        lines.push(prefix + `<canvas uuid="${escapeXmlAttr(block.uuid)}" />`);
        break;
      }
      case "syncedBlockRef": {
        lines.push(
          prefix + `<synced-block-ref source-block="${escapeXmlAttr(block.sourceBlockId)}" />`,
        );
        break;
      }
      case "templateRef": {
        const attrs = [`source-block="${escapeXmlAttr(block.sourceBlockId)}"`];
        if (block.displayHint !== undefined) {
          attrs.push(`display-hint="${escapeXmlAttr(block.displayHint)}"`);
        }
        lines.push(prefix + `<template-ref ${attrs.join(" ")} />`);
        break;
      }
      case "page": {
        if (!block.uuid || block.uuid !== block.uuid.trim()) {
          throw new TypeError("Canonical Page NFM requires an exact non-empty uuid");
        }
        lines.push(prefix + `<page uuid="${escapeXmlAttr(block.uuid)}" />`);
        break;
      }
      case "threadSection": {
        const attrs: string[] = [];
        if (block.label && block.label.length > 0) {
          attrs.push(`label="${escapeXmlAttr(block.label)}"`);
        }
        if (block.threadId && block.threadId.length > 0) {
          attrs.push(`thread="${escapeXmlAttr(block.threadId)}"`);
        }
        const attrSuffix = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
        lines.push(prefix + `<thread-section${attrSuffix} />`);
        break;
      }
      case "pageRef": {
        const url = buildPageDeepLink({ pageId: block.targetBlockId });
        const target = parsePageDeepLink(url);
        if (!target || target.pageId !== block.targetBlockId) {
          throw new TypeError("Page reference URL must identify a Nodex Page");
        }
        lines.push(prefix + `<page-ref url="${escapeXmlAttr(url)}" />`);
        break;
      }
      case "divider":
        lines.push(prefix + "---");
        break;
      case "emptyBlock":
        lines.push(prefix + "<empty-block/>");
        break;
    }

    if (block.type !== "callout" && supportsNestedChildren(block) && block.children.length > 0) {
      lines.push(...serializeBlocks(block.children, indent + 1));
    }
  }

  return lines;
}

function selectCodeFence(code: string): string {
  const longestBacktickRun = findLongestRepeatedRun(code, "`");
  return "`".repeat(Math.max(3, longestBacktickRun + 1));
}

function selectMathFence(source: string): string {
  const standaloneDollarRuns = source
    .split("\n")
    .filter((line) => /^\$+$/u.test(line))
    .map((line) => line.length);
  const longestRun = Math.max(0, ...standaloneDollarRuns);
  return "$".repeat(Math.max(2, longestRun + 1));
}

function findLongestRepeatedRun(text: string, char: string): number {
  let longestRun = 0;
  let currentRun = 0;

  for (const nextChar of text) {
    if (nextChar === char) {
      currentRun += 1;
      if (currentRun > longestRun) longestRun = currentRun;
      continue;
    }
    currentRun = 0;
  }

  return longestRun;
}

function colorSuffix(color?: NfmColor): string {
  return color ? ` {color="${color}"}` : "";
}

function supportsNestedChildren(block: NfmBlock): boolean {
  return nfmBlockAcceptsChildren(block);
}
