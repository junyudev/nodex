import { describe, expect, it } from "vitest";
import { projectCodexMarkdownToPlainText as project } from "./codex-markdown-text";
import sourceCases from "./fixtures/codex-markdown-source-text.json";

describe("compact Markdown text", () => {
  it("separates words at explicit Markdown and HTML line breaks", () => {
    expect(project("First  \nSecond<br>Third<br />Fourth")).toBe("First Second Third Fourth");
  });
  it.each(sourceCases)("normalizes source text: $source", ({ source, text }) => {
    expect(project(source)).toBe(text);
  });
  it("projects GFM tables, tasks and strikethrough", () => {
    expect(project("| First | Second |\n| --- | --- |\n| ~~old~~ | new |\n\n- [x] done")).toBe(
      "First Second old new done",
    );
  });
  it("hides HTML scripts, styles and comments while retaining visible content", () => {
    expect(project("hello <script>secret **code**</script> world <!-- private -->")).toBe(
      "hello world",
    );
    expect(project("<div>Visible <style>body { color: red }</style> text</div>")).toBe(
      "Visible text",
    );
  });
  it("keeps directive labels and container content without attributes", () => {
    expect(project('::codex-followup[Continue]{prompt="private"}')).toBe("Continue");
    expect(project(':::writing{variant="email"}\nDear reader\n:::')).toBe("Dear reader");
  });
  it("treats non-ASCII or non-letter directive names as literal Markdown", () => {
    expect(project(':1x[label]{key="hidden"}')).toBe(':1x[label]{key="hidden"}');
    expect(project(':中文[label]{key="hidden"}')).toBe(':中文[label]{key="hidden"}');
    expect(project(':中文[**label**]{key="hidden"}')).toBe(':中文[label]{key="hidden"}');
  });
  it("retains literal directives in fenced code", () => {
    expect(project('```text\n::literal[value]{attribute="yes"}\n```')).toBe(
      '::literal[value]{attribute="yes"}',
    );
  });
  it("keeps the source-normalization fence boundary separate from body code semantics", () => {
    const literal = '::codex-inline-vis{file="literal.html"}';
    expect(project(`\`${literal}\``)).toBe(literal.slice(1));
    expect(project(`    ${literal}`)).toBe("");
    expect(project(`>     ${literal}`)).toBe(literal.slice(1));
    expect(project('   ::codex-inline-vis{file="real.html"}')).toBe("");
  });
  it("removes private citation payloads", () => {
    expect(project("Evidence \uE200cite\uE202private\uE201 found")).toBe("Evidence found");
  });
});
