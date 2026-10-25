import { expect, test } from "vite-plus/test";
import {
  normalizeSearchPath,
  compactFileSearchRoots,
  resolveSearchResultPath,
  searchPathsEqual,
  searchRootContainsPath,
} from "./file-search-paths";

test("searches each selected subtree once without confusing sibling path prefixes", () => {
  expect(
    compactFileSearchRoots(["/repo/src", "/repo", "/repo", "/repository", "/repo/./nested"]),
  ).toEqual(["/repo", "/repository"]);
  expect(compactFileSearchRoots(["/repo", "/"])).toEqual(["/"]);
});

test("resolves paths using the result Host including Windows drive and UNC roots", () => {
  expect(resolveSearchResultPath("/repo", "src/../test.ts")).toBe("/repo/test.ts");
  expect(resolveSearchResultPath("C:\\repo", "src/file.ts")).toBe("C:\\repo\\src\\file.ts");
  expect(resolveSearchResultPath("\\\\server\\share", "src/file.ts")).toBe(
    "\\\\server\\share\\src\\file.ts",
  );
  expect(resolveSearchResultPath("/repo", "/other/file.ts")).toBe("/other/file.ts");
});

test("normalizes parent segments without escaping POSIX, drive, or UNC roots", () => {
  expect(normalizeSearchPath("/../../repo")).toBe("/repo");
  expect(normalizeSearchPath("C:/../../repo")).toBe("C:/repo");
  expect(normalizeSearchPath("//server/share/../../repo")).toBe("//server/share/repo");
});

test("preserves filesystem roots and exact whitespace when joining search results", () => {
  expect(resolveSearchResultPath("/", "workspace/nested")).toBe("/workspace/nested");
  expect(resolveSearchResultPath("C:/", "workspace/nested")).toBe("C:\\workspace\\nested");
  expect(compactFileSearchRoots(["/repo ", "/repo"])).toEqual(["/repo ", "/repo"]);
});

test("Windows search comparisons ignore case without rewriting paths or merging POSIX names", () => {
  expect(searchPathsEqual("C:\\Repo\\src\\A.ts", "c:/repo/src/a.ts")).toBe(true);
  expect(searchPathsEqual("\\\\Server\\Share\\A.ts", "//server/share/a.ts")).toBe(true);
  expect(searchPathsEqual("/Repo/A.ts", "/repo/a.ts")).toBe(false);
  expect(searchRootContainsPath("C:\\Repo", "c:/repo/src/A.ts")).toBe(true);
  expect(searchRootContainsPath("C:\\Repo", "c:/repository/A.ts")).toBe(false);
  expect(searchRootContainsPath("C:\\Repo", "c:/repo/../outside/A.ts")).toBe(false);
  expect(searchRootContainsPath("\\\\Server\\Share", "//server/share/src/A.ts")).toBe(true);
  expect(searchRootContainsPath("\\\\Server\\Share", "//server/shared/A.ts")).toBe(false);
  expect(searchRootContainsPath("/Repo", "/repo/A.ts")).toBe(false);
  expect(compactFileSearchRoots(["C:\\Repo\\src", "c:/repo", "C:/REPO", "C:/repository"])).toEqual([
    "c:/repo",
    "C:/repository",
  ]);
  expect(compactFileSearchRoots(["/Repo", "/repo"])).toEqual(["/Repo", "/repo"]);
  expect(resolveSearchResultPath("C:\\Repo", "src/A.ts")).toBe("C:\\Repo\\src\\A.ts");
});
