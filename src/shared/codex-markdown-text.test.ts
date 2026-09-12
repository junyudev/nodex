import { describe, expect, it } from "vitest";
import { projectCodexMarkdownToPlainText as project } from "./codex-markdown-text";

describe("compact Markdown text", () => {
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
  });
  it("retains literal directives in fenced code", () => {
    expect(project('```text\n::literal[value]{attribute="yes"}\n```')).toBe(
      '::literal[value]{attribute="yes"}',
    );
  });
  it("removes private citation payloads", () => {
    expect(project("Evidence \uE200cite\uE202private\uE201 found")).toBe("Evidence found");
  });
});
