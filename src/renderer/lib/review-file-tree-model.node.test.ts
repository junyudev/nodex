import { describe, expect, test } from "vite-plus/test";
import { parsePatchFiles } from "@pierre/diffs";
import { reviewFileStatusFromDiff, reviewFileTreeGitStatus } from "./review-file-tree-model";
import { buildFileTreePaths, buildFileTreeExpandedPaths } from "./file-tree-paths";

describe("file tree projection", () => {
  test("retains real identities through duplicate labels and file/directory collisions", () => {
    const entries = [
      { path: "/b/name", displayPath: "src/name" },
      { path: "/a/name", displayPath: "src/name" },
      { path: "/a/child", displayPath: "src/name/child.ts" },
      { path: "/a/invisible", displayPath: "src/name\u2063" },
    ];
    const mapped = buildFileTreePaths(entries);
    expect(new Set(mapped.map((item) => item.treePath)).size).toBe(entries.length);
    expect(mapped.map((item) => item.entry)).toEqual(entries);
    expect(mapped[1]?.treePath).toBe("src/name\u2063\u2063");
    expect(mapped[0]?.treePath).toBe("src/name\u2063\u2063\u2063");
    expect(
      buildFileTreePaths([...entries].reverse())
        .map((item) => item.treePath)
        .reverse(),
    ).toEqual(mapped.map((item) => item.treePath));
  });
  test("expands all unique ancestor directories", () => {
    expect(buildFileTreeExpandedPaths(["src/a/one.ts", "src/a/two.ts", "src/b/file.ts"])).toEqual([
      "src",
      "src/a",
      "src/b",
    ]);
  });
  test("derives turn change status from parsed patches without a worktree snapshot", () => {
    const files = parsePatchFiles(
      [
        "diff --git a/added.ts b/added.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/added.ts",
        "@@ -0,0 +1 @@",
        "+added",
        "diff --git a/deleted.ts b/deleted.ts",
        "deleted file mode 100644",
        "--- a/deleted.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-deleted",
        "",
      ].join("\n"),
    ).flatMap((patch) => patch.files);
    expect(files.map((file) => reviewFileStatusFromDiff(file.type))).toEqual(["added", "deleted"]);
    expect(reviewFileStatusFromDiff("rename-changed")).toBe("renamed");
    expect(reviewFileStatusFromDiff("change")).toBe("modified");
  });
  test("preserves distinct rename and untracked states while mapping Git-only variants", () => {
    expect(
      [
        "added",
        "deleted",
        "modified",
        "renamed",
        "untracked",
        "copied",
        "type-changed",
        "unmerged",
      ].map((status) =>
        reviewFileTreeGitStatus(status as Parameters<typeof reviewFileTreeGitStatus>[0]),
      ),
    ).toEqual([
      "added",
      "deleted",
      "modified",
      "renamed",
      "untracked",
      "added",
      "modified",
      "modified",
    ]);
  });
});
