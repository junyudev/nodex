import type { NfmBlock, NfmColor } from "./types";
import { isChildlessNfmBlockType } from "./childless";
import { serializeInlineContent } from "./serializer-inline";
import { escapeXmlAttr } from "./xml-attributes";

export function serializeNfm(blocks: NfmBlock[]): string {
  return serializeBlocks(blocks, 0)
    .filter((line) => line !== null)
    .join("\n");
}

function serializeBlocks(blocks: NfmBlock[], indent: number): string[] {
  const lines: string[] = [];
  const prefix = "\t".repeat(indent);

  for (const block of blocks) {
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
        lines.push(prefix + "- " + serializeInlineContent(block.content) + colorSuffix(block.color));
        break;
      }
      case "numberedListItem": {
        lines.push(prefix + "1. " + serializeInlineContent(block.content) + colorSuffix(block.color));
        break;
      }
      case "checkListItem": {
        const check = block.checked ? "x" : " ";
        lines.push(prefix + `- [${check}] ` + serializeInlineContent(block.content) + colorSuffix(block.color));
        break;
      }
      case "toggle": {
        const toggleMarker = block.isOpen ? "▼" : "▶";
        lines.push(prefix + toggleMarker + " " + serializeInlineContent(block.content) + colorSuffix(block.color));
        break;
      }
      case "blockquote": {
        lines.push(prefix + "> " + serializeInlineContent(block.content) + colorSuffix(block.color));
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
        lines.push(prefix + `<image ${attrs.join(" ")}>${serializeInlineContent(block.caption)}</image>`);
        break;
      }
      case "toggleListInlineView": {
        const attrs = [`project="${escapeXmlAttr(block.sourceProjectId)}"`];
        if (block.rulesV2B64 && block.rulesV2B64.length > 0) {
          attrs.push(`rules-v2="${escapeXmlAttr(block.rulesV2B64)}"`);
        }
        if (block.propertyOrder && block.propertyOrder.length > 0) {
          attrs.push(`property-order="${escapeXmlAttr(block.propertyOrder.join(","))}"`);
        }
        if (block.hiddenProperties && block.hiddenProperties.length > 0) {
          attrs.push(`hidden-properties="${escapeXmlAttr(block.hiddenProperties.join(","))}"`);
        }
        if (block.showEmptyEstimate !== undefined) {
          attrs.push(`show-empty-estimate="${block.showEmptyEstimate ? "true" : "false"}"`);
        }
        lines.push(prefix + `<toggle-list-inline-view ${attrs.join(" ")} />`);
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
      case "cardRef": {
        const attrs = [
          `project="${escapeXmlAttr(block.sourceProjectId)}"`,
          `card="${escapeXmlAttr(block.cardId)}"`,
        ];
        lines.push(prefix + `<card-ref ${attrs.join(" ")} />`);
        break;
      }
      case "cardToggle": {
        const attrs = [
          `card="${escapeXmlAttr(block.cardId)}"`,
          `meta="${escapeXmlAttr(block.meta)}"`,
        ];
        if (block.snapshot) attrs.push(`snapshot="${escapeXmlAttr(block.snapshot)}"`);
        if (block.sourceProjectId) attrs.push(`project="${escapeXmlAttr(block.sourceProjectId)}"`);
        if (block.sourceStatus) attrs.push(`status="${escapeXmlAttr(block.sourceStatus)}"`);
        if (block.sourceStatusName) attrs.push(`status-name="${escapeXmlAttr(block.sourceStatusName)}"`);
        lines.push(prefix + `<card-toggle ${attrs.join(" ")}>`);
        lines.push(prefix + "\t" + serializeInlineContent(block.content));
        lines.push(...serializeBlocks(block.children, indent + 1));
        lines.push(prefix + "</card-toggle>");
        break;
      }
      case "divider":
        lines.push(prefix + "---");
        break;
      case "emptyBlock":
        lines.push(prefix + "<empty-block/>");
        break;
    }

    if (supportsNestedChildren(block) && block.children.length > 0) {
      lines.push(...serializeBlocks(block.children, indent + 1));
    }
  }

  return lines;
}

function selectCodeFence(code: string): string {
  const longestBacktickRun = findLongestRepeatedRun(code, "`");
  return "`".repeat(Math.max(3, longestBacktickRun + 1));
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
  if (block.type === "callout") return false;
  if (block.type === "cardToggle") return false;
  if (isChildlessNfmBlockType(block.type)) return false;
  return true;
}
