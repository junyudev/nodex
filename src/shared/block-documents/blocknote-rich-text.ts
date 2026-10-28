import type { MarkdownInline } from "../nodex-markdown";
import { normalizeDateMention } from "../rich-text/date-mention";
import type { RichTextColor } from "../rich-text/colors";
import {
  canonicalizePortableRichText,
  PortableRichTextError,
  type PortableRichText,
  type PortableRichTextItem,
  type PortableRichTextStyles,
} from "./portable-rich-text";

function portableStyles(styles: MarkdownInline["styles"]): PortableRichTextStyles {
  const text = styles?.textColor;
  const background = styles?.backgroundColor;
  if (text && text !== "default" && background && background !== "default") {
    throw new PortableRichTextError("Page titles cannot combine text and background color");
  }
  return {
    ...(styles?.bold ? { bold: true } : {}),
    ...(styles?.italic ? { italic: true } : {}),
    ...(styles?.underline ? { underline: true } : {}),
    ...(styles?.strike ? { strikethrough: true } : {}),
    ...(styles?.code ? { code: true } : {}),
    ...(typeof text === "string" && text !== "default" ? { color: text as RichTextColor } : {}),
    ...(typeof background === "string" && background !== "default"
      ? { color: `${background}_bg` as RichTextColor }
      : {}),
  };
}

/** The title-safe subset of BlockNote inline content, preserving each link's styled runs. */
export function blockNoteInlineToPortableRichText(content: unknown): PortableRichText {
  if (!Array.isArray(content)) return [];
  const items = (content as MarkdownInline[]).flatMap((item): PortableRichTextItem[] => {
    if (item.type === "text") {
      return (item.text ?? "")
        .split("\n")
        .flatMap((text, index) => [
          ...(index > 0 ? [{ type: "linebreak" } as const] : []),
          ...(text ? [{ type: "text", text, styles: portableStyles(item.styles) } as const] : []),
        ]);
    }
    if (item.type === "link") {
      const children = blockNoteInlineToPortableRichText(item.content);
      return children.map((child) => {
        if (child.type !== "text")
          throw new PortableRichTextError("Page title links must contain styled text");
        return { ...child, type: "link", href: item.href ?? "" };
      });
    }
    if (item.type === "pageMention")
      return [{ type: "pageMention", targetPageId: String(item.props?.targetPageId ?? "") }];
    if (item.type === "threadMention")
      return [{ type: "threadMention", uuid: String(item.props?.uuid ?? "") }];
    if (item.type === "dateMention") {
      const date = normalizeDateMention({ ...item.props, type: "dateMention" });
      if (date) return [date];
      throw new PortableRichTextError("Page title has an invalid date mention");
    }
    throw new PortableRichTextError(`Inline ${item.type} cannot participate in a Page title`);
  });
  return canonicalizePortableRichText(items);
}

export function portableRichTextToBlockNoteInline(value: PortableRichText): MarkdownInline[] {
  return canonicalizePortableRichText(value).map((item): MarkdownInline => {
    if (item.type === "linebreak") return { type: "text", text: "\n", styles: {} };
    if (item.type !== "text" && item.type !== "link") {
      const { type, ...props } = item;
      return { type, props };
    }
    const { color, strikethrough, ...marks } = item.styles;
    const styles = {
      ...marks,
      ...(strikethrough ? { strike: true } : {}),
      ...(color?.endsWith("_bg")
        ? { backgroundColor: color.slice(0, -3) }
        : color
          ? { textColor: color }
          : {}),
    };
    const text = { type: "text", text: item.text, styles };
    return item.type === "link" ? { type: "link", href: item.href, content: [text] } : text;
  });
}
