import { describe, expect, test } from "vite-plus/test";
import { combineWorkspaceDirectoryListings } from "./use-workspace-directory-tree";
import { workspaceBrowseListing } from "./workspace-file-browse-popover";
import { toPierreWorkspaceTreePaths } from "./workspace-file-tree";

describe("use workspace directory tree", () => {
  const listing = (directoryPath: string, entries: [string, "file" | "directory"][]) => ({
    data: {
      directoryPath,
      parentPath: null,
      entries: entries.map(([path, type]) => ({
        path,
        name: path.split("/").at(-1)!,
        type,
        isSymlink: false,
      })),
    },
    error: null,
    isFetching: false,
    isPending: false,
  });
  const pending = { data: undefined, error: null, isFetching: true, isPending: true };

  describe("workspace directory listings", () => {
    test("joins listed and expanded folders and names the folders still loading", () => {
      const tree = combineWorkspaceDirectoryListings(
        ["", "src", "docs"],
        [
          listing("", [
            ["src", "directory"],
            ["docs", "directory"],
          ]),
          listing("src", [["src/a.ts", "file"]]),
          pending,
        ],
      );
      expect(tree.paths).toEqual([
        { path: "src", kind: "directory" },
        { path: "docs", kind: "directory" },
        { path: "src/a.ts", kind: "file" },
      ]);
      expect(tree.loadingDirectoryPaths).toEqual(["docs"]);
      expect(tree.isLoading).toBe(false);
    });

    test("reports only the listed folder's failure and refreshes of shown entries", () => {
      const failure = new Error("gone");
      const nested = { ...listing("gone", []), data: undefined, error: failure, isPending: false };
      const refreshing = { ...listing("", [["gone", "directory"]]), isFetching: true };
      const tree = combineWorkspaceDirectoryListings(["", "gone"], [refreshing, nested]);
      expect(tree.error).toBeNull();
      expect(tree.isRefreshing).toBe(true);
      expect(combineWorkspaceDirectoryListings([""], [{ ...pending, error: failure }]).error).toBe(
        failure,
      );
    });
  });
});

describe("workspaceBrowseListing", () => {
  test("lists the root's own contents for the workspace segment", () => {
    expect(workspaceBrowseListing("", true)).toEqual({
      directoryPath: "",
      selectedChild: null,
      expandSelected: false,
    });
  });

  test("lists a folder's parent with the folder selected and open", () => {
    expect(workspaceBrowseListing("src", true)).toEqual({
      directoryPath: "",
      selectedChild: "src",
      expandSelected: true,
    });
    expect(workspaceBrowseListing("src/lib", true)).toEqual({
      directoryPath: "src",
      selectedChild: "lib",
      expandSelected: true,
    });
  });

  test("lists a file's siblings with the file selected", () => {
    expect(workspaceBrowseListing("src/lib/a.ts", false)).toEqual({
      directoryPath: "src/lib",
      selectedChild: "a.ts",
      expandSelected: false,
    });
  });
});

describe("toPierreWorkspaceTreePaths", () => {
  test("preserves files and marks explicit empty directories with a trailing slash", () => {
    expect(
      toPierreWorkspaceTreePaths([
        { path: ".hidden", kind: "directory" },
        { path: ".hidden/empty", kind: "directory" },
        { path: ".hidden/LICENSE", kind: "file" },
        { path: "src/index.ts", kind: "file" },
      ]),
    ).toEqual([".hidden/", ".hidden/empty/", ".hidden/LICENSE", "src/index.ts"]);
  });
});
