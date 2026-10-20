import { describe, expect, it } from "vite-plus/test";
import {
  composeMessageNfm,
  messageImageBlock,
  messageTextNfm,
  splitMessageContent,
} from "./message-content";
import { parseNfm } from "./nfm/parser";

const image = (id: string) => `<image source="nodex://files/${id}">${id}</image>`;
const sources = (blocks: readonly { type: string; source?: string }[]) =>
  blocks.map((block) => block.source ?? block.type);

describe("splitMessageContent", () => {
  it("reads the images after the text as its attachments", () => {
    const content = splitMessageContent(
      parseNfm(["The banner is cut off", "- on hover", image("a"), image("b")].join("\n")),
    );
    expect(sources(content.text)).toEqual(["paragraph", "bulletListItem"]);
    expect(sources(content.attachments)).toEqual(["nodex://files/a", "nodex://files/b"]);
  });

  it("keeps an image between paragraphs in the text, in order", () => {
    const content = splitMessageContent(
      parseNfm(["Before", image("a"), "After", image("b")].join("\n")),
    );
    expect(sources(content.text)).toEqual(["paragraph", "nodex://files/a", "paragraph"]);
    expect(sources(content.attachments)).toEqual(["nodex://files/b"]);
  });

  it("reads a message of images alone as attachments only", () => {
    const content = splitMessageContent(parseNfm(image("a")));
    expect(content.text).toEqual([]);
    expect(sources(content.attachments)).toEqual(["nodex://files/a"]);
  });

  it("drafts a prompt from the text alone, as written", () => {
    expect(messageTextNfm(["**Ship** the changelog", "- tag it", image("a")].join("\n"))).toBe(
      "**Ship** the changelog\n- tag it",
    );
  });

  it("writes a Composer's text and then its images, which read back as its attachments", () => {
    const body = composeMessageNfm("Settings are cut off\r\n- on hover\n\n", [
      messageImageBlock("a"),
      messageImageBlock("b"),
    ]);
    expect(body).toBe(
      'Settings are cut off\n- on hover\n<image source="nodex://files/a"></image>\n<image source="nodex://files/b"></image>',
    );
    const content = splitMessageContent(parseNfm(body));
    expect(sources(content.text)).toEqual(["paragraph", "bulletListItem"]);
    expect(sources(content.attachments)).toEqual(["nodex://files/a", "nodex://files/b"]);
    expect(composeMessageNfm("  ", [messageImageBlock("a")])).toBe(
      '<image source="nodex://files/a"></image>',
    );
  });

  it("rewrites a message's images exactly as its Page has them", () => {
    const body =
      'Settings\n<image source="nodex://files/a" color="blue" preview-width="320">**Toolbar**</image>';
    const { text, attachments } = splitMessageContent(parseNfm(body));
    expect(text).toHaveLength(1);
    expect(composeMessageNfm("Settings", attachments)).toBe(body);
  });
});
