import type {
  PortableRichTextItem,
  PortableRichTextStyles,
} from "../../shared/block-documents/portable-rich-text";
import { formatDateMentionPlainText } from "../../shared/rich-text/date-mention";
import type { RichTextColor } from "../../shared/rich-text/colors";
import { cn } from "./utils";

const titleColorClass = (color: RichTextColor | undefined): string | undefined => {
  if (!color) return undefined;
  const classes: Record<RichTextColor, string> = {
    gray: "text-[var(--gray-text)]",
    brown: "text-[var(--brown-text,#64473a)]",
    orange: "text-[var(--orange-text,#d9730d)]",
    yellow: "text-[var(--yellow-text,#cb8a00)]",
    green: "text-[var(--green-text,#448361)]",
    blue: "text-[var(--blue-text)]",
    purple: "text-[var(--purple-text,#9065b0)]",
    pink: "text-[var(--pink-text,#ad1a72)]",
    red: "text-[var(--red-text,#e03e3e)]",
    gray_bg: "bg-[var(--gray-bg)] text-[var(--gray-text)]",
    brown_bg: "bg-[var(--brown-bg,#e9e5e3)] text-[var(--brown-text,#64473a)]",
    orange_bg: "bg-[var(--orange-bg,#faebdd)] text-[var(--orange-text,#d9730d)]",
    yellow_bg: "bg-[var(--yellow-bg,#fbf3db)] text-[var(--yellow-text,#cb8a00)]",
    green_bg: "bg-[var(--green-bg,#ddedea)] text-[var(--green-text,#448361)]",
    blue_bg: "bg-[var(--blue-bg)] text-[var(--blue-text)]",
    purple_bg: "bg-[var(--purple-bg,#e8deee)] text-[var(--purple-text,#9065b0)]",
    pink_bg: "bg-[var(--pink-bg,#f4dfeb)] text-[var(--pink-text,#ad1a72)]",
    red_bg: "bg-[var(--red-bg,#fbe4e4)] text-[var(--red-text,#e03e3e)]",
  };
  return classes[color];
};

export const portableRichTitleStyleClass = (styles: PortableRichTextStyles): string =>
  cn(
    styles.bold && "font-bold",
    styles.italic && "italic",
    styles.underline && "underline",
    styles.strikethrough && "line-through",
    styles.code && "rounded-sm bg-token-foreground/5 px-0.5 font-mono text-[0.9em]",
    titleColorClass(styles.color),
  );

export const portableRichTitleAtomLabel = (item: PortableRichTextItem): string => {
  if (item.type === "threadMention") return `@${item.uuid.slice(0, 8)}`;
  if (item.type === "pageMention") return `@${item.targetPageId.slice(0, 8)}`;
  if (item.type === "dateMention") return formatDateMentionPlainText(item);
  return "";
};
