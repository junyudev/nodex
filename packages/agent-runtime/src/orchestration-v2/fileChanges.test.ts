import { describe, expect, it } from "vite-plus/test";
import {
  countFileChangeLines,
  fileChangeDetail,
  fileChangeItemFields,
  fileChangesFromPatch,
  unifiedHunksText,
} from "@t3tools/shared/fileChanges";

describe("file change line counts", () => {
  it("counts created and deleted files by their content lines", () => {
    expect(countFileChangeLines("add", "one\ntwo\n")).toEqual({ additions: 2, deletions: 0 });
    expect(countFileChangeLines("add", "one\ntwo")).toEqual({ additions: 2, deletions: 0 });
    expect(countFileChangeLines("add", "")).toEqual({ additions: 0, deletions: 0 });
    expect(countFileChangeLines("delete", "a\r\nb\r\nc\r\n")).toEqual({
      additions: 0,
      deletions: 3,
    });
  });

  it("counts only lines inside hunks, including removed lines that look like headers", () => {
    const diff = [
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -1,3 +1,3 @@",
      " title",
      "---- old rule",
      "+++++ new rule",
      " end",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    expect(countFileChangeLines("modify", diff)).toEqual({ additions: 1, deletions: 1 });
  });

  it("reads hunks without counts as single-line ranges", () => {
    expect(countFileChangeLines("modify", "@@ -4 +4 @@\n-old\n+new\n")).toEqual({
      additions: 1,
      deletions: 1,
    });
  });
});

describe("fileChangeDetail", () => {
  it("records the measured counts with the diff and nothing for a blank path", () => {
    expect(
      fileChangeDetail({
        operation: "modify",
        path: " src/app.ts ",
        diff: "@@ -1,2 +1,2 @@\n-a\n+b\n c\n",
      }),
    ).toEqual({
      operation: "modify",
      path: "src/app.ts",
      diff: "@@ -1,2 +1,2 @@\n-a\n+b\n c\n",
      additions: 1,
      deletions: 1,
    });
    expect(fileChangeDetail({ operation: "modify", path: "src/app.ts" })).toEqual({
      operation: "modify",
      path: "src/app.ts",
    });
    expect(fileChangeDetail({ operation: "modify", path: "  " })).toBeNull();
  });

  it("summarizes an item from all of its files", () => {
    const changes = [
      fileChangeDetail({ operation: "add", path: "new.ts", diff: "a\nb\n" })!,
      fileChangeDetail({ operation: "modify", path: "old.ts", diff: "@@ -1 +1 @@\n-x\n+y\n" })!,
      fileChangeDetail({ operation: "modify", path: "binary.png" })!,
    ];
    expect(fileChangeItemFields(changes)).toEqual({
      fileName: "new.ts",
      changes,
      additions: 3,
      deletions: 1,
    });
    expect(fileChangeItemFields([])).toBeUndefined();
  });

  it("formats structured hunks as unified hunks", () => {
    expect(
      unifiedHunksText([
        { oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: [" keep", "-old", "+new"] },
      ]),
    ).toBe("@@ -3,2 +3,2 @@\n keep\n-old\n+new\n");
  });
});

describe("fileChangesFromPatch", () => {
  it("splits a git patch into one change per file with its operation", () => {
    const patch = [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,2 @@",
      "+export const a = 1;",
      "+export const b = 2;",
      "diff --git a/src/edit.ts b/src/edit.ts",
      "--- a/src/edit.ts",
      "+++ b/src/edit.ts",
      "@@ -1,3 +1,3 @@",
      " first",
      "-second",
      "+SECOND",
      " third",
      "diff --git a/src/gone.ts b/src/gone.ts",
      "deleted file mode 100644",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "\\ No newline at end of file",
      "diff --git a/src/before.ts b/src/after.ts",
      "similarity index 90%",
      "rename from src/before.ts",
      "rename to src/after.ts",
      "--- a/src/before.ts",
      "+++ b/src/after.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "",
    ].join("\n");
    expect(fileChangesFromPatch(patch)).toEqual([
      {
        operation: "add",
        path: "src/new.ts",
        diff: "export const a = 1;\nexport const b = 2;\n",
        additions: 2,
        deletions: 0,
      },
      {
        operation: "modify",
        path: "src/edit.ts",
        diff: "@@ -1,3 +1,3 @@\n first\n-second\n+SECOND\n third\n",
        additions: 1,
        deletions: 1,
      },
      { operation: "delete", path: "src/gone.ts", diff: "bye", additions: 0, deletions: 1 },
      {
        operation: "move",
        path: "src/after.ts",
        oldPath: "src/before.ts",
        diff: "@@ -1 +1 @@\n-x\n+y\n",
        additions: 1,
        deletions: 1,
      },
    ]);
  });

  it("reads plain unified headers without treating a path's leading directory as a prefix", () => {
    const patch = [
      "Index: /work/a/file.ts",
      "===================================================================",
      "--- /work/a/file.ts",
      "+++ /work/a/file.ts",
      "@@ -1,2 +1,2 @@",
      "--- removed rule",
      "+++ added rule",
      " kept",
      "",
    ].join("\n");
    expect(fileChangesFromPatch(patch)).toEqual([
      {
        operation: "modify",
        path: "/work/a/file.ts",
        diff: "@@ -1,2 +1,2 @@\n--- removed rule\n+++ added rule\n kept\n",
        additions: 1,
        deletions: 1,
      },
    ]);
  });

  it("assigns headerless hunks to the reported path and keeps a binary file without a diff", () => {
    expect(fileChangesFromPatch("@@ -1 +1 @@\n-a\n+b\n", "/work/x.ts")).toEqual([
      {
        operation: "modify",
        path: "/work/x.ts",
        diff: "@@ -1 +1 @@\n-a\n+b\n",
        additions: 1,
        deletions: 1,
      },
    ]);
    expect(fileChangesFromPatch("@@ -1 +1 @@\n-a\n+b\n")).toEqual([]);
    expect(
      fileChangesFromPatch(
        "diff --git a/img.png b/img.png\nindex 1..2 100644\nBinary files a/img.png and b/img.png differ\n",
      ),
    ).toEqual([{ operation: "modify", path: "img.png" }]);
  });

  it("ignores output text that only resembles a patch", () => {
    expect(fileChangesFromPatch("Edited file\n--- Summary ---\nDone\n", "/w/x.ts")).toEqual([]);
    expect(fileChangesFromPatch("--- a/x.ts\n@@ -1 +1 @@\n-a\n+b\n", "/w/x.ts")).toEqual([]);
  });

  it("reads git prefixes from either header and equal names that contain ' b/'", () => {
    expect(fileChangesFromPatch("--- /dev/null\n+++ b/src/x.ts\n@@ -0,0 +1 @@\n+x\n")).toEqual([
      { operation: "add", path: "src/x.ts", diff: "x\n", additions: 1, deletions: 0 },
    ]);
    expect(
      fileChangesFromPatch(
        "diff --git a/my dir b/f.png b/my dir b/f.png\nBinary files a/my dir b/f.png and b/my dir b/f.png differ\n",
      ),
    ).toEqual([{ operation: "modify", path: "my dir b/f.png" }]);
  });

  it("unquotes git names that carry escaped characters", () => {
    const patch = [
      'diff --git "a/tab\\tname.txt" "b/tab\\tname.txt"',
      '--- "a/tab\\tname.txt"',
      '+++ "b/tab\\tname.txt"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    expect(fileChangesFromPatch(patch).map((change) => change.path)).toEqual(["tab\tname.txt"]);
  });
});
