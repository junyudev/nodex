import type { FuzzyFileSearchResult } from "@nodex/codex-app-server-protocol";
import { expect, test } from "vite-plus/test";
import { projectFileSearchResults } from "./file-search-results";
const file = (path: string, kind: "file" | "directory" = "file"): FuzzyFileSearchResult => ({
  root: "/repo",
  path,
  file_name: path.split("/").at(-1)!,
  match_type: kind,
  score: 1,
  indices: null,
});

test("filters generated path segments, ranks by filename, and preserves directory mentions", () => {
  const results = projectFileSearchResults(
    [
      file("src/abc-helper.ts"),
      file("node_modules/pkg/abc.ts"),
      file(".git/abc"),
      file("src/abc", "directory"),
      file("src/abc-dist.ts"),
      file("dist/abc.ts"),
    ],
    "abc",
    ["/repo"],
  );
  expect(results[0]).toEqual({
    root: "/repo",
    relativePath: "src/abc",
    directoryPath: "src",
    path: "src/abc",
    fsPath: "/repo/src/abc",
    label: "abc",
    kind: "directory",
  });
  expect(results.map((result) => result.path)).toEqual([
    "src/abc",
    "src/abc-dist.ts",
    "src/abc-helper.ts",
  ]);
});

test("distinguishes equal relative paths across roots and labels their containing workspace", () => {
  const results = projectFileSearchResults(
    [
      { ...file("src/abc.ts"), root: "/one" },
      { ...file("src/abc.ts"), root: "/two" },
    ],
    "abc",
    ["/one", "/two"],
  );
  expect(
    results.map(({ path, fsPath, directoryPath }) => ({ path, fsPath, directoryPath })),
  ).toEqual([
    { path: "/one/src/abc.ts", fsPath: "/one/src/abc.ts", directoryPath: "one/src" },
    { path: "/two/src/abc.ts", fsPath: "/two/src/abc.ts", directoryPath: "two/src" },
  ]);
});
