import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vite-plus/test";
import {
  readInlineMarkdown,
  readMarkdown,
  writeInlineMarkdown,
  writePortableMarkdown,
  MarkdownRefusal,
  markdownPlainText,
} from "./index";
import { parseInlineMarkdownTitle, serializeInlineMarkdownTitle } from "./agent-title";

describe("Nodex Markdown facade", () => {
  test("requires explicit initialization before synchronous use", async () => {
    vi.resetModules();
    const fresh = await import("./index");
    expect(() => fresh.readMarkdown("Body")).toThrow("Nodex Markdown is not initialized");
    fresh.initMarkdownSync(
      readFileSync(
        resolve(process.cwd(), "src/shared/generated/nodex-markdown-wasm/nodex_markdown_bg.wasm"),
      ),
    );
    expect(fresh.markdownPlainText(fresh.readMarkdown("**Ready**"))).toBe("Ready");
  });
  test("keeps comment and document line-break policies at the Rust boundary", () => {
    expect(readMarkdown("one\ntwo")).not.toEqual(readMarkdown("one\ntwo", "document"));
    expect(markdownPlainText(readMarkdown("one\ntwo", "document"))).toBe("one two");
    expect(
      writePortableMarkdown(readMarkdown("one\ntwo"), { lineBreaks: "document" }).markdown,
    ).toBe("one\\\ntwo");
  });
  test("reports exact refusal locations and tolerates a streaming container at the boundary", () => {
    expect(() => readMarkdown(":::toggle[Details]\n  Body", "exact")).toThrow(MarkdownRefusal);
    expect(readMarkdown(":::toggle[Details]\n  Body")[0]?.type).toBe("toggleListItem");
  });
  test("keeps inline styles inside links and enforces the title-safe subset", () => {
    const markdown = "[**Bold** and plain](https://example.com) <nodex://sessions/session-1>";
    expect(writeInlineMarkdown(readInlineMarkdown(markdown, "exact"))).toBe(markdown);
    expect(serializeInlineMarkdownTitle(parseInlineMarkdownTitle(markdown))).toBe(markdown);
    for (const unsupported of [
      "# Heading",
      "one<br>two",
      "![icon](icon.svg)<!-- -->",
      ":agent-config{}",
      "$$x$$",
    ]) {
      expect(() => parseInlineMarkdownTitle(unsupported)).toThrow();
    }
  });
  test("portable output omits extension state and can name Page mentions", () => {
    const blocks = readMarkdown(
      ":::toggle[Details]\n  :span[Body]{underline}\n:::\n\n<nodex://pages/page-1>",
      "exact",
    );
    const portable = writePortableMarkdown(blocks, { pageTitles: { "page-1": "Plan" } });
    expect(portable.exact).toBe(false);
    expect(portable.markdown).toContain("[Plan](nodex://pages/page-1)");
    expect(portable.markdown).not.toContain(":span");
  });
});
