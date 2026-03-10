import type { NfmInlineContent, NfmStyleSet } from "./types";
import { escapeXmlAttr } from "./xml-attributes";

const ESCAPABLE = /[\\*~`$\[\]<>{}|^]/g;

/** Escape NFM special characters in plain text */
function escapeNfm(text: string): string {
  return text.replace(ESCAPABLE, "\\$&");
}

/**
 * Serialize NfmInlineContent[] back to NFM inline string.
 */
export function serializeInlineContent(items: NfmInlineContent[]): string {
  return items.map(serializeItem).join("");
}

function serializeItem(item: NfmInlineContent): string {
  if (item.type === "linebreak") return "<br>";

  if (item.type === "attachment") {
    const attrs = [
      `kind="${escapeXmlAttr(item.kind)}"`,
      `mode="${escapeXmlAttr(item.mode)}"`,
      `source="${escapeXmlAttr(item.source)}"`,
      `name="${escapeXmlAttr(item.name)}"`,
    ];
    if (item.mimeType) attrs.push(`mime="${escapeXmlAttr(item.mimeType)}"`);
    if (item.kind !== "folder" && typeof item.bytes === "number" && Number.isFinite(item.bytes)) {
      attrs.push(`bytes="${Math.max(0, Math.floor(item.bytes))}"`);
    }
    if (item.origin) attrs.push(`origin="${escapeXmlAttr(item.origin)}"`);
    return `<attachment ${attrs.join(" ")} />`;
  }

  if (item.type === "link") {
    const inner = applyStyles(escapeNfm(item.text), item.styles);
    return `[${inner}](${item.href})`;
  }

  // text span
  if (item.styles.code) {
    // Code spans don't get other styling or escaping.
    // If text contains backtick, use double-backtick delimiter.
    if (item.text.includes("`")) {
      return "`` " + item.text + " ``";
    }
    return `\`${item.text}\``;
  }

  let text = escapeNfm(item.text);
  text = applyStyles(text, item.styles);
  return text;
}

/** Wrap text with style delimiters, innermost first */
function applyStyles(text: string, styles: NfmStyleSet): string {
  if (!text) return text;

  // Apply color first (innermost in the output)
  if (styles.color) {
    text = `<span color="${styles.color}">${text}</span>`;
  }

  // Apply underline
  if (styles.underline) {
    text = `<span underline="true">${text}</span>`;
  }

  // Apply strikethrough
  if (styles.strikethrough) {
    text = `~~${text}~~`;
  }

  // Apply italic
  if (styles.italic) {
    text = `*${text}*`;
  }

  // Apply bold (outermost)
  if (styles.bold) {
    text = `**${text}**`;
  }

  return text;
}
