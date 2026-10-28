import { describe, expect, test } from "vite-plus/test";
import { buildGitHubBlobUrl } from "./git-file-url";

const input = { path: "/repo/src/文件 #1.ts", repoRoot: "/repo", branch: "feature/menu", line: 12 };

describe("GitHub file locations", () => {
  test.each([
    "git@github.com:team/nodex.git",
    "https://secret@github.com/team/nodex.git",
    "ssh://git@github.com/team/nodex.git",
  ])("builds a credential-free encoded location from %s", (originUrl) => {
    expect(buildGitHubBlobUrl({ ...input, originUrl })).toBe(
      "https://github.com/team/nodex/blob/feature/menu/src/%E6%96%87%E4%BB%B6%20%231.ts#L12",
    );
  });
  test.each([
    { originUrl: "git@gitlab.com:team/nodex.git" },
    { originUrl: "git@github.com:team/nodex.git", path: "/repo-other/src/file.ts" },
    { originUrl: "git@github.com:team/nodex.git", path: "../outside.ts", cwd: "/repo" },
    { originUrl: "git@github.com:team/nodex.git", branch: null },
  ])("rejects unavailable or out-of-repository locations", (overrides) => {
    expect(buildGitHubBlobUrl({ ...input, ...overrides })).toBeNull();
  });
  test("compares Windows roots case-insensitively and retains authored filename casing", () => {
    expect(
      buildGitHubBlobUrl({
        originUrl: "git@github.com:team/nodex.git",
        path: "c:\\Repo\\Src\\File.ts",
        repoRoot: "C:/repo",
        branch: "main",
      }),
    ).toBe("https://github.com/team/nodex/blob/main/Src/File.ts");
  });
});
