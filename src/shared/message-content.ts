import { fileSource } from "./file-resources";
import { parseNfm } from "./nfm/parser";
import { serializeNfm } from "./nfm/serializer";
import type { NfmBlock, NfmImage } from "./nfm/types";

/**
 * A written message read as its text Blocks and the images attached after them. An image
 * elsewhere in the body, such as one later moved between paragraphs in the Page, stays in the
 * text, so a body outside the message shape still reads in order.
 */
export interface MessageContent {
  readonly text: readonly NfmBlock[];
  readonly attachments: readonly NfmImage[];
}

export function splitMessageContent(blocks: readonly NfmBlock[]): MessageContent {
  let start = blocks.length;
  while (start > 0) {
    const block = blocks[start - 1]!;
    if (block.type !== "image" || block.children.length > 0) break;
    start -= 1;
  }
  return {
    text: blocks.slice(0, start),
    attachments: blocks.slice(start).filter((block) => block.type === "image"),
  };
}

/** The message's text as Nested Markdown, without its attached images: a prompt draft's start. */
export const messageTextNfm = (nfm: string): string =>
  serializeNfm([...splitMessageContent(parseNfm(nfm)).text]);

/** A Library File attached to a message, as the image Block a Composer writes for it. */
export const messageImageBlock = (fileId: string): NfmImage => ({
  type: "image",
  source: fileSource(fileId),
  caption: [],
  children: [],
});

/**
 * A Composer's message as its Nested Markdown body: the text as typed, then its image Blocks,
 * the message shape Core keeps as the Page body.
 */
export function composeMessageNfm(text: string, images: readonly NfmImage[]): string {
  const lines = text.replace(/\r\n?/g, "\n").trimEnd();
  return [lines, serializeNfm([...images])].filter(Boolean).join("\n");
}
