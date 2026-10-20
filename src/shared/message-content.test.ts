import { describe, expect, it } from "vite-plus/test";
import { messageTextNfm, splitMessageContent } from "./message-content";
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
});
