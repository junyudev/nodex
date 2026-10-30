import { describe, expect, it } from "vite-plus/test";
import {
  composeMessageText,
  messageImageBlock,
  messageTextOf,
  parseMessageText,
  serializeMessageText,
  splitMessageContent,
} from "./message-content";
import { readMarkdown } from "./nodex-markdown";

const image = (id: string) => `![](nodex://files/${id})`;
const sources = (blocks: readonly { type: string; props?: Readonly<Record<string, unknown>> }[]) =>
  blocks.map((block) => block.props?.url ?? block.type);

describe("message text", () => {
  it("reads back exactly as it was written", () => {
    for (const text of [
      "Settings buttons have **no labels**:\n\n- the gear\n  - in the toolbar\n- the close button",
      "First line\nsecond line\n\nA new paragraph with a < b and C:\\Users",
      "> quoted\n> twice\n\nThen see https://example.com/docs.",
      "| a | b |\n| - | - |\n| 1 | 2 |",
      "```ts\nconst a = 1;\n\nconst b = 2;\n```",
      "\\- not a list\n1\\. not a number either",
      "Plan:\n  first, the toolbar\n    then the dialogs\nDone.",
      "_italic_, `snake_case` and **注意：**这里",
    ]) {
      const written = serializeMessageText(parseMessageText(text));
      expect(written).not.toBeNull();
      expect(parseMessageText(written!)).toEqual(parseMessageText(text));
    }
  });

  it("writes a stored message back the way a person writes it", () => {
    expect(
      serializeMessageText(readMarkdown("one<br>two\nthree\n- [link](https://a.example/x)")),
    ).toBe("one\ntwo\nthree\n\n- [link](https://a.example/x)");
    expect(
      serializeMessageText(readMarkdown("[https://a.example/x](https://a.example/x) works")),
    ).toBe("https://a.example/x works");
  });

  it("edits every stored extension as exact Markdown source", () => {
    for (const text of [
      "one<br><br>two",
      ":span[underlined]{underline}",
      ":::toggle[Details]\n  Child\n:::",
    ]) {
      const blocks = readMarkdown(text, "exact");
      expect(readMarkdown(serializeMessageText(blocks), "exact")).toEqual(blocks);
    }
  });
});

describe("splitMessageContent", () => {
  it("reads the images before the text as its attachments, shown first", () => {
    const content = splitMessageContent(
      readMarkdown([image("a"), image("b"), "The banner is cut off", "- on hover"].join("\n\n")),
    );
    expect(sources(content.text)).toEqual(["paragraph", "bulletListItem"]);
    expect(sources(content.attachments)).toEqual(["nodex://files/a", "nodex://files/b"]);
    expect(content.attachmentsAt).toBe("start");
  });

  it("keeps the images of a message that ends with them where they are", () => {
    const content = splitMessageContent(
      readMarkdown(["The banner is cut off", "- on hover", image("a"), image("b")].join("\n\n")),
    );
    expect(sources(content.text)).toEqual(["paragraph", "bulletListItem"]);
    expect(sources(content.attachments)).toEqual(["nodex://files/a", "nodex://files/b"]);
    expect(content.attachmentsAt).toBe("end");
  });

  it("keeps an image between paragraphs in the text, in order", () => {
    const content = splitMessageContent(
      readMarkdown(["Before", image("a"), "After", image("b")].join("\n\n")),
    );
    expect(sources(content.text)).toEqual(["paragraph", "nodex://files/a", "paragraph"]);
    expect(sources(content.attachments)).toEqual(["nodex://files/b"]);
    // Only one run is the row: images at both ends leave the last ones in the text.
    const both = splitMessageContent(
      readMarkdown([image("a"), "Between", image("b")].join("\n\n")),
    );
    expect(sources(both.attachments)).toEqual(["nodex://files/a"]);
    expect(sources(both.text)).toEqual(["paragraph", "nodex://files/b"]);
  });

  it("drafts a prompt from the text alone, as written", () => {
    expect(
      messageTextOf(
        [image("a"), "**Ship** the changelog", "- tag it", "Keep a \\< b"].join("\n\n"),
      ),
    ).toBe("**Ship** the changelog\n\n- tag it\n\nKeep a < b");
  });

  it("writes a Composer's images and then its text, which read back as its attachments", () => {
    const body = composeMessageText("Settings are cut off\r\n- on hover\n\n", [
      messageImageBlock("a"),
      messageImageBlock("b"),
    ]);
    expect(body).toBe(
      "![](nodex://files/a)\n\n![](nodex://files/b)\n\nSettings are cut off\n- on hover",
    );
    const content = splitMessageContent(parseMessageText(body));
    expect(sources(content.text)).toEqual(["paragraph", "bulletListItem"]);
    expect(sources(content.attachments)).toEqual(["nodex://files/a", "nodex://files/b"]);
    expect(composeMessageText("  ", [messageImageBlock("a")])).toBe("![](nodex://files/a)");
  });
});
