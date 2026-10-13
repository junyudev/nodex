import { describe, expect, test } from "vite-plus/test";
import boundaries from "./fixtures/conversation-token-boundaries.json";
import { createConversationTokenEngine } from "./conversation-tokens";
import { createConversationDocumentOwner } from "./conversation-document";

function semantic(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((token) => token.type !== "space").map(semantic);
  if (value === null || typeof value !== "object") return value;
  const token = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(token)
      .filter(([key]) =>
        [
          "type",
          "raw",
          "text",
          "display",
          "name",
          "attributes",
          "block",
          "depth",
          "href",
          "lang",
          "ordered",
          "start",
          "checked",
          "loose",
          "task",
          "tokens",
          "items",
        ].includes(key),
      )
      .map(([key, child]) => [key, key === "tokens" || key === "items" ? semantic(child) : child]),
  );
}

describe("conversation token grammar", () => {
  const engine = createConversationTokenEngine();
  test("keeps phase-sensitive syntax immutable without parsing a cached source again", () => {
    const source = "# Stable\n\nHello [world";
    const first = engine.read(source, true);
    const before = engine.getMeasurements();
    expect(engine.read(source, true)).toBe(first);
    expect(engine.getMeasurements()).toEqual(before);
    expect(Object.isFrozen(first.tokens[0])).toBe(true);
    expect(engine.read(source, false)).not.toBe(first);
  });
  test.each(boundaries)("preserves the grammar and payload of $source", ({ source, tokens }) => {
    expect(semantic(engine.read(source, false).tokens)).toEqual(tokens);
  });
  test("keeps artifact addresses literal without changing explicit links or ordinary email", () => {
    const result = engine.read(
      "logo@2x.png [explicit](mailto:logo@2x.png) normal@example.com",
      false,
    );
    const paragraph = result.tokens[0];
    expect(paragraph).toMatchObject({
      type: "paragraph",
      tokens: [
        { type: "text", text: "logo@2x.png" },
        { type: "text", text: " " },
        { type: "link", href: "mailto:logo@2x.png" },
        { type: "text", text: " " },
        { type: "link", href: "mailto:normal@example.com" },
      ],
    });
  });
  test("reuses committed prefix plans and keeps terminal controls after a preceding insertion", () => {
    const owner = createConversationDocumentOwner(null, engine);
    const source = "Stable\n\n```text\ncode\n```\n\ntail";
    const first = owner.prepare(source, true);
    owner.commit(first, true);
    const second = owner.prepare(`${source} appended`, true);
    expect(second.nodes[0]).toBe(first.nodes[0]);
    expect(second.nodes.find((node) => node.token.type === "code")).toBe(
      first.nodes.find((node) => node.token.type === "code"),
    );
    owner.commit(second, true);
    const terminal = owner.prepare(`New preceding\n\n${source} appended`, false);
    expect(terminal.nodes.find((node) => node.token.type === "code")?.key).toBe(
      first.nodes.find((node) => node.token.type === "code")?.key,
    );
  });
  test("references and revised source reparse instead of retaining an obsolete prefix", () => {
    const prefix = { source: "", length: 0, document: null };
    const first = engine.readStreaming("[label][ref]\n\ntail", prefix);
    const second = engine.readStreaming(
      "[label][ref]\n\ntail\n\n[ref]: https://example.com",
      prefix,
    );
    expect(second.fullDocument).toBe(true);
    expect(second.tokens).not.toBe(first.tokens);
    expect(second.tokens[0]).toMatchObject({
      type: "paragraph",
      tokens: [{ type: "link", href: "https://example.com" }],
    });
  });
  test.each([
    "See [label][ref]\n\n> [ref]: https://example.com\n\nnext tail",
    "> [ref]: https://example.com\n\nSee [label][ref]\n\nnext tail",
    "See [label][ref]\n\n- [ref]: https://example.com\n\nnext tail",
  ])("resolves container reference definitions at every streaming boundary: %s", (source) => {
    const syntax = createConversationTokenEngine();
    const prefix = { source: "", length: 0, document: null };
    for (let end = 1; end <= source.length; end += 1) {
      const partial = source.slice(0, end);
      expect(semantic(syntax.readStreaming(partial, prefix).tokens)).toEqual(
        semantic(syntax.read(partial, true).tokens),
      );
    }
  });
  test.each([
    "![one](https://example.com/one.png)\n\n![two](https://example.com/two.png)",
    "1. Parent:\n\n- one\n- two\n\n2. Continue",
  ])("keeps cross-block normalization identical while appending: %s", (source) => {
    const prefix = { source: "", length: 0, document: null };
    for (let end = 1; end <= source.length; end += 1) {
      expect(semantic(engine.readStreaming(source.slice(0, end), prefix).tokens)).toEqual(
        semantic(engine.read(source.slice(0, end), true).tokens),
      );
    }
  });
  test("parses an appended paragraph without reparsing thousands of stable paragraphs", () => {
    const syntax = createConversationTokenEngine();
    const prefix = { source: "", length: 0, document: null };
    const stable = Array.from({ length: 4000 }, (_value, index) => `Paragraph ${index}\n\n`).join(
      "",
    );
    const first = syntax.readStreaming(`${stable}current tail`, prefix);
    const before = syntax.getMeasurements();
    const next = syntax.readStreaming(`${stable}current tail\n\nnext tail`, prefix);
    expect(next.tokens[0]).toBe(first.tokens[0]);
    expect(syntax.getMeasurements().parsedUnits - before.parsedUnits).toBeLessThan(100);
    expect(semantic(next.tokens)).toEqual(
      semantic(syntax.read(`${stable}current tail\n\nnext tail`, true).tokens),
    );
  });
});
