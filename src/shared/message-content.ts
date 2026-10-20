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
