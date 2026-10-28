import { describe, expect, test } from "vite-plus/test";
import { NODEX_STRUCTURAL_CLIPBOARD_MIME } from "../clipboard-paste";
import { readMarkdownPaste, type ClipboardPayload } from "./paste";

const clipboard = (data: Record<string, string>): ClipboardPayload => ({
  types: Object.keys(data),
  getData: (format) => data[format] ?? "",
});

describe("Markdown paste", () => {
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
