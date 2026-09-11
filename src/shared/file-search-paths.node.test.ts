import { expect, test } from "vite-plus/test";
import {
  normalizeSearchPath,
  compactFileSearchRoots,
  resolveSearchResultPath,
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
