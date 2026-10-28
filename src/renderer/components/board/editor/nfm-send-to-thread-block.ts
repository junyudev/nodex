import type { MarkdownBlock } from "../../../../shared/nodex-markdown";
import { createUuidV7 } from "../../../../shared/uuid-v7";

export interface NfmSendToThreadToggleBlock {
  id: string;
  type: "toggleListItem";
  props: Record<string, never>;
  content: Array<
    | { type: "text"; text: string; styles: Record<string, never> }
    | { type: "threadMention"; props: { uuid: string } }
  >;
  children: readonly MarkdownBlock[];
}

export function createSendToThreadToggleBlock(input: {
  sessionId: string;
  children: readonly MarkdownBlock[];
  blockId?: string;
}): NfmSendToThreadToggleBlock {
  return {
    id: input.blockId ?? createUuidV7(),
    type: "toggleListItem",
    props: {},
    content: [
      { type: "text", text: "sent to ", styles: {} },
      { type: "threadMention", props: { uuid: input.sessionId } },
    ],
    children: input.children,
  };
}
