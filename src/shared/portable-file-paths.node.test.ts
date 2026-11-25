import { describe, expect, test, it } from "vite-plus/test";
import { asciiDirectoryName, asciiSlug } from "./ascii-name";
import { getAssetSource, parseAssetSource } from "./assets";
import { areWorkspacePathsEquivalent, workspaceRootsForCwd } from "./codex-workspace-paths";
import {
  isCodexWorktreeEnvironmentConfigPath,
  requireCodexWorktreeEnvironmentConfigPath,
} from "./codex-worktree-environment-path";
import {
  normalizeSearchPath,
  compactFileSearchRoots,
  resolveSearchResultPath,
  searchPathsEqual,
  searchRootContainsPath,
} from "./file-search-paths";
import { parseGitRepositoryOwnerRepo } from "./git-repository-identity";
import { abbreviateHomeDirectory } from "./local-path-presentation";
import {
  escapeWorkspaceTextSearchGlob,
  parseWorkspaceTextSearchMatch,
  workspaceTextSearchPriorityPaths,
} from "./workspace-text-search-rg";
import {
  isWorkspaceTextSearchQueryValid,
  parseWorkspaceTextSearchFileMask,
} from "./workspace-text-search";
import { WorkspaceTextSearchStartSchema } from "./schemas/workspace-text-search";

describe("ASCII names", () => {
  test.each([
    ["Fix the user's login_flow / signup!", {}, "fix-the-users-login-flow-signup"],
    ["Crème brûlée Ångström", {}, "creme-brulee-angstrom"],
    ["ＡＢＣ １２３ ﬁle ℡", {}, "abc-123-file-tel"],
    ["Straße Ærø Łódź", {}, "strasse-aero-lodz"],
    ["帮我修复 login 页面的 bug", {}, "login-bug"],
    ["修复login和signup", {}, "login-signup"],
    ["你好，世界", {}, ""],
    ["한국어 🗂️", {}, ""],
    ["  ---  ", {}, ""],
    ["one two three four", { maxWords: 2 }, "one-two"],
    ["alpha beta gamma", { maxLength: 11 }, "alpha-beta"],
    ["alpha beta gamma", { maxLength: 8 }, "alpha-be"],
  ] as const)("slugs %j with %j", (text, limits, slug) => {
    const result = asciiSlug(text, limits);
    expect(result).toBe(slug);
    expect(result).toMatch(/^(?:[a-z0-9]+(?:-[a-z0-9]+)*)?$/u);
  });

  test("names a directory with a fallback and never as a Windows device", () => {
    expect(asciiDirectoryName("Launch Plan", "new-project")).toBe("launch-plan");
    expect(asciiDirectoryName("我的项目", "new-project")).toBe("new-project");
    expect(asciiDirectoryName("CON", "new-project")).toBe("new-project-con");
    expect(asciiDirectoryName("com¹", "new-chat")).toBe("new-chat-com1");
    expect(asciiDirectoryName("console", "new-chat")).toBe("console");
  });
});

describe("shared asset helpers", () => {
  test("getAssetSource returns the canonical asset URI", () => {
    expect(getAssetSource("abc.png")).toBe("nodex://assets/abc.png");
  });

  test("parseAssetSource accepts the canonical asset URI", () => {
    const parsed = parseAssetSource("nodex://assets/abc.png");

    expect(parsed?.fileName).toBe("abc.png");
    expect(Boolean(parsed)).toBe(true);
  });

  test("parseAssetSource rejects nested asset paths", () => {
    expect(parseAssetSource("nodex://assets/default/abc.png") === null).toBe(true);
  });

  test("parseAssetSource rejects invalid nested asset paths", () => {
    expect(parseAssetSource("nodex://assets/default/extra/abc.png") === null).toBe(true);
  });
});

describe("codex workspace paths", () => {
  test.each([
    ["C:\\Repo\\Shared", "c:/repo/shared/", true],
    ["\\\\?\\C:\\Repo\\Shared", "/mnt/c/repo/shared", true],
    ["\\\\?\\UNC\\Server\\Share\\Folder", "//server/share/folder/", true],
    ["\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Repo", "C:/Repo", true],
    ["\\\\wsl$\\Ubuntu\\home\\User", "//wsl.localhost/ubuntu/home/User/", true],
    ["//wsl$/Ubuntu/home/User", "//wsl$/Debian/home/User", false],
    ["/mnt/c/Repo", "/mnt/c/repo", false],
    ["/home/User", "/home/user", false],
    ["/home/User", "//wsl$/Ubuntu/home/User", false],
    ["/one/../two", "/two", false],
  ] as const)("workspace path equivalence: %s and %s", (left, right, equivalent) => {
    expect(areWorkspacePathsEquivalent(left, right)).toBe(equivalent);
    expect(areWorkspacePathsEquivalent(right, left)).toBe(equivalent);
  });

  test.each([
    ["C:\\Repo", ["C:/Shared", "\\\\server\\share"]],
    ["//server/share", ["C:/Shared", "\\\\server\\share"]],
    ["/repo", ["/shared", "/mnt/c/Shared"]],
    ["relative", []],
    [null, []],
  ] as const)("runtime roots belong to the working directory path family: %s", (cwd, expected) => {
    expect(
      workspaceRootsForCwd(cwd, [
        "C:/Shared",
        "\\\\server\\share",
        "/shared",
        "/mnt/c/Shared",
        "relative",
        "~",
        "//incomplete",
      ]),
    ).toEqual(expected);
  });
});

describe("Codex worktree environment config paths", () => {
  test.each([
    ".codex/environments/environment.toml",
    ".codex/environments/team/dev.toml",
    ".codex\\environments\\windows.toml",
  ])("accepts the portable workspace-relative identifier %s", (value) => {
    expect(isCodexWorktreeEnvironmentConfigPath(value)).toBe(true);
    expect(requireCodexWorktreeEnvironmentConfigPath(value)).toBe(value);
  });

  test.each([
    "/repo/.codex/environments/environment.toml",
    "C:\\repo\\.codex\\environments\\environment.toml",
    ".codex/environments/../secrets.toml",
    ".codex/environment.toml",
    ".codex/environments/readme.md",
    " .codex/environments/environment.toml",
  ])("rejects the non-portable or escaping path %s", (value) => {
    expect(isCodexWorktreeEnvironmentConfigPath(value)).toBe(false);
    expect(() => requireCodexWorktreeEnvironmentConfigPath(value)).toThrow(
      "workspace-relative .toml file inside .codex/environments",
    );
  });
});

describe("file search paths", () => {
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
    expect(
      compactFileSearchRoots(["C:\\Repo\\src", "c:/repo", "C:/REPO", "C:/repository"]),
    ).toEqual(["c:/repo", "C:/repository"]);
    expect(compactFileSearchRoots(["/Repo", "/repo"])).toEqual(["/Repo", "/repo"]);
    expect(resolveSearchResultPath("C:\\Repo", "src/A.ts")).toBe("C:\\Repo\\src\\A.ts");
  });
});

describe("parseGitRepositoryOwnerRepo", () => {
  it.each([
    ["https://github.com/openai/codex.git", { owner: "openai", repo: "codex" }],
    ["ssh://git@github.com:2222/openai/codex.git", { owner: "openai", repo: "codex" }],
    ["git@github.com:openai/codex.git", { owner: "openai", repo: "codex" }],
    ["https://gitlab.example.com/product/tools/nodex", { owner: "product/tools", repo: "nodex" }],
    [
      "git://example.com/team/repo.with-punctuation.git",
      {
        owner: "team",
        repo: "repo.with-punctuation",
      },
    ],
    [
      "git@example.com:acme/private.git?token=hidden",
      {
        owner: "acme",
        repo: "private",
      },
    ],
  ])("parses %s", (remoteUrl, expected) => {
    expect(parseGitRepositoryOwnerRepo(remoteUrl)).toEqual(expected);
  });

  it.each([
    null,
    "",
    "not a remote",
    "/Users/example/repository",
    "file:///Users/example/repository",
    "C:\\repository",
  ])("returns null for %s", (remoteUrl) => {
    expect(parseGitRepositoryOwnerRepo(remoteUrl)).toBeNull();
  });
});

describe("abbreviateHomeDirectory", () => {
  it("abbreviates the home directory and descendants on POSIX", () => {
    const context = { homeDirectory: "/Users/asc/", separator: "/" } as const;
    expect(abbreviateHomeDirectory("/Users/asc", context)).toBe("~");
    expect(abbreviateHomeDirectory("/Users/asc/repo/nodex", context)).toBe("~/repo/nodex");
    expect(abbreviateHomeDirectory("/Users/ascii/repo", context)).toBe("/Users/ascii/repo");
  });

  it("compares Windows paths case-insensitively", () => {
    const context = { homeDirectory: "C:\\Users\\Asc", separator: "\\" } as const;
    expect(abbreviateHomeDirectory("c:\\users\\asc\\repo", context)).toBe("~\\repo");
  });

  it("preserves the raw value when presentation context is unavailable", () => {
    expect(abbreviateHomeDirectory("/home/other/repo", null)).toBe("/home/other/repo");
  });
});

describe("workspace text search rg", () => {
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
});

describe("workspace text search input", () => {
  it("accepts literal single-line queries and bounds input before starting a process", () => {
    expect(isWorkspaceTextSearchQueryValid(" [literal].* ")).toBe(true);
    expect(isWorkspaceTextSearchQueryValid("x".repeat(256))).toBe(true);
    for (const query of ["", " ", "x".repeat(257), "one\ntwo", "one\rtwo", "one\0two"])
      expect(isWorkspaceTextSearchQueryValid(query)).toBe(false);
  });
  it("splits only top-level mask commas and orders inclusive masks ahead of exclusions", () => {
    expect(
      parseWorkspaceTextSearchFileMask("!dist/**,*.{ts,tsx},[a,b]*,name\\,part, , !vendor/**"),
    ).toEqual({
      include: ["*.{ts,tsx}", "[a,b]*", "name\\,part"],
      exclude: ["!dist/**", "!vendor/**"],
    });
    expect(parseWorkspaceTextSearchFileMask(" ")).toEqual({ include: [], exclude: [] });
    for (const mask of [
      "*.{ts,tsx",
      "*.ts}",
      "[ab",
      "*.ts]",
      "trailing\\",
      "x".repeat(257),
      "a\nb",
      "a\0b",
    ])
      expect(parseWorkspaceTextSearchFileMask(mask)).toBeNull();
  });
  it("accepts local and connected absolute roots but rejects unbounded and relative ingress", () => {
    const valid = {
      requestId: "f3ebc134-7b2b-4c8d-8758-01e7b2a87065",
      hostId: "ssh:work",
      roots: ["/work"],
      query: "needle",
    };
    expect(WorkspaceTextSearchStartSchema.safeParse(valid).success).toBe(true);
    for (const patch of [
      { roots: ["relative"] },
      { roots: [] },
      { roots: Array(33).fill("/work") },
      { fileMask: "x".repeat(257) },
      { priorityFolders: Array(21).fill("/work/src") },
    ])
      expect(WorkspaceTextSearchStartSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});
