import type { NfmBlock, NfmColor } from "./types";
import { isChildlessNfmBlockType } from "./childless";
import { serializeInlineContent } from "./serializer-inline";
import { escapeXmlAttr } from "./xml-attributes";

/**
 * Serialize a block tree back to Notion-flavored Markdown string.
 */
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
        const text = serializeInlineContent(block.content);
        lines.push(prefix + "- " + text + colorSuffix(block.color));
        break;
      }

      case "numberedListItem": {
        const text = serializeInlineContent(block.content);
        lines.push(prefix + "1. " + text + colorSuffix(block.color));
        break;
      }

      case "checkListItem": {
        const check = block.checked ? "x" : " ";
        const text = serializeInlineContent(block.content);
        lines.push(
          prefix + `- [${check}] ` + text + colorSuffix(block.color),
        );
        break;
      }

      case "toggle": {
        const toggleMarker = block.isOpen ? "▼" : "▶";
        const text = serializeInlineContent(block.content);
        lines.push(prefix + toggleMarker + " " + text + colorSuffix(block.color));
        break;
      }

      case "blockquote": {
        const text = serializeInlineContent(block.content);
        lines.push(prefix + "> " + text + colorSuffix(block.color));
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

        // First line is inline content
        const text = serializeInlineContent(block.content);
        if (text) {
          lines.push(prefix + "\t" + text);
        }

        // Children
        lines.push(...serializeBlocks(block.children, indent + 1));

        lines.push(prefix + "</callout>");
        break;
      }

      case "image": {
        const attrs = [`source="${escapeXmlAttr(block.source)}"`];
        if (block.color) attrs.push(`color="${block.color}"`);
        if (block.previewWidth !== undefined) {
          attrs.push(`preview-width="${block.previewWidth}"`);
        }
        const caption = serializeInlineContent(block.caption);
        lines.push(prefix + `<image ${attrs.join(" ")}>${caption}</image>`);
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
        if (block.snapshot) {
          attrs.push(`snapshot="${escapeXmlAttr(block.snapshot)}"`);
        }
        if (block.sourceProjectId) {
          attrs.push(`project="${escapeXmlAttr(block.sourceProjectId)}"`);
        }
        if (block.sourceColumnId) {
          attrs.push(`column="${escapeXmlAttr(block.sourceColumnId)}"`);
        }
        if (block.sourceColumnName) {
          attrs.push(`column-name="${escapeXmlAttr(block.sourceColumnName)}"`);
        }

        lines.push(prefix + `<card-toggle ${attrs.join(" ")}>`);
        const title = serializeInlineContent(block.content);
        // Always emit an explicit title line (possibly empty) so parser can
        // preserve child blocks when title content is empty.
        lines.push(prefix + "\t" + title);
        lines.push(...serializeBlocks(block.children, indent + 1));
        lines.push(prefix + "</card-toggle>");
        break;
      }

      case "divider": {
        lines.push(prefix + "---");
        break;
      }

      case "emptyBlock": {
        lines.push(prefix + "<empty-block/>");
        break;
      }
    }

    // Serialize children (for non-callout blocks, which handle children internally)
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
      if (currentRun > longestRun) {
        longestRun = currentRun;
      }
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
