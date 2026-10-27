import { describe, expect, test } from "vite-plus/test";
import {
  buildWorkspaceFileChangesTreeModel,
  resolveWorkspaceFileChangesTreePath,
} from "./workspace-file-changes-tree-model";

describe("workspace changes tree", () => {
  test("keeps changed and browse identities distinct, including deleted files and section-named folders", () => {
    const model = buildWorkspaceFileChangesTreeModel({
      changedFiles: [
        { path: "src/deleted.ts", status: "deleted" },
        { path: "All files/a.ts", status: "modified" },
      ],
      browsePaths: [
        { path: "All files/a.ts", kind: "file" },
        { path: "empty", kind: "directory" },
      ],
      expandedPaths: ["", "All files"],
    });
    expect(model.sectioned).toBe(true);
    expect(model.paths.indexOf("Changed files/")).toBeLessThan(model.paths.indexOf("All files/"));
    expect(
      resolveWorkspaceFileChangesTreePath(model, "Changed files/src/deleted.ts"),
    ).toMatchObject({ section: "changed", relativePath: "src/deleted.ts", kind: "file" });
    expect(resolveWorkspaceFileChangesTreePath(model, "All files/All files/a.ts")).toMatchObject({
      section: "all",
      relativePath: "All files/a.ts",
    });
    expect(resolveWorkspaceFileChangesTreePath(model, "All files")).toMatchObject({
      relativePath: "",
      kind: "directory",
    });
    expect(resolveWorkspaceFileChangesTreePath(model, "missing.ts")).toBeNull();
    expect(model.defaultExpandedPaths).toEqual([
      "Changed files",
      "All files",
      "Changed files/src",
      "Changed files/All files",
      "All files/All files",
    ]);
    expect(model.paths).toContain("All files/empty/");
  });

  test("decorates comparison changes only, with added/deleted/modified categories", () => {
    const statuses = [
      "added",
      "untracked",
      "copied",
      "deleted",
      "modified",
      "renamed",
      "type-changed",
      "unmerged",
    ] as const;
    const model = buildWorkspaceFileChangesTreeModel({
      changedFiles: statuses.map((status) => ({ path: `${status}.ts`, status })),
      browsePaths: statuses.map((status) => ({ path: `${status}.ts`, kind: "file" })),
    });
    expect(model.gitStatus.map(({ status }) => status)).toEqual([
      "added",
      "added",
      "added",
      "deleted",
      "modified",
      "modified",
      "modified",
      "modified",
    ]);
    expect(model.decorationsByPath.get("Changed files/renamed.ts")).toBe("modified");
    expect(model.decorationsByPath.has("All files/renamed.ts")).toBe(false);
  });

  test("filters changed files with the shared path matcher while retaining section roots on zero matches", () => {
    const input = {
      changedFiles: [
        { path: "src/useWorkspace.ts", status: "modified" as const },
        { path: "other.ts", status: "deleted" as const },
      ],
      browsePaths: [
        { path: "src/useWorkspace.ts", kind: "file" as const },
        { path: "src", kind: "directory" as const },
      ],
    };
    const model = buildWorkspaceFileChangesTreeModel({ ...input, searchQuery: " SRC\\use " });
    expect(model.matchingChangedFileCount).toBe(1);
    expect(model.paths).toContain("Changed files/src/useWorkspace.ts");
    expect(model.paths).toContain("All files/src/useWorkspace.ts");
    expect(model.defaultExpandedPaths).toContain("All files/src");
    const empty = buildWorkspaceFileChangesTreeModel({
      ...input,
      browsePaths: [],
      searchQuery: "impossible",
    });
    expect(empty.paths).toEqual(["Changed files/", "All files/"]);
    expect(empty.changedFileCount).toBe(2);
    expect(empty.matchingChangedFileCount).toBe(0);
  });

  test("falls back to plain browsing without changes or when review sections are disabled", () => {
    for (const enabled of [true, false]) {
      const model = buildWorkspaceFileChangesTreeModel({
        changedFiles: [],
        browsePaths: [{ path: "src/a.ts", kind: "file" }],
        expandedPaths: ["", "src"],
        enabled,
      });
      expect(model.paths).toEqual(["src/", "src/a.ts"]);
      expect(model.sectioned).toBe(false);
      expect(model.defaultExpandedPaths).toEqual(["src"]);
      expect(resolveWorkspaceFileChangesTreePath(model, "src/a.ts")).toMatchObject({
        section: "all",
        relativePath: "src/a.ts",
      });
    }
    const disabled = buildWorkspaceFileChangesTreeModel({
      changedFiles: [{ path: "a", status: "modified" }],
      browsePaths: [],
      enabled: false,
    });
    expect(disabled.paths).toEqual([]);
    expect(disabled.gitStatus).toEqual([]);
  });

  test("retains collapse defaults and collision-safe file identities", () => {
    const model = buildWorkspaceFileChangesTreeModel({
      changedFiles: [
        { path: "a", status: "deleted" },
        { path: "a/b.ts", status: "added" },
      ],
      browsePaths: [],
      state: { changedCollapsed: true, allCollapsed: true, collapsedChangedPaths: ["a"] },
    });
    expect(model.defaultExpandedPaths).toEqual([]);
    const file = [...model.itemsByPath.values()].find(
      (item) => item.relativePath === "a" && item.kind === "file",
    );
    expect(file?.treePath).toBe("Changed files/a\u2063");
    expect(resolveWorkspaceFileChangesTreePath(model, file!.treePath)?.relativePath).toBe("a");
    expect(model.decorationsByPath.get(file!.treePath)).toBe("deleted");
  });
});
