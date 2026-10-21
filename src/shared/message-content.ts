import { fileSource } from "./file-resources";
import { parseNfm } from "./nfm/parser";
import { serializeMessageText } from "./message-text";
import { serializePlainNfm } from "./nfm/plain-source";
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

/**
 * A stored body as the message text a person reads and edits, falling back to plain Nested
 * Markdown for the rare body that message text cannot say exactly.
 */
export const writtenMessageText = (blocks: readonly NfmBlock[]): string =>
  serializeMessageText(blocks) ?? serializePlainNfm(blocks);

/** The message's text without its attached images, as written: a prompt draft's start. */
export const messageTextOf = (nfm: string): string =>
  writtenMessageText(splitMessageContent(parseNfm(nfm)).text);

/** A Library File attached to a message, as the image Block a Composer writes for it. */
export const messageImageBlock = (fileId: string): NfmImage => ({
  type: "image",
  source: fileSource(fileId),
  caption: [],
  children: [],
});

/**
 * A Composer's message as the body Core reads: its message text as typed, then its image
 * Blocks, the message shape Core keeps as the Page body.
 */
export function composeMessageText(text: string, images: readonly NfmImage[]): string {
  const lines = text.replace(/\r\n?/g, "\n").trimEnd();
  return [lines, serializeNfm([...images])].filter(Boolean).join("\n");
}
