import type { NfmBlock, NfmColor, NfmInlineContent } from "./types";
import { nfmBlockAcceptsChildren } from "../../../shared/nfm/block-children";
import { resolveOrderedListStarts } from "../../../shared/nfm/ordered-list";
import { serializeNfmTablePlainText } from "../../../shared/nfm/table";
import { formatDateMentionPlainText } from "../../../shared/nfm/date-mention";
import { serializeNfm } from "../../../shared/nfm/serializer";
import { serializeInlineContent } from "../../../shared/nfm/serializer-inline";

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
  const orderedListStarts = resolveOrderedListStarts(blocks);

  for (const [index, block] of blocks.entries()) {
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
        const start = orderedListStarts[index] ?? 1;
        pushPrefixedMultiline(
          lines,
          prefix + `${start}. `,
          text + colorSuffix(block.color),
          prefix,
        );
        break;
      }

      case "checkListItem": {
        const check = block.checked ? "x" : " ";
        const text = serializeInlinePlainText(block.content);
        pushPrefixedMultiline(
          lines,
          prefix + `- [${check}] `,
          text + colorSuffix(block.color),
          prefix,
        );
        break;
      }

      case "toggle": {
        const toggleMarker = block.isOpen ? "▼" : "▶";
        const text = serializeInlinePlainText(block.content);
        pushPrefixedMultiline(
          lines,
          prefix + toggleMarker + " ",
          text + colorSuffix(block.color),
          prefix,
        );
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

      case "mathBlock": {
        for (const sourceLine of serializeNfm([block]).split("\n")) {
          lines.push(prefix + sourceLine);
        }
        break;
      }

      case "table": {
        lines.push(...serializeNfmTablePlainText(block, indent));
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
        if (block.sourceWidth !== undefined && block.sourceHeight !== undefined) {
          attrs.push(`source-width="${block.sourceWidth}"`);
          attrs.push(`source-height="${block.sourceHeight}"`);
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
        lines.push(prefix + serializeNfm([block]));
        break;
      }

      case "page": {
        lines.push(prefix + serializeNfm([block]));
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

    if (block.type !== "callout" && supportsNestedChildren(block) && block.children.length > 0) {
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
      if (item.type === "agentConfig") {
        const attrs: string[] = [];
        if (item.mode) attrs.push(`mode="${item.mode}"`);
        if (item.provider) attrs.push(`provider="${item.provider}"`);
        if (item.model) attrs.push(`model="${item.model}"`);
        if (item.reasoning) attrs.push(`reasoning="${item.reasoning}"`);
        if (item.speed) attrs.push(`speed="${item.speed}"`);
        if (item.permission) attrs.push(`permission="${item.permission}"`);
        return attrs.length > 0 ? `<agent-config ${attrs.join(" ")} />` : "<agent-config />";
      }
      if (item.type === "threadMention") {
        return `[Thread: ${item.uuid}]`;
      }
      if (item.type === "pageMention") {
        return `[Page: ${item.targetPageId}]`;
      }
      if (item.type === "dateMention") {
        return formatDateMentionPlainText(item);
      }
      if (item.type === "math") return serializeInlineContent([item]);
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
  return nfmBlockAcceptsChildren(block);
}
