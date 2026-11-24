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

test("filters generated path segments, keeps the native order, and preserves directory mentions", () => {
  const results = projectFileSearchResults(
    [
      file("src/abc-helper.ts"),
      file("node_modules/pkg/abc.ts"),
      file(".git/abc"),
      file("src/abc", "directory"),
      file("src/abc-dist.ts"),
      file("dist/abc.ts"),
    ],
    ["/repo"],
  );
  expect(results[1]).toEqual({
    root: "/repo",
    relativePath: "src/abc",
    directoryPath: "src",
    path: "src/abc",
    fsPath: "/repo/src/abc",
    label: "abc",
    kind: "directory",
  });
  expect(results.map((result) => result.path)).toEqual([
    "src/abc-helper.ts",
    "src/abc",
    "src/abc-dist.ts",
  ]);
});

test("distinguishes equal relative paths across roots and labels their containing workspace", () => {
  const results = projectFileSearchResults(
    [
      { ...file("src/abc.ts"), root: "/one" },
      { ...file("src/abc.ts"), root: "/two" },
    ],
    ["/one", "/two"],
  );
  expect(
    results.map(({ path, fsPath, directoryPath }) => ({ path, fsPath, directoryPath })),
  ).toEqual([
    { path: "/one/src/abc.ts", fsPath: "/one/src/abc.ts", directoryPath: "one/src" },
    { path: "/two/src/abc.ts", fsPath: "/two/src/abc.ts", directoryPath: "two/src" },
  ]);
});

test("places matched characters on the displayed name and folder", () => {
  // "é" in a decomposed name is one character to the matcher but two UTF-16 units here.
  const path = "src/Re\u0301sume\u0301/notes-file.md";
  const [single] = projectFileSearchResults(
    [{ ...file(path), indices: [0, 4, 5, 11, 17] }],
    ["/repo"],
  );
  expect(single!.matched).toEqual({
    label: [
      { start: 0, end: 1 },
      { start: 6, end: 7 },
    ],
    directory: [
      { start: 0, end: 1 },
      { start: 4, end: 7 },
    ],
  });
  const [, second] = projectFileSearchResults(
    [file("x.md"), { ...file("src/abc.ts"), root: "/two", indices: [0, 4] }],
    ["/one", "/two"],
  );
  // The folder is shown as "two/src", so its characters shift past the root label.
  expect(second!.matched).toEqual({
    label: [{ start: 0, end: 1 }],
    directory: [{ start: 4, end: 5 }],
  });
});
