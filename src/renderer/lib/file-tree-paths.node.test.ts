import { describe, expect, test } from "vite-plus/test";
import {
  applyFileTreeExpansion,
  buildFileTreeInput,
  diffFileTreePaths,
  withFileTreeFolders,
  type FileTreeFolderHandle,
} from "./file-tree-paths";

/** Folder flags with the tree's rule that opening a folder opens every folder above it. */
function folderTree(paths: readonly string[], expanded: readonly string[] = []) {
  const open = new Set(expanded);
  const folders = new Set(paths);
  const getFolder = (path: string): FileTreeFolderHandle | null =>
    folders.has(path)
      ? {
          isExpanded: () => open.has(path),
          expand: () => {
            const parts = path.split("/");
            for (let depth = 1; depth <= parts.length; depth += 1)
              open.add(parts.slice(0, depth).join("/"));
          },
          collapse: () => open.delete(path),
        }
      : null;
  return { open, getFolder };
}

describe("file tree input", () => {
  test("lists every containing folder once, after the given entries", () => {
    expect(withFileTreeFolders(["a/b/c.ts", "a/b/", "x.ts", "a/d/e/"])).toEqual([
      "a/b/c.ts",
      "a/b/",
      "x.ts",
      "a/d/e/",
      "a/",
      "a/d/",
    ]);
  });

  test("removes deepest entries first and keeps entries both inputs share", () => {
    expect(
      diffFileTreePaths(["a/", "a/b/", "a/b/c.ts", "a/x.ts", "z.ts"], ["a/", "a/x.ts", "y.ts"]),
    ).toEqual([
      { type: "remove", path: "z.ts" },
      { type: "remove", path: "a/b/c.ts" },
      { type: "remove", path: "a/b/" },
      { type: "add", path: "y.ts" },
    ]);
  });
});

describe("file tree expansion", () => {
  test("keeps a parent collapsed when its expanded child is restored", () => {
    const tree = folderTree(["outer", "outer/inner"]);
    applyFileTreeExpansion(tree.getFolder, { expand: ["outer/inner"], collapse: [] });
    expect([...tree.open]).toEqual(["outer/inner"]);
  });

  test("opens requested ancestors and closes only incidental ones", () => {
    const tree = folderTree(["a", "a/b", "a/b/c", "x"], ["x"]);
    applyFileTreeExpansion(tree.getFolder, { expand: ["a/b/c", "a"], collapse: ["x"] });
    expect([...tree.open].sort()).toEqual(["a", "a/b/c"]);
  });

  test("leaves folders outside the request untouched", () => {
    const tree = folderTree(["a", "a/b", "c"], ["a", "c"]);
    applyFileTreeExpansion(tree.getFolder, { expand: ["a/b"], collapse: ["missing"] });
    expect([...tree.open].sort()).toEqual(["a", "a/b", "c"]);
  });
});

describe("file tree rows", () => {
  test("adds a placeholder inside each loading folder without colliding with real entries", () => {
    const input = buildFileTreeInput(["src/", "src/.nodex-loading", "docs/a.md"], ["src", "lib"]);
    expect([...input.loadingRows]).toEqual(["src/.nodex-loading_", "lib/.nodex-loading"]);
    expect(input.folders).toEqual(["src", "docs", "lib"]);
    expect(input.treePaths).toContain("lib/");
  });
});
