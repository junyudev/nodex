import { expect, it } from "vite-plus/test";
import { searchableMessageSegments } from "./threadFindText.ts";

const assistantSegments = (text: string, cwd?: string) =>
  searchableMessageSegments({ role: "assistant", text, streaming: false }, cwd);

it("searches displayed prose and file-chip labels without hidden paths", () => {
  expect(
    assistantSegments("[important description](/tmp/actual.ts). `/tmp/inline-example.ts:42`"),
  ).toEqual(["important description actual.ts. inline-example.ts · L42"]);
  expect(assistantSegments("[label](src/main.ts#L3C2)", "/workspace/repo")).toEqual([
    "label main.ts · L3:C2",
  ]);
  expect(assistantSegments("[label](src/main.ts#L3C2)")).toEqual(["label"]);
});

it("includes the same parent suffixes for duplicate filenames as the renderer", () => {
  expect(
    assistantSegments(
      "[first](src/main.ts) and `/workspace/repo/tests/main.ts:2`",
      "/workspace/repo",
    ),
  ).toEqual(["first main.ts · repo/src and main.ts · repo/tests · L2"]);
  expect(
    assistantSegments(
      "[first](src/main.ts) and `/workspace/repo/src/main.ts:2`",
      "/workspace/repo",
    ),
  ).toEqual(["first main.ts and main.ts · L2"]);
});

it("keeps fence paths literal and indexes file-chip labels in user messages", () => {
  expect(assistantSegments("```text\n/tmp/file.ts:42\n```")).toEqual(["/tmp/file.ts:42\n"]);
  expect(
    searchableMessageSegments({ role: "user", text: "`/tmp/file.ts:42`", streaming: false }),
  ).toEqual(["file.ts · L42"]);
});

it("indexes nested disclosure summaries and bodies in rendered order", () => {
  expect(
    assistantSegments(
      "<details><summary>Outer</summary><p>first</p><details><summary>Inner</summary><p>second</p></details></details>",
    ),
  ).toEqual(["Outer", "first", "Inner", "second"]);
});

it("uses Insight line breaks without splitting ordinary assistant prose", () => {
  expect(assistantSegments("★ Insight ─────\nfirst line\nsecond line")).toEqual([
    "★ Insight ─────",
    " first line",
    " second line",
  ]);
  expect(assistantSegments("first line\nsecond line")).toEqual(["first line second line"]);
});

it("indexes skill labels in prose but leaves links and code literal", () => {
  expect(
    searchableMessageSegments(
      {
        role: "assistant",
        streaming: false,
        text: "Use $test-demo-app now.\n\n`$test-demo-app`\n\n[$test-demo-app](https://example.com)",
      },
      undefined,
      [{ name: "test-demo-app", displayName: "Nodex App Testing" }],
    ),
  ).toEqual(["Use Nodex App Testing now.", "$test-demo-app", "$test-demo-app"]);
});

