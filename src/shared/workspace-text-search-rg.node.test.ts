import { expect, test } from "vite-plus/test";
import {
  escapeWorkspaceTextSearchGlob,
  parseWorkspaceTextSearchMatch,
  workspaceTextSearchPriorityPaths,
} from "./workspace-text-search-rg";

function matchEvent(content: string, starts: number[], match: string, path = "./src/main.ts") {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: path },
      lines: { text: `${content}\r\n` },
      line_number: 17,
      submatches: starts.map((start) => ({
        start: new TextEncoder().encode(content.slice(0, start)).length,
        end: new TextEncoder().encode(content.slice(0, start + match.length)).length,
      })),
    },
  });
}

test("translates UTF-8 byte offsets to UTF-16 columns and every visible match", () => {
  const content = "α🙂修复 target — target";
  const match = parseWorkspaceTextSearchMatch(
    matchEvent(content, [content.indexOf("target"), content.lastIndexOf("target")], "target"),
    "/repo",
    "posix",
  );
  expect(match).toEqual({
    path: "/repo/src/main.ts",
    root: "/repo",
    relativePath: "src/main.ts",
    line: 17,
    column: content.indexOf("target") + 1,
    preview: content,
    matchRanges: [
      { start: content.indexOf("target"), end: content.indexOf("target") + 6 },
      { start: content.lastIndexOf("target"), end: content.lastIndexOf("target") + 6 },
    ],
  });
});

test("clips long previews around the first match without splitting surrogate pairs", () => {
  const content = `${"a".repeat(100)}🙂${"b".repeat(23)}target${"🙂".repeat(400)}`;
  const match = parseWorkspaceTextSearchMatch(
    matchEvent(content, [content.indexOf("target")], "target"),
    "/repo",
    "posix",
  );
  expect(match).not.toBeNull();
  expect(match!.preview.length).toBeLessThanOrEqual(512);
  expect(match!.preview.startsWith("…🙂")).toBe(true);
  expect(match!.preview.endsWith("…")).toBe(true);
  expect(match!.preview).not.toMatch(/[\uD800-\uDFFF]/u);
  const range = match!.matchRanges[0]!;
  expect(match!.preview.slice(range.start, range.end)).toBe("target");
  expect(match!.column).toBe(content.indexOf("target") + 1);
});

test("bounds highlight count and clips long matches to the visible preview", () => {
  const repeated = "a ".repeat(40);
  const many = parseWorkspaceTextSearchMatch(
    matchEvent(
      repeated,
      Array.from({ length: 40 }, (_, index) => index * 2),
      "a",
    ),
    "/repo",
    "posix",
  );
  expect(many?.matchRanges).toHaveLength(32);
  const long = parseWorkspaceTextSearchMatch(
    matchEvent("x".repeat(600), [0], "x".repeat(600)),
    "/repo",
    "posix",
  );
  expect(long?.preview).toHaveLength(512);
  expect(long?.matchRanges).toEqual([{ start: 0, end: 511 }]);
});

test("ignores non-match records and malformed or out-of-line ranges", () => {
  for (const line of ["not json", "null", '{"type":"summary"}', '{"type":"match","data":{}}']) {
    expect(parseWorkspaceTextSearchMatch(line, "/repo", "posix")).toBeNull();
  }
  const line = JSON.parse(matchEvent("text", [0], "text"));
  line.data.submatches[0].end = 50;
  expect(parseWorkspaceTextSearchMatch(JSON.stringify(line), "/repo", "posix")).toBeNull();
});

test("resolves native Windows paths while exposing slash-separated display paths", () => {
  const match = parseWorkspaceTextSearchMatch(
    matchEvent("target", [0], "target", ".\\src\\main.ts"),
    "C:\\repo",
    "win32",
  );
  expect(match?.path).toBe("C:\\repo\\src\\main.ts");
  expect(match?.relativePath).toBe("src/main.ts");
});

test("keeps only contained non-overlapping priority directories on each host platform", () => {
  expect(
    workspaceTextSearchPriorityPaths(
      "/repo",
      [
        "/repo/src/deep",
        "/repo/src",
        "/repo/src",
        "/repository",
        "/repo",
        "relative",
        "/repo/test",
      ],
      "posix",
    ),
  ).toEqual(["src", "test"]);
  expect(
    workspaceTextSearchPriorityPaths(
      "C:\\repo",
      ["C:\\repo\\src\\nested", "C:\\repo\\src", "D:\\elsewhere", "C:\\repo2", "C:\\repo"],
      "win32",
    ),
  ).toEqual(["src"]);
});

test("escapes priority directory glob metacharacters without changing path separators", () => {
  expect(escapeWorkspaceTextSearchGlob("src/[demo]/{a,b}!*?\\folder")).toBe(
    "src/\\[demo\\]/\\{a,b\\}\\!\\*\\?\\\\folder",
  );
});
