import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { parseMessageText } from "../message-text";
import { parseNfm } from "./parser";
import { serializeNfm } from "./serializer";

interface MarkdownInputCase {
  readonly name: string;
  readonly input: string;
  readonly nfm: string;
  readonly types: readonly string[];
}

// The Rust parser in nodex-core is held to the same cases.
const fixture = JSON.parse(
  readFileSync(path.resolve("crates/nodex-core/tests/fixtures/nfm/markdown-input.json"), "utf8"),
) as {
  readonly nestedMarkdown: readonly MarkdownInputCase[];
  readonly messageText: readonly MarkdownInputCase[];
};

describe("Markdown input to Nested Markdown", () => {
  it.each(fixture.nestedMarkdown.map((entry) => [entry.name, entry] as const))(
    "%s",
    (_name, entry) => {
      const blocks = parseNfm(entry.input);
      expect(blocks.map((block) => block.type)).toEqual(entry.types);
      expect(serializeNfm(blocks)).toBe(entry.nfm);
      expect(serializeNfm(parseNfm(entry.nfm))).toBe(entry.nfm);
    },
  );

  it("keeps a paragraph that reads like a Block marker a paragraph", () => {
    for (const text of [
      "- not a list",
      "  + not a list",
      "3) not a list",
      "# not a heading",
      "---",
    ]) {
      const paragraph = parseNfm(
        serializeNfm([
          { type: "paragraph", content: [{ type: "text", text, styles: {} }], children: [] },
        ]),
      );
      expect(paragraph).toEqual([
        {
          type: "paragraph",
          content: [{ type: "text", text, styles: {} }],
          color: undefined,
          children: [],
        },
      ]);
    }
  });
});

describe("message text to Nested Markdown", () => {
  it.each(fixture.messageText.map((entry) => [entry.name, entry] as const))(
    "%s",
    (_name, entry) => {
      const blocks = parseMessageText(entry.input);
      expect(blocks.map((block) => block.type)).toEqual(entry.types);
      expect(serializeNfm(blocks)).toBe(entry.nfm);
      expect(serializeNfm(parseNfm(entry.nfm))).toBe(entry.nfm);
    },
  );
});
