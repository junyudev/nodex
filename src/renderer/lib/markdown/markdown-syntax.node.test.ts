import { describe, expect, test } from "vite-plus/test";
import type { Nodes as HtmlNodes, Root as HtmlRoot } from "hast";
import { defaultRehypePlugins, defaultRemarkPlugins } from "streamdown";
import { createMathPlugin } from "@streamdown/math";
import { cjk } from "@streamdown/cjk";
import {
  createMarkdownPrefixCache,
  createMarkdownSyntaxEngine,
  type ImmutableMarkdown,
  type MarkdownSyntaxPolicy,
} from "./markdown-syntax";
import { findMarkdownOpenCodeFence, findMarkdownStablePrefix } from "./markdown-prefix";

const math = createMathPlugin();
const remarks = [
  ...cjk.remarkPluginsBefore,
  ...Object.values(defaultRemarkPlugins),
  ...cjk.remarkPluginsAfter,
  math.remarkPlugin,
];
const rehypes = [...Object.values(defaultRehypePlugins), math.rehypePlugin];
const policy: MarkdownSyntaxPolicy = {
  family: true,
  normalizeLists: true,
  repairIncomplete: true,
  remarkPlugins: remarks,
  rehypePlugins: rehypes,
  blockLocal: true,
};

function semanticHtml(node: ImmutableMarkdown<HtmlNodes>): unknown {
  if (node.type === "text") return node.value.trim() ? node.value : null;
  if (node.type === "element")
    return {
      tag: node.tagName,
      properties: node.properties,
      children: node.children.map(semanticHtml).filter((value) => value !== null),
    };
  if (node.type === "root")
    return node.children.map(semanticHtml).filter((value) => value !== null);
  return null;
}

function combinedHtml(roots: readonly ImmutableMarkdown<HtmlRoot>[]): unknown[] {
  return roots.flatMap((root) => semanticHtml(root) as unknown[]);
}

describe("typed Markdown syntax and prefix consumption", () => {
  test.each(["\u2028", "\u2029", "\u0085"])(
    "does not split a paragraph or terminate code at Unicode separator %j",
    (separator) => {
      expect(findMarkdownStablePrefix(`first${separator}${separator}second`)).toBe(0);
      expect(findMarkdownOpenCodeFence(`\`\`\`text\nalpha${separator}\`\`\``)).toBe(true);
      expect(findMarkdownOpenCodeFence(`\`\`\`text\nalpha\n\`\`\`${separator}`)).toBe(true);
    },
  );
  test("preserves Unicode separators as authored code characters in active and completed syntax", () => {
    const engine = createMarkdownSyntaxEngine();
    const value = "alpha\u2028beta\u2029gamma\u0085delta";
    const source = `\`\`\`text\n${value}\n\`\`\``;
    const complete = engine.read(source, policy);
    expect(complete.ast.children.find((node) => node.type === "code")?.value).toBe(value);
    const active = engine.readStreaming(source, policy, createMarkdownPrefixCache());
    expect(
      active.blocks
        .flatMap(({ syntax }) =>
          syntax.node.type === "root" ? syntax.node.children : [syntax.node],
        )
        .find((node) => node.type === "code")?.value,
    ).toBe(value);
  });
  test("preserves authored blank lines in fenced and indented code through streaming and completion", () => {
    const engine = createMarkdownSyntaxEngine();
    const value = "alpha\n\n\n\nbeta";
    for (const source of [
      `\`\`\`text\n${value}\n\`\`\``,
      "    alpha\n\n\n\n    beta\n",
      `\`\`\`text\r\n${value.replaceAll("\n", "\r\n")}\r\n\`\`\``,
    ]) {
      const syntax = engine.read(source, policy);
      const code = syntax.ast.children.find((node) => node.type === "code");
      expect(code?.value).toBe(value);
      const active = engine.readStreaming(source, policy, createMarkdownPrefixCache());
      const activeCode = active.blocks
        .flatMap(({ syntax }) =>
          syntax.node.type === "root" ? syntax.node.children : [syntax.node],
        )
        .find((node) => node.type === "code");
      expect(activeCode?.value).toBe(value);
    }
  });

  test("returns the same immutable typed tree without reparsing or normalizing a raw-source hit", () => {
    const engine = createMarkdownSyntaxEngine();
    const source = "first\r\n\r\nsecond\u2028third";
    const first = engine.read(source, policy);
    const before = engine.getMeasurements();
    expect(engine.read(source, { ...policy })).toBe(first);
    expect(engine.getMeasurements()).toMatchObject({
      parsedUnits: before.parsedUnits,
      normalizedUnits: before.normalizedUnits,
      parseCalls: before.parseCalls,
      fullCacheHits: 1,
    });
    expect(Object.isFrozen(first.ast)).toBe(true);
    expect(Object.isFrozen(first.ast.children)).toBe(true);
    expect(Object.isFrozen(first.ast.children[0])).toBe(true);
    expect(engine.read(source.replaceAll("\r\n", "\n"), policy)).not.toBe(first);
  });

  test("isolates syntax families, extension array identities, repair and normalization policies", () => {
    const engine = createMarkdownSyntaxEngine();
    const source = "**unfinished";
    const first = engine.read(source, policy);
    for (const changed of [
      { ...policy, family: false },
      { ...policy, normalizeLists: false },
      { ...policy, repairIncomplete: false },
      { ...policy, remarkPlugins: [...remarks] },
    ])
      expect(engine.read(source, changed)).not.toBe(first);
    expect(engine.read(source, policy)).toBe(first);
  });

  test("reuses stable AST and transformed HAST while consuming only the new suffix and tail", () => {
    const engine = createMarkdownSyntaxEngine();
    const prefixes = createMarkdownPrefixCache();
    const first = engine.readStreaming("# Stable\n\nfirst tail", policy, prefixes);
    const before = engine.getMeasurements();
    const next = engine.readStreaming("# Stable\n\nfirst tail\n\nnew tail", policy, prefixes);
    expect(next.blocks[0]?.syntax).toBe(first.blocks[0]?.syntax);
    expect(next.blocks[0]?.html).toBe(first.blocks[0]?.html);
    expect(engine.getMeasurements().parsedUnits - before.parsedUnits).toBe(
      "first tail\n\n".length + "new tail".length,
    );
    expect(engine.getMeasurements().transformedUnits - before.transformedUnits).toBe(
      "first tail".length + "new tail".length,
    );
    const stable = next.blocks[0]!.syntax.node;
    expect(Object.isFrozen(stable)).toBe(true);
    expect(stable).toEqual(first.blocks[0]!.syntax.node);
  });

  test("uses full typed document transforms for references, HTML and unknown root-wide extensions", () => {
    const engine = createMarkdownSyntaxEngine();
    const prefixes = createMarkdownPrefixCache();
    const reference = engine.readStreaming(
      "[read][ref]\n\n[ref]: https://example.com",
      policy,
      prefixes,
    );
    expect(reference.fullDocumentReason).toBe("references");
    expect(semanticHtml(reference.blocks[0]!.html)).toEqual([
      {
        tag: "p",
        properties: {},
        children: [
          {
            tag: "a",
            properties: {
              href: "https://example.com/",
              target: "_blank",
              rel: "noopener noreferrer",
            },
            children: ["read"],
          },
        ],
      },
    ]);
    expect(
      engine.readStreaming("<div>before\n\n<strong>after</strong></div>", policy, prefixes)
        .fullDocumentReason,
    ).toBe("html");
    expect(
      engine.readStreaming("first\n\nsecond", { ...policy, blockLocal: false }, prefixes)
        .fullDocumentReason,
    ).toBe("extension");
  });

  test("keeps code containing HTML or reference-like text in the block-local prefix lane", () => {
    const engine = createMarkdownSyntaxEngine();
    const prefixes = createMarkdownPrefixCache();
    const source = "```ts\nconst node = <T>(value: T) => value; // [name]: literal\n```\n\ntail";
    const first = engine.readStreaming(source, policy, prefixes);
    expect(first.fullDocumentReason).toBeNull();
    const next = engine.readStreaming(source + " append", policy, prefixes);
    expect(next.blocks[0]?.html).toBe(first.blocks[0]?.html);
  });

  test("normalizes ordered-list continuations and list headings on the actual cached typed tree", () => {
    const engine = createMarkdownSyntaxEngine();
    const source = "1. Parent\n\n- Child one\n- Child two\n\n2. Next";
    const repaired = engine.read(source, policy);
    expect(repaired.ast.children).toHaveLength(1);
    const list = repaired.ast.children[0];
    if (list?.type !== "list") throw new Error("Missing ordered list");
    expect(list.children).toHaveLength(2);
    expect(list.children[0]?.children[1]?.type).toBe("list");
    expect(repaired.blocks[0]?.source).toBe(source);
    expect(engine.read(source, { ...policy, normalizeLists: false }).ast.children).toHaveLength(3);
    const heading = engine.read("- ## Heading", policy).ast.children[0];
    if (heading?.type !== "list") throw new Error("Missing heading list");
    expect(heading.children[0]?.children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text", value: "## " },
        { type: "text", value: "Heading" },
      ],
    });
    const colon = engine.read("1. Parent:\n\n- Single child", policy).ast.children[0];
    if (colon?.type !== "list") throw new Error("Missing colon parent");
    expect(colon.children[0]?.children[1]?.type).toBe("list");
    expect(engine.read("1. Parent\n\n- Single child", policy).ast.children).toHaveLength(2);
  });

  test("keeps the cached syntax unchanged when a public transformer mutates its input", () => {
    const mutation = () => (tree: import("mdast").Root) => {
      const paragraph = tree.children.find((node) => node.type === "paragraph");
      if (paragraph?.type === "paragraph")
        paragraph.children.push({ type: "text", value: " appended" });
    };
    const changed = { ...policy, remarkPlugins: [...remarks, mutation] };
    const engine = createMarkdownSyntaxEngine();
    const syntax = engine.read("original", changed);
    const before = structuredClone(syntax.ast);
    const transformed = engine.readFull("original", changed, "terminal");
    expect(semanticHtml(transformed.blocks[0]!.html)).toEqual([
      { tag: "p", properties: {}, children: ["original appended"] },
    ]);
    expect(engine.read("original", changed)).toBe(syntax);
    expect(syntax.ast).toEqual(before);
  });

  test("evicts by real read recency at 100 syntax keys while prefix hits retain insertion order", () => {
    const engine = createMarkdownSyntaxEngine();
    const first = engine.read("entry 0", policy);
    const second = engine.read("entry 1", policy);
    for (let index = 2; index < 100; index += 1) engine.read(`entry ${index}`, policy);
    expect(engine.read("entry 0", policy)).toBe(first);
    engine.read("entry 100", policy);
    expect(engine.read("entry 0", policy)).toBe(first);
    expect(engine.read("entry 1", policy)).not.toBe(second);
    const prefixes = createMarkdownPrefixCache();
    const blocks = engine.read("prefix", policy).blocks;
    for (let index = 0; index < 100; index += 1) prefixes.set(`${index}`, blocks);
    expect(prefixes.get("0")).toBe(blocks);
    prefixes.set("100", blocks);
    expect(prefixes.get("0")).toBeUndefined();
    expect(prefixes.get("1")).toBe(blocks);
  });

  test.each([
    "first\n\nsecond",
    "first\r\n\r\nsecond",
    "first\u2028\u2028second",
    "first\n\n- continuation\n\n  nested",
    "first\n\n> quote\n\n> continuation",
    "````js\n\n```\n\ntext\n````\n\nnext",
    "~~~js\n\n```\n\ntext\n~~~\n\nnext",
    "$$\nx\n\n\ny\n$$\n\nnext",
    ":::outer\n\n:::inner\n\ntext\n:::\n\nmore\n:::\n\nnext",
  ])("never makes a prefix boundary inside a scoped block: %s", (source) => {
    const offset = findMarkdownStablePrefix(source);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThan(source.length);
    if (
      source.startsWith("``") ||
      source.startsWith("~~~") ||
      source.startsWith("$$") ||
      source.startsWith(":::")
    )
      expect(source.slice(offset)).toBe("next");
    if (source === "first\n\nsecond" || source === "first\r\n\r\nsecond")
      expect(source.slice(offset)).toBe("second");
  });

  test.each([
    "# Heading\n\nHello **bold** and _emphasis_.\n\nlast",
    "# 前缀\n\n中文标点，emoji 👩‍💻 and `code`。\n\n尾巴",
    "first\n\n- one\n  - nested\n- two\n\nlast",
    "first\n\n> quoted\n> **bold**\n\nlast",
    "first\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nlast",
    "first\n\n```ts\nconst x = 1;\n```\n\nlast",
    "first\n\n$$\nx^2\n$$\n\nlast",
    "first\n\n[link](https://example.com) and ![image](https://example.com/x.png)\n\nlast",
    "first\n\nfootnote[^a]\n\n[^a]: note",
    "first\n\n[reference][r]\n\n[r]: https://example.com",
    "first\n\n<details><summary>Open</summary><p>body</p></details>",
    "first\r\n\r\nsecond\u2028\u2028third",
  ])("matches the full public rich transform at every arrival prefix: %s", (source) => {
    const engine = createMarkdownSyntaxEngine();
    const prefixes = createMarkdownPrefixCache();
    for (let length = 1; length <= source.length; length += 1) {
      const current = source.slice(0, length);
      const incremental = engine.readStreaming(current, policy, prefixes);
      const full = engine.readFull(current, policy, "terminal");
      expect(combinedHtml(incremental.blocks.map((block) => block.html))).toEqual(
        combinedHtml(full.blocks.map((block) => block.html)),
      );
    }
  });
});

describe("syntax capacity and complete large documents", () => {
  test("admits the inclusive one-million boundary but renders oversized source without caching", () => {
    const engine = createMarkdownSyntaxEngine();
    const source = "a".repeat(1_000_000);
    const boundary = engine.read(source, policy);
    expect(engine.read(source, policy)).toBe(boundary);
    const oversized = source + " tail beyond the cache";
    const first = engine.read(oversized, policy);
    expect(engine.read(oversized, policy)).not.toBe(first);
    const result = engine.readFull(oversized, policy, "terminal");
    const paragraph = result.blocks[0]!.html.children[0];
    expect(paragraph?.type).toBe("element");
    if (paragraph?.type !== "element") throw new Error("Missing complete paragraph");
    const text = paragraph.children[0];
    expect(text?.type).toBe("text");
    if (text?.type !== "text") throw new Error("Missing complete text");
    expect(text.value).toBe(oversized);
  });
  test("enforces the six-million aggregate raw-key budget independently of key count", () => {
    const engine = createMarkdownSyntaxEngine();
    const value = "a".repeat(900_000);
    const first = engine.read(`0 ${value}`, policy);
    const second = engine.read(`1 ${value}`, policy);
    for (let index = 2; index < 7; index += 1) engine.read(`${index} ${value}`, policy);
    expect(engine.read(`1 ${value}`, policy)).toBe(second);
    expect(engine.read(`0 ${value}`, policy)).not.toBe(first);
  });
});
