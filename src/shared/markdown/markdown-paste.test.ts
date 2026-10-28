import { describe, expect, test } from "vite-plus/test";
import { NODEX_STRUCTURAL_CLIPBOARD_MIME } from "../clipboard-paste";
import { readMarkdown } from "../nodex-markdown";
import {
  readMarkdownPaste,
  readPageTextPaste,
  readPlainTextBlocks,
  type ClipboardPayload,
} from "./paste";
import {
  richHtmlPageMarkdown,
  richHtmlPlainText,
  richHtmlSpacerFixtures,
} from "./__fixtures__/rich-html-paste";

const clipboard = (data: Record<string, string>): ClipboardPayload => ({
  types: Object.keys(data),
  getData: (format) => data[format] ?? "",
});

describe("Markdown paste", () => {
  test.each(richHtmlSpacerFixtures)("omits rich HTML spacer lines from $source", (fixture) => {
    expect(
      readMarkdownPaste(
        clipboard({
          "text/html": fixture.html,
          "text/plain": richHtmlPlainText,
        }),
      ),
    ).toBe("composer" in fixture ? fixture.composer : richHtmlPageMarkdown);
  });
  test("rich text from another app arrives as its Markdown, with every line", () => {
    expect(
      readMarkdownPaste(
        clipboard({
          "text/plain": "Steps\none\ntwo\nRead the docs",
          "text/html":
            '<p><b>Steps</b></p><ul><li>one</li><li>two</li></ul><p>Read <a href="https://e.x/docs">the docs</a></p>',
        }),
      ),
    ).toBe("**Steps**\n- one\n- two\n\nRead [the docs](https://e.x/docs)");
    expect(
      readMarkdownPaste(
        clipboard({
          "text/plain": "first line\nsecond line",
          "text/html": "first line<br>second line",
        }),
      ),
    ).toBe("first line\nsecond line");
  });

  test("Markdown a source provides, and Nodex's own copies, arrive as written", () => {
    expect(
      readMarkdownPaste(
        clipboard({ "text/markdown": "# Title", "text/html": "<h1>Other</h1>", "text/plain": "x" }),
      ),
    ).toBe("# Title");
    expect(
      readMarkdownPaste(
        clipboard({
          "text/plain": "- [ ] task",
          "text/html": "<ul><li>task</li></ul>",
          [NODEX_STRUCTURAL_CLIPBOARD_MIME]: "{}",
        }),
      ),
    ).toBe("- [ ] task");
  });

  test("code from an editor or a code block keeps its exact text", () => {
    const code = "const a = 1;\n\nfunction b() {}";
    expect(
      readMarkdownPaste(
        clipboard({
          "text/plain": code,
          "text/html":
            "<div><div>const a = 1;</div><div><br></div><div>function b() {}</div></div>",
          "vscode-editor-data": '{"mode":"typescript"}',
        }),
      ),
    ).toBe(code);
    expect(
      readMarkdownPaste(
        clipboard({
          "text/plain": code,
          "text/html": `<meta charset="utf-8"><pre style="font-family:'JetBrains Mono'">${code}</pre>`,
        }),
      ),
    ).toBe(code);
  });

  test("plain text is kept when converting the rich copy would lose its words", () => {
    expect(
      readMarkdownPaste(
        clipboard({
          "text/plain": "visible words and more",
          "text/html": "<p>visible words</p>",
        }),
      ),
    ).toBe("visible words and more");
    expect(readMarkdownPaste(clipboard({ "text/plain": "just text" }))).toBe("just text");
    expect(readMarkdownPaste(clipboard({}))).toBeNull();
  });
  test("leaves inline HTML images to the attachment ingress", () => {
    const data = {
      "text/plain": "Before after",
      "text/html": '<p>Before <img src="badge.svg" alt="Badge">after</p>',
    };
    expect(
      readMarkdownPaste({
        types: Object.keys(data),
        getData: (format) => data[format as keyof typeof data] ?? "",
      }),
    ).toBe("Before after");
  });
});

const lines = (...texts: string[]) =>
  texts.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] }));

describe("Page text paste", () => {
  test("plain text that is not Markdown becomes a Block per line, exactly as written", () => {
    expect(
      readPlainTextBlocks(
        "第一行\n第二行\r\n\n   \n\t缩进  两个空格\nsee https://e.x/a, www.e.x or a@b.co\n",
      ),
    ).toEqual(
      lines("第一行", "第二行", "\t缩进  两个空格", "see https://e.x/a, www.e.x or a@b.co"),
    );
    expect(readPlainTextBlocks("Error: boom\n    at run (job.js:1:2)")).toEqual(
      lines("Error: boom", "    at run (job.js:1:2)"),
    );
    expect(readPlainTextBlocks("    indented first\nnext")).toEqual(
      lines("    indented first", "next"),
    );
    expect(readPlainTextBlocks("AT&amp;T \\* <!-- kept -->")).toEqual(
      lines("AT&amp;T \\* <!-- kept -->"),
    );
    expect(readPlainTextBlocks(" \n\n")).toEqual([]);
  });

  test.each([
    "# Plan\n\n- one\n- two",
    "**Ship** it\nwith a line break\n\nNext Block",
    "```ts\nconst a = 1;\n```",
    "> quoted",
    "Read [the docs](https://e.x/docs)",
    "| a | b |\n| - | - |\n| 1 | 2 |",
    "---",
  ])("plain text written in Markdown reads as its Blocks: %j", (text) => {
    expect(readPlainTextBlocks(text)).toEqual(readMarkdown(text, "boundary"));
  });

  test("Markdown a source provides reads as Markdown, and plain text alone by its own rule", () => {
    expect(
      readPageTextPaste(clipboard({ "text/markdown": "# Title", "text/plain": "Title" })),
    ).toEqual(readMarkdown("# Title", "boundary"));
    expect(readPageTextPaste(clipboard({ "text/plain": "one\ntwo" }))).toEqual(lines("one", "two"));
  });

  test("rich text decides, unless its plain text writes a table", () => {
    expect(
      readPageTextPaste(
        clipboard({ "text/plain": "- a\n- b", "text/html": "<p>- a</p><p>- b</p>" }),
      ),
    ).toEqual([]);
    const table = "| a | b |\n| - | - |\n| 1 | 2 |";
    expect(
      readPageTextPaste(clipboard({ "text/plain": table, "text/html": `<pre>${table}</pre>` })),
    ).toEqual(readMarkdown(table, "boundary"));
  });

  test("code from an editor and Nodex's own copies keep their rich form", () => {
    const table = "| a | b |\n| - | - |\n| 1 | 2 |";
    expect(
      readPageTextPaste(clipboard({ "text/plain": table, "vscode-editor-data": '{"mode":"md"}' })),
    ).toEqual([]);
    expect(
      readPageTextPaste(
        clipboard({ "text/plain": table, "text/markdown": table, "blocknote/html": "<table />" }),
      ),
    ).toEqual([]);
  });
});
