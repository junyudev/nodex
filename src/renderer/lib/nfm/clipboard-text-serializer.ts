import type { NfmBlock, NfmColor, NfmInlineContent } from "./types";
import { isChildlessNfmBlockType } from "./childless";

/**
 * Serialize NFM blocks into structure-preserving plain text for clipboard
 * `text/plain` payloads. This keeps block markers but emits literal inline text.
 */
export function serializeClipboardText(blocks: NfmBlock[]): string {
  return serializeBlocks(blocks, 0).join("\n");
}

function serializeBlocks(blocks: NfmBlock[], indent: number): string[] {
  const lines: string[] = [];
  const prefix = "\t".repeat(indent);

  for (const block of blocks) {
    switch (block.type) {
      case "paragraph": {
        const text = serializeInlinePlainText(block.content);
        if (text === "" && block.color === undefined) {
          lines.push(prefix);
          break;
        }

        pushPrefixedMultiline(lines, prefix, text + colorSuffix(block.color), prefix);
        break;
      }

      case "heading": {
        const togglePrefix = block.isToggleable ? (block.isOpen ? "▼" : "▶") : "";
        const hashes = "#".repeat(block.level);
        const text = serializeInlinePlainText(block.content);
        pushPrefixedMultiline(
          lines,
          prefix + togglePrefix + hashes + " ",
          text + colorSuffix(block.color),
          prefix,
        );
        break;
      }

      case "bulletListItem": {
        const text = serializeInlinePlainText(block.content);
        pushPrefixedMultiline(lines, prefix + "- ", text + colorSuffix(block.color), prefix);
        break;
      }

      case "numberedListItem": {
        const text = serializeInlinePlainText(block.content);
        pushPrefixedMultiline(lines, prefix + "1. ", text + colorSuffix(block.color), prefix);
        break;
      }

      case "checkListItem": {
        const check = block.checked ? "x" : " ";
        const text = serializeInlinePlainText(block.content);
        pushPrefixedMultiline(lines, prefix + `- [${check}] `, text + colorSuffix(block.color), prefix);
        break;
      }

      case "toggle": {
        const toggleMarker = block.isOpen ? "▼" : "▶";
        const text = serializeInlinePlainText(block.content);
        pushPrefixedMultiline(lines, prefix + toggleMarker + " ", text + colorSuffix(block.color), prefix);
        break;
      }

      case "blockquote": {
        const text = serializeInlinePlainText(block.content);
        pushPrefixedMultiline(lines, prefix + "> ", text + colorSuffix(block.color), prefix);
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

        pushPrefixedMultiline(
          lines,
          prefix + "\t",
          serializeInlinePlainText(block.content),
          prefix + "\t",
        );

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
        const caption = serializeInlinePlainText(block.caption);
        pushPrefixedMultiline(
          lines,
          prefix + `<image ${attrs.join(" ")}>`,
          `${caption}</image>`,
          prefix,
        );
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
        pushPrefixedMultiline(
          lines,
          prefix + "\t",
          serializeInlinePlainText(block.content),
          prefix + "\t",
        );
        lines.push(...serializeBlocks(block.children, indent + 1));
        lines.push(prefix + "</card-toggle>");
        break;
      }

      case "divider": {
        lines.push(prefix + "---");
        break;
      }

      case "emptyBlock": {
        lines.push(prefix);
        break;
      }
    }

    if (supportsNestedChildren(block) && block.children.length > 0) {
      lines.push(...serializeBlocks(block.children, indent + 1));
    }
  }

  return lines;
}

function serializeInlinePlainText(items: NfmInlineContent[]): string {
  return items
    .map((item) => {
      if (item.type === "linebreak") return "\n";
      if (item.type === "attachment") {
        const label = item.name.trim() || "Untitled attachment";
        return `[Attachment: ${label}]`;
      }
      if (item.type === "link") {
        const inner = applyStyleMarkers(item.text, item.styles);
        return `[${inner}](${item.href})`;
      }

      return applyStyleMarkers(item.text, item.styles);
    })
    .join("");
}

function applyStyleMarkers(
  text: string,
  styles: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    code?: boolean;
    color?: NfmColor;
  },
): string {
  if (styles.code) {
    return wrapCodeSpan(text);
  }

  let next = text;
  if (!next) return next;

  if (styles.color) {
    next = `<span color="${styles.color}">${next}</span>`;
  }
  if (styles.underline) {
    next = `<span underline="true">${next}</span>`;
  }
  if (styles.strikethrough) {
    next = `~~${next}~~`;
  }
  if (styles.italic) {
    next = `*${next}*`;
  }
  if (styles.bold) {
    next = `**${next}**`;
  }

  return next;
}

function wrapCodeSpan(text: string): string {
  if (text.includes("`")) {
    return `\`\` ${text} \`\``;
  }

  return `\`${text}\``;
}

function pushPrefixedMultiline(
  lines: string[],
  firstPrefix: string,
  value: string,
  continuationPrefix: string,
): void {
  if (value.length === 0) {
    lines.push(firstPrefix);
    return;
  }

  const parts = value.split("\n");
  lines.push(firstPrefix + parts[0]);
  for (let index = 1; index < parts.length; index += 1) {
    lines.push(continuationPrefix + parts[index]);
  }
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

function escapeXmlAttr(value: string): string {
  return value.replace(/"/g, "&quot;");
}

function supportsNestedChildren(block: NfmBlock): boolean {
  if (block.type === "callout") return false;
  if (block.type === "cardToggle") return false;
  if (isChildlessNfmBlockType(block.type)) return false;
  return true;
}
