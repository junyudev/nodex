import { expect, test } from "vite-plus/test";
import { readLocatedMarkdown, type MarkdownBlock } from "../nodex-markdown";
import { applySkillBodyEdit, parseSkillSource, setSkillFrontmatter } from "./index";

const header = [
  "---",
  "name: 'review-diffs' # identity",
  'description: "Review changes in café 🔍."',
  "metadata:",
  "  version: '1.0'",
  "---",
];
const body = [
  "<!-- Maintainer note -->",
  "",
  "Review diffs",
  "============",
  "",
  "Review 🧪 changes with",
  "the [repository guide](references/review.md).",
  "",
  "* Run checks  ",
  "  + Inspect output",
  "* [X] Summarize risks",
  "",
  "~~~~ts title=example.ts",
  "const marker = ':::toggle';",
  "~~~~   ",
  "",
  "| Severity | Meaning |",
  "| :--- | ---: |",
  "| high | Must fix |",
  "",
  "[legacy]: https://example.com 'Preserve unused reference'",
  "",
];
const realistic = "\uFEFF" + [...header, ...body].join("\r\n");
const edit = (block: MarkdownBlock, text: string): MarkdownBlock => ({
  ...block,
  content: [{ type: "text", text, styles: {} }],
});

test("located reading exposes JS slices after BMP and supplementary characters with mixed endings", () => {
  const text = "🧪 Ångström\r\n\r\n* 中文\r  + café\n* Fin";
  const located = readLocatedMarkdown(text, "document");
  expect(
    located.locations.map((spans) => spans.map(({ start, end }) => text.slice(start, end))),
  ).toEqual([["🧪 Ångström\r\n"], ["* 中文\r"], ["  + café\n"], ["* Fin"]]);
});

test("edits one paragraph and preserves all other bytes including BOM, CRLF, and gaps", () => {
  const source = parseSkillSource(realistic);
  expect(source.rich).toEqual({ editable: true });
  expect(source.blocks.map(({ type }) => type)).toEqual([
    "heading",
    "paragraph",
    "bulletListItem",
    "checkListItem",
    "codeBlock",
    "table",
  ]);
  expect(source.frontmatter.name).toEqual({ value: "review-diffs", patchable: true });
  const blocks = source.blocks.map((block, index) =>
    index === 1 ? edit(block, "Review the patch.") : block,
  );
  expect(applySkillBodyEdit(source, blocks)).toEqual({
    ok: true,
    text: realistic.replace(
      "Review 🧪 changes with\r\nthe [repository guide](references/review.md).",
      "Review the patch.",
    ),
  });
  expect(applySkillBodyEdit(source, source.blocks)).toEqual({ ok: true, text: realistic });
});

test("edits nested list text without rewriting parent, sibling, or task markers", () => {
  const source = parseSkillSource(realistic);
  const blocks = source.blocks.map((block, index) =>
    index === 2 ? { ...block, children: [edit(block.children[0]!, "Inspect failures")] } : block,
  );
  expect(applySkillBodyEdit(source, blocks)).toEqual({
    ok: true,
    text: realistic.replace("Inspect output", "Inspect failures"),
  });
});

test("updates one ordered item and keeps the original delimiter and neighboring numerals", () => {
  const text = [...header, "7) Start  ", "9) Inspect", "42) Finish", ""].join("\n");
  const source = parseSkillSource(text);
  expect(
    applySkillBodyEdit(
      source,
      source.blocks.map((block, index) => (index === 1 ? edit(block, "Inspect failures") : block)),
    ),
  ).toEqual({ ok: true, text: text.replace("9) Inspect", "9) Inspect failures") });
});

test("retains the fence and complete info string during a code-only edit", () => {
  const source = parseSkillSource(realistic);
  const blocks = source.blocks.map((block) =>
    block.type === "codeBlock" ? edit(block, "const marker = 'hello';") : block,
  );
  expect(applySkillBodyEdit(source, blocks)).toEqual({
    ok: true,
    text: realistic.replace("const marker = ':::toggle';", "const marker = 'hello';"),
  });
});

test("edits a table without reserializing neighboring blocks", () => {
  const source = parseSkillSource(realistic);
  const table = source.blocks.at(-1)!;
  const content = JSON.parse(JSON.stringify(table.content).replace("Must fix", "Investigate"));
  const result = applySkillBodyEdit(source, [...source.blocks.slice(0, -1), { ...table, content }]);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const unit = source.units.at(-1)!;
  expect(result.text.startsWith(realistic.slice(0, unit.start))).toBe(true);
  expect(result.text.endsWith(realistic.slice(unit.end))).toBe(true);
  expect(result.text).toContain("Investigate");
});

test("inserts, deletes, and reorders top-level blocks while reusing surviving slices", () => {
  const text = [
    ...header,
    "Title",
    "=====",
    "",
    "Keep me\t ",
    "",
    "Delete this",
    "",
    "Move this",
    "",
  ].join("\n");
  const source = parseSkillSource(text);
  const [title, keep, , move] = source.blocks;
  const inserted = edit({ id: "new", type: "paragraph" }, "New block");
  const result = applySkillBodyEdit(source, [title!, move!, keep!, inserted]);
  expect(result).toEqual({
    ok: true,
    text: [
      ...header,
      "Title",
      "=====",
      "",
      "",
      "Move this",
      "",
      "Keep me\t ",
      "",
      "New block",
      "",
    ].join("\n"),
  });
});

test("refuses a move across an opaque boundary and a change to nested structure", () => {
  const source = parseSkillSource(
    "First\n\n<!-- stays between -->\n\nSecond\n\n* Parent\n  + Child",
  );
  const [first, second, list] = source.blocks;
  expect(applySkillBodyEdit(source, [second!, first!, list!])).toMatchObject({
    ok: false,
    reason: expect.stringMatching(/preserved Markdown/),
  });
  expect(applySkillBodyEdit(source, [first!, second!, { ...list!, children: [] }])).toMatchObject({
    ok: false,
    reason: expect.stringMatching(/nested block/),
  });
});

test("patches only existing YAML scalar ranges", () => {
  const source = parseSkillSource(realistic);
  const result = setSkillFrontmatter(source, {
    name: "audit-diffs",
    description: 'Review: "quickly"\nthen report.',
  });
  expect(result).toEqual({
    ok: true,
    text: realistic
      .replace("'review-diffs'", '"audit-diffs"')
      .replace('"Review changes in café 🔍."', '"Review: \\"quickly\\"\\nthen report."'),
  });
  expect(setSkillFrontmatter(source, { name: "review-diffs" })).toEqual({
    ok: true,
    text: realistic,
  });
});

test("a multiline description can remain in the file during body editing", () => {
  const text =
    "---\nname: shell-check\ndescription: >-\n  Find shell issues.\n---\n\nRead scripts.\n";
  const source = parseSkillSource(text);
  expect(source.frontmatter.description).toEqual({ value: "Find shell issues.", patchable: false });
  expect(setSkillFrontmatter(source, { description: "New" })).toMatchObject({
    ok: false,
    reason: expect.any(String),
  });
  expect(applySkillBodyEdit(source, [edit(source.blocks[0]!, "Read scripts first.")])).toEqual({
    ok: true,
    text: text.replace("Read scripts.", "Read scripts first."),
  });
});

test.each([
  "---\nname: first\nname: second\n---\n",
  "---\nname: &name demo\ndescription: *name\n---\n",
  "---\n{name: demo, description: 'Review changes'}\n---\n",
])("refuses unpatchable YAML values", (text) => {
  expect(setSkillFrontmatter(parseSkillSource(text), { name: "new" })).toMatchObject({
    ok: false,
    reason: expect.any(String),
  });
});

test.each([
  ["Raw HTML", "<details>\n<summary>Read this</summary>\n</details>", /HTML/],
  ["inline comment", "Before <!-- retained note --> after", /comment/],
  ["nested comment", "* Before\n\n  <!-- retained note -->\n\n  After", /comment/],
  ["reference link", "See [the guide][guide].\n\n[guide]: references/guide.md", /reference-style/],
  ["link title", 'See [the guide](guide.md "Extra detail").', /link title/],
  ["H5", "##### Low heading", /level 5 or 6/],
  ["Nodex container", ":::toggle[Details]\n  More\n:::", /extension/],
  ["Nodex Page mention", "Read <nodex://pages/x>.", /cannot represent/],
  ["Nodex inline", "Read :span[important]{bold} instructions", /extension/],
  ["malformed YAML", "---\nname: [unfinished\n---\n# Use it", /frontmatter/],
  ["unclosed YAML", "---\nname: unfinished\n# Use it", /closing delimiter/],
])("refuses %s with an actionable reason", (_case, text, reason) => {
  const source = parseSkillSource(text);
  expect(source.rich).toEqual({ editable: false, reason: expect.stringMatching(reason) });
  expect(applySkillBodyEdit(source, source.blocks)).toEqual({
    ok: false,
    reason: expect.stringMatching(reason),
  });
});

test("an empty body round-trips with a caret and can receive its first block", () => {
  const text = [...header, "", ""].join("\n");
  const source = parseSkillSource(text);
  expect(applySkillBodyEdit(source, source.blocks)).toEqual({ ok: true, text });
  expect(applySkillBodyEdit(source, [edit(source.blocks[0]!, "Start here.")])).toEqual({
    ok: true,
    text: text + "Start here.\n",
  });
});
