import { readMarkdown, readInlineMarkdown, writeInlineMarkdown } from "./index";
import {
  blockNoteInlineToPortableRichText,
  portableRichTextToBlockNoteInline,
} from "../block-documents/blocknote-rich-text";
import {
  canonicalizePortableRichText,
  MAX_PORTABLE_RICH_TEXT_BYTES,
  type PortableRichText,
} from "../block-documents/portable-rich-text";

export class InlineMarkdownTitleError extends TypeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InlineMarkdownTitleError";
  }
}

export function parseInlineMarkdownTitle(markdown: string): PortableRichText {
  try {
    if (/[\n\r\t]/u.test(markdown))
      throw new InlineMarkdownTitleError("Page title Markdown must be one line without tabs");
    if (new TextEncoder().encode(markdown).byteLength > MAX_PORTABLE_RICH_TEXT_BYTES) {
      throw new InlineMarkdownTitleError(
        `Page title Markdown must be at most ${MAX_PORTABLE_RICH_TEXT_BYTES} UTF-8 bytes`,
      );
    }
    if (markdown.trim()) {
      const blocks = readMarkdown(markdown, "exact");
      const block = blocks[0];
      if (
        blocks.length !== 1 ||
        block?.type !== "paragraph" ||
        block.children?.length ||
        Object.keys(block.props ?? {}).length
      ) {
        throw new InlineMarkdownTitleError(
          "Page title Markdown accepts inline content, not Block syntax",
        );
      }
    }
    const title = blockNoteInlineToPortableRichText(readInlineMarkdown(markdown, "exact"));
    if (title.some((item) => item.type === "linebreak"))
      throw new InlineMarkdownTitleError("Page title Markdown cannot contain line breaks");
    return title;
  } catch (error) {
    if (error instanceof InlineMarkdownTitleError) throw error;
    throw new InlineMarkdownTitleError(
      error instanceof Error ? error.message : "Invalid Page title Markdown",
      { cause: error },
    );
  }
}

export function serializeInlineMarkdownTitle(value: PortableRichText): string {
  const canonical = canonicalizePortableRichText(value);
  const markdown = writeInlineMarkdown(portableRichTextToBlockNoteInline(canonical));
  if (JSON.stringify(parseInlineMarkdownTitle(markdown)) !== JSON.stringify(canonical)) {
    throw new InlineMarkdownTitleError(
      "Page title cannot be represented losslessly as inline Markdown",
    );
  }
  return markdown;
}
