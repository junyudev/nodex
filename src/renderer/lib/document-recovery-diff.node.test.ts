import { expect, test } from "vite-plus/test";
import {
  readMarkdown,
  writeMarkdown,
  type MarkdownBlock,
  type MarkdownInline,
} from "../../shared/nodex-markdown";
import {
  diffRecoveryDocuments,
  mergeInlineEdits,
  recoveryDiffHasChanges,
} from "./document-recovery-diff";

const version = (markdown: string, title = "Title") => ({ title, markdown });
const text = (value: string, styles?: MarkdownInline["styles"]): MarkdownInline => ({
  type: "text",
  text: value,
  ...(styles ? { styles } : {}),
});
const blockText = (block: MarkdownBlock): string =>
  (block.content as readonly MarkdownInline[]).map((inline) => inline.text ?? "").join("");
const shape = (markdown: { before: string; after: string }) =>
  diffRecoveryDocuments(version(markdown.before), version(markdown.after))!.rows.map((row) => [
    row.kind,
    row.blocks.map(blockText),
  ]);

test("identical documents have nothing to show", () => {
  const diff = diffRecoveryDocuments(version("One\n\nTwo"), version("One\n\nTwo"))!;
  expect(diff.rows).toEqual([]);
  expect(recoveryDiffHasChanges(diff)).toBe(false);
});

test("a blank paragraph is spacing, not a change", () => {
  const blank = { type: "paragraph", content: [] };
  const withBlank = writeMarkdown([
    ...readMarkdown("One\n\nTwo").slice(0, 1),
    blank,
    ...readMarkdown("Two"),
  ]);
  const diff = diffRecoveryDocuments(version("One\n\nTwo"), version(withBlank))!;
  expect(readMarkdown(withBlank).length).toBeGreaterThan(2);
  expect(recoveryDiffHasChanges(diff)).toBe(false);
});

test("a title change alone still counts as a change", () => {
  const diff = diffRecoveryDocuments(version("One", "Before"), version("One", "After"))!;
  expect(diff.title).toEqual({ before: "Before", after: "After" });
  expect(diff.rows).toEqual([]);
  expect(recoveryDiffHasChanges(diff)).toBe(true);
});

test("unchanged Blocks collapse beyond one line of context around each change", () => {
  const unchanged = ["A", "B", "C", "D", "E", "F"];
  const before = unchanged.join("\n\n");
  const after = [...unchanged, "G", ...unchanged.map((value) => `${value}2`)].join("\n\n");
  const prefixAndAddition = shape({
    before: `${before}\n\nA2\n\nB2\n\nC2\n\nD2\n\nE2\n\nF2`,
    after,
  });
  expect(prefixAndAddition).toEqual([
    ["unchanged", ["A", "B", "C", "D", "E"]],
    ["context", ["F"]],
    ["added", ["G"]],
    ["context", ["A2"]],
    ["unchanged", ["B2", "C2", "D2", "E2", "F2"]],
  ]);
});

test("a run too short to be worth collapsing stays visible", () => {
  expect(shape({ before: "A\n\nB\n\nC", after: "New\n\nA\n\nB\n\nC\n\nLast" })).toEqual([
    ["added", ["New"]],
    ["context", ["A", "B", "C"]],
    ["added", ["Last"]],
  ]);
});

test("a Block edited in place carries its word changes as marks, including in Chinese", () => {
  const diff = diffRecoveryDocuments(
    version("该有圆角的时候还是得有圆角，比如那个按钮。"),
    version("该有圆角的时候还是得有圆角，比如那个 inline code。"),
  )!;
  expect([diff.added, diff.removed, diff.edited]).toEqual([0, 0, 1]);
  const content = diff.rows[0]!.blocks[0]!.content as readonly MarkdownInline[];
  expect(content.map((inline) => inline.text ?? "").join("")).toContain("该有圆角");
  expect(
    content
      .filter((inline) => inline.styles?.backgroundColor === "red")
      .map((inline) => inline.text),
  ).toEqual(["按钮"]);
  expect(
    content
      .filter((inline) => inline.styles?.backgroundColor === "green")
      .map((inline) => inline.text)
      .join(""),
  ).toBe(" inline code");
});

test("unrelated replacements stay separate instead of producing unreadable marks", () => {
  const diff = diffRecoveryDocuments(
    version("The quick brown fox jumps over"),
    version("Completely different words appear here"),
  )!;
  expect([diff.added, diff.removed, diff.edited]).toEqual([1, 1, 0]);
});

test("a Block whose kind changed is a replacement, not an inline edit", () => {
  const diff = diffRecoveryDocuments(version("Same words here"), version("# Same words here"))!;
  expect([diff.added, diff.removed, diff.edited]).toEqual([1, 1, 0]);
});

test("appending to a very long paragraph stays an inline edit", () => {
  const long = "Retained offline content. ".repeat(3000).trim();
  const merged = mergeInlineEdits([text(long)], [text(`${long} Added.`)])!;
  expect(merged.at(-1)).toEqual(text(" Added.", { backgroundColor: "green" }));
  expect(merged.at(0)?.text).toBe(long);
});

test("styled runs and inline objects survive the merge", () => {
  const mention: MarkdownInline = { type: "pageMention", props: { pageId: "page" } };
  const merged = mergeInlineEdits(
    [text("Keep ", { bold: true }), mention, text(" this old tail of words")],
    [text("Keep ", { bold: true }), mention, text(" this new tail of words")],
  )!;
  expect(merged[0]).toEqual(text("Keep ", { bold: true }));
  expect(merged[1]).toEqual(mention);
  expect(merged.filter((inline) => inline.styles?.strike).map((inline) => inline.text)).toEqual([
    "old",
  ]);
});
