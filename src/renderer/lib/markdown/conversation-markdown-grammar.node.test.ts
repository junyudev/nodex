import { describe, expect, test } from "vite-plus/test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { remarkConversationMarkdown } from "./conversation-markdown-grammar";
import { readMarkdownSyntaxPolicy } from "./markdown-policy";
import { createMarkdownSyntaxEngine, createMarkdownPrefixCache } from "./markdown-syntax";
import { projectConversationMarkdownDisplayText as visible } from "./conversation-markdown-display";

const parser = unified()
  .use(remarkParse)
  .use(remarkConversationMarkdown, {
    renderedDirectiveNames: ["codex-inline-vis"],
    nullDirectiveNames: [],
  });
const tree = (source: string) => parser.runSync(parser.parse(source), source);
const policy = (streaming: boolean) =>
  readMarkdownSyntaxPolicy({
    dialect: "conversation",
    preserveLineBreaks: true,
    visualizations: true,
    fileMedia: false,
    repairIncomplete: streaming,
  });

describe("conversation grammar through public typed extensions", () => {
  test("keeps phrasing adjacency while separating actual paragraph and cell boundaries", () => {
    expect(visible("**hel**lo", false)).toBe("hello");
    expect(visible("[a](https://example.com)bc", false)).toBe("abc");
    expect(visible("**one**\n\n**two**", false)).toBe("one two");
    expect(visible("| one | two |\n| --- | --- |\n| three | four |", false)).toBe(
      "one two three four",
    );
  });
  test("keeps single tilde literal and full namespaced skill candidates", () => {
    expect(tree("~one~ and ~~two~~").children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text", value: "~one~ and " },
        { type: "delete", children: [{ type: "text", value: "two" }] },
      ],
    });
    expect(tree("Use $namespace:skill.").children[0]).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", value: "Use $namespace:skill." }],
    });
  });
  test.each([
    '::unknown{a="x&amp;y"}',
    ":unknown[label]{#identity}",
    ":::unknown\n**kept literally**\n:::",
  ])("preserves the full authored unknown declaration: %j", (source) => {
    expect(tree(source).children[0]).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", value: source }],
    });
    expect(visible(source, false)).toBe(source.replace(/\s+/g, " "));
  });
  test("renders raw HTML literally while document Markdown keeps its independent HTML policy", () => {
    for (const source of ["before <kbd>Cmd</kbd> after", "<script>secret()</script>visible"])
      expect(visible(source, false)).toBe(source);
    expect(visible("first<br>second", false)).toBe("first second");
    expect(visible("Name\n---", false)).toBe("Name");
    const engine = createMarkdownSyntaxEngine();
    const document = readMarkdownSyntaxPolicy({
      preserveLineBreaks: true,
      visualizations: false,
      fileMedia: false,
      repairIncomplete: false,
    });
    const source = "before <kbd>Cmd</kbd> after";
    expect(engine.readFull(source, policy(false), "terminal").blocks[0]!.html).not.toEqual(
      engine.readFull(source, document, "terminal").blocks[0]!.html,
    );
  });
  test("excludes code from execution and preserves authored code separators", () => {
    const value =
      'alpha\n\n\n\nbeta\u2028gamma\u2029delta\u0085epsilon\n::codex-inline-vis{file="chart.html"}';
    const source = `\`\`\`text\n${value}\n\`\`\``;
    const engine = createMarkdownSyntaxEngine();
    for (const streaming of [false, true]) {
      const nodes = engine.read(source, policy(streaming)).ast.children;
      expect(nodes).toHaveLength(1);
      expect(nodes[0]).toMatchObject({ type: "code", value });
    }
  });
  test("uses phase-sensitive caches without rescanning a hit or changing settled prefixes", () => {
    const engine = createMarkdownSyntaxEngine();
    const source = "# Stable\n\nHello [world";
    engine.readStreaming(source, policy(true), createMarkdownPrefixCache());
    const snapshot = engine.read(source, policy(true));
    const hitBefore = engine.getMeasurements();
    expect(engine.read(source, policy(true))).toBe(snapshot);
    expect(engine.getMeasurements().normalizedUnits).toBe(hitBefore.normalizedUnits);
    expect(engine.getMeasurements().parseCalls).toBe(hitBefore.parseCalls);
    expect(visible(source, true)).toBe("Stable Hello");
    expect(visible(source, false)).toBe("Stable Hello [world");
    const prefixes = createMarkdownPrefixCache();
    const a = engine.readStreaming("# Stable\n\nfirst tail", policy(true), prefixes);
    const b = engine.readStreaming("# Stable\n\nfirst tail\n\nsecond tail", policy(true), prefixes);
    expect(b.blocks[0]!.syntax).toBe(a.blocks[0]!.syntax);
    expect(b.blocks[0]!.html).toBe(a.blocks[0]!.html);
  });
});
