import { fileSource } from "./file-resources";
import {
  readMarkdown,
  writeMarkdown,
  writePortableMarkdown,
  type MarkdownBlock,
} from "./nodex-markdown";

/** Composers edit Nodex Markdown source; stored bodies are its exact text. */
export const parseMessageText = (text: string): MarkdownBlock[] => readMarkdown(text);
export const serializeMessageText = (blocks: readonly MarkdownBlock[]): string =>
  writeMarkdown(blocks);

/** Copy uses the language writer's portable form. */
export function writtenMessageText(
  blocks: readonly MarkdownBlock[],
  pageTitle?: (pageId: string) => string | null,
): string {
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const item = value as Record<string, unknown>;
    if (item.type === "pageMention")
      ids.add(String((item.props as Record<string, unknown>)?.targetPageId ?? ""));
    Object.values(item).forEach(visit);
  };
  if (pageTitle) visit(blocks);
  const pageTitles = Object.fromEntries(
    [...ids].flatMap((id) => {
      const title = pageTitle?.(id);
      return title ? [[id, title]] : [];
    }),
  );
  return writePortableMarkdown(blocks, { pageTitles }).markdown;
}

/**
 * A message's plain images form one run, shown as a row of images where it sits: first, where
 * a Composer writes them, or last, where a message written before images came first keeps them.
 * Any other image belongs to the text, in place.
 */
export interface MessageContent {
  readonly text: readonly MarkdownBlock[];
  readonly attachments: readonly MarkdownBlock[];
  /** Whether the row comes before the text or after it. */
  readonly attachmentsAt: "start" | "end";
}
const isPlainImage = (block: MarkdownBlock | undefined): boolean =>
  block?.type === "image" && !block.children?.length;
export function splitMessageContent(blocks: readonly MarkdownBlock[]): MessageContent {
  let start = 0;
  while (start < blocks.length && isPlainImage(blocks[start])) start += 1;
  if (start > 0)
    return {
      attachments: blocks.slice(0, start),
      text: blocks.slice(start),
      attachmentsAt: "start",
    };
  let end = blocks.length;
  while (end > 0 && isPlainImage(blocks[end - 1])) end -= 1;
  return { text: blocks.slice(0, end), attachments: blocks.slice(end), attachmentsAt: "end" };
}
export const messageTextOf = (markdown: string): string =>
  writeMarkdown(splitMessageContent(readMarkdown(markdown)).text);
export const messageImageBlock = (fileId: string): MarkdownBlock => ({
  type: "image",
  props: { url: fileSource(fileId) },
});
export const isComposerImage = (image: MarkdownBlock): boolean =>
  writeMarkdown([image]) ===
  writeMarkdown([{ type: "image", props: { url: image.props?.url ?? "" } }]);

/** A Composer's message: its images first, as they show above the text, then the text. */
export function composeMessageText(text: string, images: readonly MarkdownBlock[]): string {
  const written = text.replace(/\r\n?/gu, "\n").trimEnd();
  return [images.length ? writeMarkdown(images) : "", written].filter(Boolean).join("\n\n");
}
