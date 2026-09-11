import type { FuzzyFileSearchResult } from "@nodex/codex-app-server-protocol";
import { expect, test } from "vite-plus/test";
import { projectComposerFileSearchResults } from "./composer-file-search-results";
const file = (path: string, kind: "file" | "directory" = "file"): FuzzyFileSearchResult => ({
  root: "/repo",
  path,
  file_name: path.split("/").at(-1)!,
  match_type: kind,
  score: 1,
  indices: null,
});

test("filters generated path segments, ranks by filename, and preserves directory mentions", () => {
  const results = projectComposerFileSearchResults(
    [
      file("src/abc-helper.ts"),
      file("node_modules/pkg/abc.ts"),
      file(".git/abc"),
      file("src/abc", "directory"),
      file("src/abc-dist.ts"),
      file("dist/abc.ts"),
    ],
    "abc",
  );
  expect(results[0]).toEqual({
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
