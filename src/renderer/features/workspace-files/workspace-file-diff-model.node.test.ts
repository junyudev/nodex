import { describe, expect, test } from "vite-plus/test";
import {
  workspaceFileChangeNavigation,
  workspaceFileChangedSections,
} from "./workspace-file-change-blocks";
import {
  compareWorkspaceFileContents,
  WORKSPACE_FILE_COMPARISON_MAX_CHARACTERS,
} from "./workspace-file-editor-diff";
import {
  buildWorkspaceFileDraftLineMap,
  workspaceFileSavedLineNumber,
} from "./workspace-file-draft-line-map";

describe("workspace file change blocks", () => {
  function compare(oldContent: string, newContent: string) {
    const comparison = compareWorkspaceFileContents({ path: "file.txt", oldContent, newContent });
    if (comparison.status !== "ready") throw new Error(`comparison ${comparison.status}`);
    return comparison.diff;
  }

  describe("workspace file change blocks", () => {
    test("counts change blocks, follows the caret and disables instead of wrapping", () => {
      const sections = workspaceFileChangedSections(compare("a\nb\nc\nd\ne\n", "A\nb\nc\nd\nE\n"));
      expect(sections).toHaveLength(2);
      expect(workspaceFileChangeNavigation(sections, 0, 5)).toEqual({
        count: 2,
        activeIndex: 0,
        previousIndex: -1,
        nextIndex: 1,
      });
      expect(workspaceFileChangeNavigation(sections, 2, 5)).toEqual({
        count: 2,
        activeIndex: -1,
        previousIndex: 0,
        nextIndex: 1,
      });
      expect(workspaceFileChangeNavigation(sections, 4, 5)).toEqual({
        count: 2,
        activeIndex: 1,
        previousIndex: 0,
        nextIndex: -1,
      });
      const deletion = workspaceFileChangedSections(compare("keep\ndrop\n", "keep\n"));
      expect(workspaceFileChangeNavigation(deletion, 0, 1).activeIndex).toBe(0);
    });
  });
});

describe("workspace file draft line map", () => {
  const mapLines = (saved: string, draft: string) => {
    const ranges = buildWorkspaceFileDraftLineMap(saved, draft);
    return draft.split("\n").map((_, index) => workspaceFileSavedLineNumber(ranges, index + 1));
  };

  describe("draft line authorship", () => {
    test("maps unchanged lines across insertions, replacements and deletions", () => {
      expect(
        mapLines("first\nsecond\nthird\nfourth\nfifth", "inserted\nfirst\nreplaced\nthird\nfifth"),
      ).toEqual([null, 1, null, 3, 5]);
      expect(mapLines("a\nb\nc", "a\nc")).toEqual([1, 3]);
    });

    test("does not match whitespace edits or changed line endings", () => {
      expect(mapLines("one\ntwo\nthree", "one \ntwo\nthree")).toEqual([null, 2, 3]);
      expect(mapLines("one\r\ntwo\r\n", "one\ntwo\n")).toEqual([null, null, null]);
      expect(mapLines("one\ntwo\n", "one\ntwo")).toEqual([1, null]);
    });

    test("handles unchanged empty and terminal lines without inventing a match", () => {
      expect(mapLines("", "")).toEqual([1]);
      expect(mapLines("one\n", "one\n")).toEqual([1, 2]);
      expect(mapLines("", "new")).toEqual([null]);
      expect(mapLines("removed", "")).toEqual([null]);
      expect(workspaceFileSavedLineNumber(buildWorkspaceFileDraftLineMap("a", "a"), 2)).toBeNull();
      expect(workspaceFileSavedLineNumber([], 0)).toBeNull();
      expect(workspaceFileSavedLineNumber([], 1.5)).toBeNull();
    });

    test("enforces the UTF-16 character budget even for identical content", () => {
      const atLimit = "😀".repeat(131_072);
      expect(
        workspaceFileSavedLineNumber(buildWorkspaceFileDraftLineMap(atLimit, atLimit), 1),
      ).toBe(1);
      expect(buildWorkspaceFileDraftLineMap(atLimit + "a", atLimit + "a")).toBeNull();
      expect(buildWorkspaceFileDraftLineMap("a", atLimit + "a")).toBeNull();
      expect(buildWorkspaceFileDraftLineMap(atLimit + "a", "a")).toBeNull();
    });

    test("allows edit length 512 and suppresses all mapping beyond it", () => {
      const inserted = Array.from({ length: 512 }, (_, index) => `new ${index}\n`).join("");
      expect(
        workspaceFileSavedLineNumber(
          buildWorkspaceFileDraftLineMap("kept", inserted + "kept"),
          513,
        ),
      ).toBe(1);
      expect(buildWorkspaceFileDraftLineMap("kept", inserted + "extra\nkept")).toBeNull();
      expect(buildWorkspaceFileDraftLineMap(inserted + "extra\nkept", "kept")).toBeNull();
    });
  });
});

describe("workspace file editor diff", () => {
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
});
