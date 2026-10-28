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

export interface MessageContent {
  readonly text: readonly MarkdownBlock[];
  readonly attachments: readonly MarkdownBlock[];
}
export function splitMessageContent(blocks: readonly MarkdownBlock[]): MessageContent {
  let start = blocks.length;
  while (start > 0 && blocks[start - 1]?.type === "image" && !blocks[start - 1]?.children?.length)
    start -= 1;
  return { text: blocks.slice(0, start), attachments: blocks.slice(start) };
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

export function composeMessageText(text: string, images: readonly MarkdownBlock[]): string {
  const written = text.replace(/\r\n?/gu, "\n").trimEnd();
  return [written, images.length ? writeMarkdown(images) : ""].filter(Boolean).join("\n\n");
}
