import { describe, expect, test } from "vite-plus/test";
import { combineWorkspaceDirectoryListings } from "./use-workspace-directory-tree";

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
