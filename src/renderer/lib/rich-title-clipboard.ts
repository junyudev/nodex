import type {
  PortableRichText,
  PortableRichTextItem,
  PortableRichTextStyles,
} from "../../shared/block-documents/portable-rich-text";
import type { RichTextColor } from "../../shared/rich-text/colors";
import { portableRichTitleAtomLabel } from "./portable-rich-title-presentation";

export interface RichTitleClipboardPayload {
  readonly html: string;
  readonly plainText: string;
}

interface RichTitleClipboardSelection {
  readonly start: number;
  readonly end: number;
}

interface ClipboardDataWriter {
  setData(format: string, data: string): void;
}

interface RichTitleClipboardStyle {
  readonly property: "background-color" | "color";
  readonly value: string;
}

export type RichTitleClipboardColorResolver = (
  color: RichTextColor,
) => readonly RichTitleClipboardStyle[];

const COLOR_FALLBACKS: Partial<Record<RichTextColor, string>> = {
  brown: "#64473a",
  brown_bg: "#e9e5e3",
  pink: "#ad1a72",
  pink_bg: "#f4dfeb",
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const richTitleItemLength = (item: PortableRichTextItem): number =>
  item.type === "text" || item.type === "link" ? item.text.length : 1;

const wrapRichTitleStyles = (
  value: string,
  styles: PortableRichTextStyles,
  resolveColor: RichTitleClipboardColorResolver | undefined,
): string => {
  let html = escapeHtml(value).replaceAll("\n", "<br>");
  if (styles.code) html = `<code>${html}</code>`;
  if (styles.strikethrough) html = `<s>${html}</s>`;
  if (styles.underline) html = `<u>${html}</u>`;
  if (styles.italic) html = `<em>${html}</em>`;
  if (styles.bold) html = `<strong>${html}</strong>`;
  if (!styles.color || !resolveColor) return html;

  const declarations = resolveColor(styles.color)
    .filter(({ value: styleValue }) => styleValue.length > 0)
    .map(({ property, value: styleValue }) => `${property}: ${styleValue};`)
    .join(" ");
  return declarations.length > 0
    ? `<span style="${escapeHtml(declarations)}">${html}</span>`
    : html;
};

const itemSelectionText = (
  item: PortableRichTextItem,
  itemStart: number,
  selectionStart: number,
  selectionEnd: number,
): string | null => {
  const itemEnd = itemStart + richTitleItemLength(item);
  const overlapStart = Math.max(itemStart, selectionStart);
  const overlapEnd = Math.min(itemEnd, selectionEnd);
  if (overlapEnd <= overlapStart) return null;
  if (item.type === "text" || item.type === "link") {
    return item.text.slice(overlapStart - itemStart, overlapEnd - itemStart);
  }
  if (item.type === "linebreak") return "\n";
  return portableRichTitleAtomLabel(item);
};

export function createRichTitleClipboardPayload(
  value: PortableRichText,
  selection: RichTitleClipboardSelection,
  resolveColor?: RichTitleClipboardColorResolver,
): RichTitleClipboardPayload {
  const selectionStart = Math.max(0, Math.min(selection.start, selection.end));
  const selectionEnd = Math.max(selectionStart, selection.start, selection.end);
  const plainText: string[] = [];
  const html: string[] = [];
  let offset = 0;

  for (const item of value) {
    const itemStart = offset;
    offset += richTitleItemLength(item);
    const selectedText = itemSelectionText(item, itemStart, selectionStart, selectionEnd);
    if (selectedText === null) continue;

    plainText.push(selectedText);
    if (item.type === "linebreak") {
      html.push("<br>");
      continue;
    }
    if (item.type === "text") {
      html.push(wrapRichTitleStyles(selectedText, item.styles, resolveColor));
      continue;
    }
    if (item.type === "link") {
      const content = wrapRichTitleStyles(selectedText, item.styles, resolveColor);
      html.push(`<a href="${escapeHtml(item.href)}">${content}</a>`);
      continue;
    }
    html.push(escapeHtml(selectedText));
  }

  return {
    html: html.join(""),
    plainText: plainText.join(""),
  };
}

export function writeRichTitleClipboardPayload(
  clipboardData: ClipboardDataWriter | null | undefined,
  payload: RichTitleClipboardPayload,
): boolean {
  if (!clipboardData) return false;
  let wroteClipboardData = false;
  try {
    clipboardData.setData("text/html", payload.html);
    wroteClipboardData = true;
  } catch {
    // Continue so plain-text copy can still succeed.
  }
  try {
    clipboardData.setData("text/plain", payload.plainText);
    wroteClipboardData = true;
  } catch {
    // The caller leaves native copy/cut behavior untouched when both writes fail.
  }
  return wroteClipboardData;
}

export function resolveRichTitleClipboardColor(
  color: RichTextColor,
  getPropertyValue: (property: string) => string,
): readonly RichTitleClipboardStyle[] {
  const background = color.endsWith("_bg");
  const baseColor = background ? color.slice(0, -3) : color;
  const textValue = getPropertyValue(`--${baseColor}-text`).trim();
  if (!background) {
    const value = textValue || COLOR_FALLBACKS[color] || "";
    return value.length > 0 ? [{ property: "color", value }] : [];
  }

  const backgroundValue =
    getPropertyValue(`--${baseColor}-bg`).trim() || COLOR_FALLBACKS[color] || "";
  return [
    ...(backgroundValue.length > 0
      ? [{ property: "background-color" as const, value: backgroundValue }]
      : []),
    ...(textValue.length > 0 ? [{ property: "color" as const, value: textValue }] : []),
  ];
}
