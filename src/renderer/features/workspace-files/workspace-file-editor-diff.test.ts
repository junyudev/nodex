import { describe, expect, test } from "vite-plus/test";
import { workspaceFileChangedSections } from "./workspace-file-change-blocks";
import {
  WORKSPACE_FILE_COMPARISON_MAX_CHARACTERS,
  compareWorkspaceFileContents,
} from "./workspace-file-editor-diff";

function readyDiff(input: Parameters<typeof compareWorkspaceFileContents>[0]) {
  const comparison = compareWorkspaceFileContents(input);
  if (comparison.status !== "ready") throw new Error(`comparison ${comparison.status}`);
  return comparison.diff;
}

describe("editable diff documents", () => {
  test.each([
    { content: "", missingFinalNewline: false },
    { content: "first\nsecond", missingFinalNewline: true },
    { content: "first\r\nsecond\r\n", missingFinalNewline: false },
  ])("keeps unchanged text mountable: $content", ({ content, missingFinalNewline }) => {
    const diff = readyDiff({ path: "example.txt", oldContent: content, newContent: content });
    expect(diff.hunks).toHaveLength(1);
    expect(diff.additionLines.join("")).toBe(content);
    expect(diff.deletionLines.join("")).toBe(content);
    expect(diff.unifiedLineCount).toBeGreaterThan(0);
    expect(workspaceFileChangedSections(diff)).toEqual([]);
    expect(diff.hunks[0]).toMatchObject({
      noEOFCRAdditions: missingFinalNewline,
      noEOFCRDeletions: missingFinalNewline,
    });
  });

  test("retains canonical changed blocks and rename paths", () => {
    const diff = readyDiff({
      path: "new.txt",
      oldPath: "old.txt",
      oldContent: "a\nb\nc",
      newContent: "a\nnew\nc",
    });
    expect(diff.name).toBe("new.txt");
    expect(diff.prevName).toBe("old.txt");
    expect(workspaceFileChangedSections(diff)).toEqual([
      { type: "change", additions: 1, deletions: 1, additionLineIndex: 1, deletionLineIndex: 1 },
    ]);
  });
});

describe("comparison limits", () => {
  test("does not compare a side longer than the limit", () => {
    const large = "x".repeat(WORKSPACE_FILE_COMPARISON_MAX_CHARACTERS + 1);
    expect(
      compareWorkspaceFileContents({ path: "a.txt", oldContent: "x", newContent: large }),
    ).toEqual({ status: "too-large" });
    expect(
      compareWorkspaceFileContents({ path: "a.txt", oldContent: large, newContent: "x" }),
    ).toEqual({ status: "too-large" });
  });

  test("gives up on a diff that outlasts its time budget", () => {
    // Every line differs, so line diffing cannot finish within the budget.
    const lines = (word: string) =>
      Array.from({ length: 20_000 }, (_, index) => `${word} ${index}`).join("\n");
    expect(
      compareWorkspaceFileContents(
        { path: "a.txt", oldContent: lines("before"), newContent: lines("after") },
        1,
      ),
    ).toEqual({ status: "too-complex" });
  });

  test("still compares a large file with a small change within the default budget", () => {
    const base = Array.from({ length: 20_000 }, (_, index) => `line ${index}`).join("\n");
    const diff = readyDiff({
      path: "a.txt",
      oldContent: base,
      newContent: base.replace("line 10000", "changed"),
    });
    expect(workspaceFileChangedSections(diff)).toHaveLength(1);
  });
});
