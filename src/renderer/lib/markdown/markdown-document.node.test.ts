import { describe, expect, test } from "vite-plus/test";
import { defaultRemarkPlugins, defaultRehypePlugins } from "streamdown";
import type { Element, RootContent } from "hast";
import { createMarkdownDocumentOwner, MARKDOWN_FADE_TAG } from "./markdown-document";
import { createMarkdownSyntaxEngine, type MarkdownSyntaxPolicy } from "./markdown-syntax";

const policy: MarkdownSyntaxPolicy = {
  family: false,
  normalizeLists: true,
  repairIncomplete: true,
  blockLocal: true,
  remarkPlugins: Object.values(defaultRemarkPlugins),
  rehypePlugins: Object.values(defaultRehypePlugins),
};
function collect(node: RootContent, tag: string): Element[] {
  if (node.type !== "element") return [];
  return [
    ...(node.tagName === tag ? [node] : []),
    ...node.children.flatMap((child) => collect(child, tag)),
  ];
}

describe("typed mounted Markdown document", () => {
  test("prefix/terminal keep one segment key domain while prepared renders leave committed state unchanged", () => {
    const owner = createMarkdownDocumentOwner(null, createMarkdownSyntaxEngine());
    const input = {
      source: "Stable paragraph\n\ntail",
      sourceIdentity: "native-a",
      streaming: true,
      animate: true,
      policy,
    };
    const first = owner.prepare(input);
    owner.commit(first);
    const growth = owner.prepare({ ...input, source: `${input.source}\n\nnext` });
    const firstWord = first.html.children.flatMap((node) => collect(node, MARKDOWN_FADE_TAG))[0]!;
    const growthWord = growth.html.children.flatMap((node) => collect(node, MARKDOWN_FADE_TAG))[0]!;
    expect(growthWord).toBe(firstWord);
    expect(growth.keys.get(growthWord)).toBe(first.keys.get(firstWord));
    const discarded = owner.prepare({ ...input, source: "entirely different" });
    expect(discarded.segments!.nextId).toBeGreaterThan(first.segments!.nextId);
    owner.commit(growth);
    const terminal = owner.prepare({
      ...input,
      source: `${input.source}\n\nnext`,
      streaming: false,
      animate: false,
      policy: { ...policy, repairIncomplete: false },
    });
    expect(terminal.segments).toBeNull();
    expect(terminal.html.children.flatMap((node) => collect(node, MARKDOWN_FADE_TAG))).toHaveLength(
      0,
    );
    owner.commit(terminal);
    expect(
      growth.segments!.segments.every((value) => owner.getTimeline().isSettled(value.key)),
    ).toBe(true);
  });
  test("new native source identity gets independent segment IDs and excludes code/math from prose segmentation", () => {
    const owner = createMarkdownDocumentOwner(null, createMarkdownSyntaxEngine());
    const base = {
      sourceIdentity: "a",
      source: "words\n\n```text\nnot animated\n```",
      streaming: false,
      animate: false,
      policy,
    };
    const first = owner.prepare(base);
    owner.commit(first);
    expect(first.segments).toBeNull();
    expect(first.html.children.flatMap((node) => collect(node, "code"))[0]?.children).toEqual([
      { type: "text", value: "not animated\n" },
    ]);
    const second = owner.prepare({
      ...base,
      sourceIdentity: "b",
      source: "new words",
      animate: true,
    });
    expect(second.segments!.segments[0]?.key).toBe("fade-segment-0");
  });
  test("a retired native document cannot settle a replacement with the same segment key", () => {
    const owner = createMarkdownDocumentOwner(null, createMarkdownSyntaxEngine());
    const base = {
      sourceIdentity: "first",
      source: "same text",
      streaming: true,
      animate: true,
      policy,
    };
    const first = owner.prepare(base);
    owner.commit(first);
    const retired = owner.getTimeline();
    const second = owner.prepare({ ...base, sourceIdentity: "replacement" });
    owner.commit(second);
    expect(second.segments!.segments[0]?.key).toBe(first.segments!.segments[0]?.key);
    retired.settle(second.segments!.segments[0]!.key, true);
    expect(owner.getTimeline().isSettled(second.segments!.segments[0]!.key)).toBe(false);
    expect(retired.attach({}, "fade-segment-0", 0)).toBeNull();
  });
});
