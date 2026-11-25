import { describe, expect, test } from "vite-plus/test";
import {
  conversationTokenChildren,
  createConversationTokenEngine,
  type ConversationToken,
} from "./conversation-tokens";
import { readConversationDirectiveRegistration } from "./conversation-directive-registry";
import { createConversationDocumentOwner } from "./conversation-document";
import type { CodexComposerSkill } from "../../../shared/types";
import cases from "./fixtures/conversation-markdown-targets.json";
import {
  interpretConversationFilePath,
  readConversationFileCitation,
  readConversationTextDecorations,
  resolveConversationFileLink,
  resolveConversationInlineCode,
  resolveConversationMarkdownLink,
  resolveConversationSkill,
  resolveConversationThreadLink,
} from "./conversation-markdown-targets";
import boundaries from "./fixtures/conversation-token-boundaries.json";

describe("conversation directive registry", () => {
  const engine = createConversationTokenEngine();
  function read(source: string) {
    const visit = (tokens: readonly ConversationToken[]): ConversationToken | undefined => {
      for (const token of tokens) {
        if (token.type === "codexDirective") return token;
        const child = visit(conversationTokenChildren(token));
        if (child) return child;
      }
      return undefined;
    };
    const token = visit(engine.read(source, false).tokens);
    if (!token || token.type !== "codexDirective") throw new Error("Missing parsed directive");
    return { token, registration: readConversationDirectiveRegistration(token) };
  }

  describe("conversation directive registration", () => {
    test.each([
      ':github-details[Inline]{summary="More"}',
      '::github-details[Leaf]{summary="More"}',
      ':::github-details{summary="More"}\nContainer\n:::',
    ])("keeps renderer admission independent of the directive marker family: %s", (source) => {
      expect(read(source).registration.kind).toBe("github-details");
    });
    test.each([
      ['open="true"', true],
      ["open=true", true],
      ["open", false],
      ['open="TRUE"', false],
      ["open=1", false],
      ['open="false"', false],
      ["", false],
    ])("uses parsed string attributes for disclosure state: %s", (attribute, initiallyOpen) => {
      const { token, registration } = read(
        `:::github-details{summary="More" ${attribute}}\nBody **strong**\n:::`,
      );
      expect(registration).toEqual({ kind: "github-details", summary: "More", initiallyOpen });
      expect(token.tokens.some((child) => child.type === "paragraph")).toBe(true);
      expect(Object.isFrozen(token)).toBe(true);
    });

    test("does not invent summary text or reinterpret a valueless attribute", () => {
      expect(read(":::github-details{summary}\nBody\n:::").registration).toEqual({
        kind: "github-details",
        summary: undefined,
        initiallyOpen: false,
      });
    });

    test.each(["inbox-item", "created-thread", "git-push"])(
      "keeps registered null metadata separate from unregistered content: %s",
      (name) => {
        expect(read(`::${name}{title="No UI"}`).registration).toEqual({ kind: "null" });
      },
    );

    test.each([
      [':task-stub[raw **inline**]{title="Review"}', "raw **inline**"],
      ['::task-stub[raw **leaf**]{title="Review"}', "raw **leaf**"],
      [
        ':::task-stub{title="Review"}\nraw **body**\n\nkeep `code`\n:::',
        "\nraw **body**\n\nkeep `code`",
      ],
    ])("keeps a task's authored prompt separate from its title: %s", (source, prompt) => {
      expect(read(source).registration).toEqual({ kind: "task-stub", title: "Review", prompt });
    });
    test("preserves empty task fields without inventing a submission gate", () => {
      expect(read("::task-stub{title}").registration).toEqual({
        kind: "task-stub",
        title: "",
        prompt: "",
      });
    });
    test.each(["unknown-next", "code-comment", "writing", "automation-citation"])(
      "does not grant a renderer to an unowned family: %s",
      (name) => {
        const source = `:::${name}{title="Keep"}\nAuthored body\n:::`;
        const { token, registration } = read(source);
        expect(registration).toEqual({ kind: "unregistered" });
        expect(token.raw).toBe(source);
      },
    );
  });
});

describe("conversation document", () => {
  test("append and a revised tail preserve keys without indexing the old siblings", () => {
    const owner = createConversationDocumentOwner(null, createConversationTokenEngine());
    const source = "Repeated\n\nRepeated\n\nTail";
    const first = owner.prepare(source, true);
    owner.commit(first, true);
    const keys = (candidate: typeof first) => candidate.nodes.map((node) => node.key);
    const rewrite = owner.prepare(source + " growing", true);
    expect(keys(rewrite)).toEqual(keys(first));
    owner.commit(rewrite, true);
    const append = owner.prepare(source + " growing\n\nNew block", true);
    expect(keys(append).slice(0, first.nodes.length)).toEqual(keys(first));
    expect(owner.getMeasurements().contentIndexesBuilt).toBe(0);
  });

  test("unchanged fences reserve their keys ahead of an insertion, even with repeated code", () => {
    const owner = createConversationDocumentOwner(null, createConversationTokenEngine());
    const block = (code: string) => "\x60\x60\x60ts\n" + code + "\n\x60\x60\x60";
    const source = [block("one"), block("two"), block("one")].join("\n\n");
    const first = owner.prepare(source, false);
    owner.commit(first, false);
    const discarded = owner.prepare(block("discarded") + "\n\n" + source, false);
    const actual = owner.prepare(block("inserted") + "\n\n" + source, false);
    const fences = (candidate: typeof first) =>
      candidate.nodes.filter((node) => node.token.type === "code").map((node) => node.key);
    expect(fences(actual).slice(1)).toEqual(fences(first));
    expect(fences(actual)[0]).toBe(fences(discarded)[0]);
    expect(new Set(fences(actual)).size).toBe(4);
    expect(owner.getMeasurements().contentIndexesBuilt).toBe(2);
  });
});

describe("authored conversation targets", () => {
  test("blocked URI schemes cannot become filesystem targets or Skill actions", () => {
    for (const href of [
      "javascript:foo/path.ts",
      "vbscript:foo/path.ts",
      "data:text/plain,/tmp/a.ts",
    ])
      expect(resolveConversationMarkdownLink(href, "$edit")).toBeNull();
  });
  test.each(cases.filter((entry) => entry.links.length > 0))(
    "closes the href interpretation stages for $name",
    ({ links }) => {
      for (const link of links) {
        const target = resolveConversationFileLink(link.href, "x");
        if (link.reference === null) {
          expect(target).toBeNull();
          continue;
        }
        expect(target?.reference).toEqual(link.reference);
        expect(target?.label).toBe(link.label);
      }
    },
  );
  test("keeps malformed native escapes literal as a whole, rejects URI errors and never treats authority as a host", () => {
    expect(interpretConversationFilePath("/tmp/a%ZZ%23b.ts")).toBe("/tmp/a%ZZ%23b.ts");
    expect(interpretConversationFilePath("file:///tmp/a%ZZ.ts")).toBeNull();
    expect(resolveConversationFileLink("file://other-host/share/a.ts", "a")?.reference).toEqual({
      path: "\\\\other-host\\share\\a.ts",
    });
    expect(resolveConversationFileLink("/tmp/a\0b.ts", "a")).toBeNull();
  });
  test("does not decode the direct inline-code native lane like an ordinary link", () => {
    expect(resolveConversationInlineCode("@/tmp/a%2520b.ts:2")?.kind).toBe("file");
    expect(resolveConversationInlineCode("@/tmp/a%2520b.ts:2")).toMatchObject({
      reference: { path: "/tmp/a%2520b.ts", line: 2 },
    });
    expect(resolveConversationInlineCode("[a](/tmp/a%2520b.ts:2)")).toMatchObject({
      reference: { path: "/tmp/a b.ts", line: 2 },
    });
    expect(resolveConversationInlineCode("@/tmp/directory")).toBeNull();
    expect(resolveConversationInlineCode("$[multi word]")).toMatchObject({
      kind: "skill",
      name: "multi word",
    });
  });
  test.each([
    ["thread://same", { threadId: "same" }],
    [
      "thread://same?hostId=remote-ssh%3Ahost",
      { threadId: "same", explicitHostId: "remote-ssh:host" },
    ],
    ["thread://same?hostId=remote%252Fhost", null],
    ["thread://same?hostId=remote%2Fhost", null],
    ["thread://same?hostId=remote&other=x", null],
    ["thread://same/extra", null],
    ["thread://same?hostId=", null],
    ["thread://same?hostId=bad%ZZ", null],
  ] as const)("interprets only the typed thread URI grammar: %s", (href, expected) => {
    expect(resolveConversationThreadLink(href)).toEqual(expected);
  });
  test("citations decode once and preserve endpoint order while dropping nonpositive reveal positions", () => {
    expect(readConversationFileCitation("【F:src/a%2520b.ts†L8-L2】")).toEqual({
      raw: "【F:src/a%2520b.ts†L8-L2】",
      reference: { path: "src/a%20b.ts", line: 8, endLine: 2 },
    });
    expect(readConversationFileCitation("【F:src/a.ts†L0-L2】")?.reference).toEqual({
      path: "src/a.ts",
      endLine: 2,
    });
    expect(readConversationFileCitation("【src/a.ts†L2】")).toBeNull();
    expect(readConversationFileCitation("【F:src/a.ts†L2-x】")).toBeNull();
    expect(readConversationFileCitation("【/tmp/a%ZZ.ts†L2】")?.reference.path).toBe(
      "/tmp/a%ZZ.ts",
    );
  });
  test("a unique Skill catalog result does not grant remote or ambiguous definition interaction", () => {
    const skill: CodexComposerSkill = {
      name: "edit",
      displayName: "Edit files",
      description: "Edit",
      iconUrl: null,
      brandColor: null,
      path: "/skills/edit/SKILL.md",
      scope: "user",
    };
    const target = { kind: "skill", name: "edit", label: "$edit" } as const;
    expect(resolveConversationSkill(target, [], "local").reference).toBeNull();
    expect(
      resolveConversationSkill(target, [skill, { ...skill, path: "/other/SKILL.md" }], "local")
        .reference,
    ).toBeNull();
    expect(resolveConversationSkill(target, [skill], "remote")).toMatchObject({
      label: "Edit files",
      reference: null,
    });
    expect(resolveConversationSkill(target, [skill], null).reference).toBeNull();
    expect(resolveConversationSkill(target, [skill], "local").reference).toEqual({
      path: skill.path,
    });
    expect(
      resolveConversationSkill({ ...target, href: "/SKILLS/EDIT/SKILL.md" }, [skill], "local")
        .reference,
    ).toEqual({ path: "/SKILLS/EDIT/SKILL.md" });
  });
  test("limits color swatches to full six-digit values outside issue and numeric PR contexts", () => {
    expect(readConversationTextDecorations("Use $edit at @src/file.ts and #a1b2c3")).toEqual([
      { index: 4, content: "$edit", type: "mention" },
      { index: 13, content: "@src/file.ts", type: "mention" },
      { index: 30, content: "#a1b2c3", type: "color" },
    ]);
    expect(readConversationTextDecorations("issue #a1b2c3")).toEqual([]);
    expect(readConversationTextDecorations("PRs #123456 and #a1b2c3")).toEqual([
      { index: 16, content: "#a1b2c3", type: "color" },
    ]);
    expect(readConversationTextDecorations("#a1b2c3", "prefix")).toEqual([]);
    expect(readConversationTextDecorations("#abcd12x")).toEqual([]);
  });
});

describe("conversation target grammar", () => {
  function findLinks(
    tokens: readonly ConversationToken[],
  ): Extract<ConversationToken, { type: "link" }>[] {
    return tokens.flatMap((token) => [
      ...(token.type === "link" ? [token] : []),
      ...findLinks(conversationTokenChildren(token)),
    ]);
  }
  describe("ordinary authored file target grammar", () => {
    const engine = createConversationTokenEngine();
    test.each(cases)(
      "passes actual lexer/recovery to the typed target for $name",
      ({ source, links }) => {
        const document = engine.read(source, false);
        const actual = findLinks(document.tokens);
        expect(actual).toHaveLength(links.length);
        expect(
          actual.map((link) => ({
            href: link.href,
            reference: resolveConversationFileLink(link.href, link.text)?.reference ?? null,
            label: resolveConversationFileLink(link.href, link.text)?.label ?? null,
          })),
        ).toEqual(links);
        expect(Object.isFrozen(document)).toBe(true);
      },
    );
    test("preserves code/escape scopes and nested reference metadata while admitting real citations", () => {
      const citation = "【F:src/a%2520b.ts†L0-L2】";
      const document = engine.read(
        `${citation}\n\n\`${citation}\`\n\n\`\`\`text\n${citation}\n\`\`\``,
        false,
      );
      const token = conversationTokenChildren(document.tokens[0]!)[0];
      expect(token).toMatchObject({
        type: "codexDirective",
        name: "codex-file-citation",
        block: false,
        attributes: { path: "src/a%20b.ts", line_range_start: "0", line_range_end: "2" },
      });
      const last = document.tokens.findLast((value) => value.type === "code");
      expect(last).toMatchObject({ type: "code", text: citation });
      const streaming = engine.readStreaming("[answer][ref]\n\n> [ref]: /tmp/a.ts\n\ntail", {
        source: "",
        length: 0,
        document: null,
      });
      expect(streaming.fullDocument).toBe(true);
      expect(findLinks(streaming.tokens)[0]?.href).toBe("/tmp/a.ts");
    });
  });
});

describe("conversation tokens", () => {
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
        .map(([key, child]) => [
          key,
          key === "tokens" || key === "items" ? semantic(child) : child,
        ]),
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
    test("keeps the latest transient parse local and admits stable blocks to the shared cache", () => {
      const syntax = createConversationTokenEngine();
      const stream = () => ({ source: "", length: 0, document: null });
      const first = stream();
      const second = stream();
      const a = "A durable opening paragraph.\n\n";
      const tail = "A transient closing paragraph. ".repeat(12);
      const prepared = syntax.readStreaming(a + tail, first);
      const afterFirst = syntax.getMeasurements().parseCalls;
      const repeated = syntax.readStreaming(a + tail, first);
      expect(repeated.tokens.at(-1)).toBe(prepared.tokens.at(-1));
      expect(syntax.getMeasurements().parseCalls).toBe(afterFirst);
      const another = syntax.readStreaming(a + tail, second);
      expect(another.tokens[0]).toBe(prepared.tokens[0]);
      expect(another.tokens.at(-1)).not.toBe(prepared.tokens.at(-1));
      expect(syntax.getMeasurements().parseCalls).toBe(afterFirst + 1);
    });
    test("reuses short transient parses across streams without evicting stable syntax", () => {
      const syntax = createConversationTokenEngine();
      const stream = () => ({ source: "", length: 0, document: null });
      const stable = "The original stable paragraph.\n\n";
      const first = syntax.readStreaming(stable + "original tail", stream());
      for (let index = 0; index < 110; index += 1) {
        syntax.readStreaming("Transient #" + index, stream());
      }
      const second = syntax.readStreaming(stable + "Transient #109", stream());
      expect(second.tokens[0]).toBe(first.tokens[0]);
      const before = syntax.getMeasurements().parseCalls;
      const another = syntax.readStreaming(stable + "Transient #109", stream());
      expect(another.tokens.at(-1)).toBe(second.tokens.at(-1));
      expect(syntax.getMeasurements().parseCalls).toBe(before);
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
});
