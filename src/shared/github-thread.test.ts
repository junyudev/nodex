import { describe, expect, test } from "vite-plus/test";
import {
  gitHubThreadCommandSchema,
  gitHubThreadKey,
  gitHubThreadRefSchema,
  gitHubThreadUrl,
  parseGitHubThreadUrl,
} from "./github-thread";

describe("GitHub thread links", () => {
  test.each([
    ["https://github.com/acme/web/pull/7", "pull_request", "overview", null],
    ["https://github.com/acme/web/pull/7/", "pull_request", "overview", null],
    ["http://GitHub.com/acme/web/pull/7?w=1", "pull_request", "overview", null],
    ["https://github.com/acme/web/pull/7/files", "pull_request", "files", null],
    ["https://github.com/acme/web/pull/7/changes", "pull_request", "files", null],
    [
      "https://github.com/acme/web/pull/7/files/abc123#diff-0f1e",
      "pull_request",
      "files",
      "diff-0f1e",
    ],
    ["https://github.com/acme/web/pull/7/commits", "pull_request", "overview", null],
    ["https://github.com/acme/web/pull/7/commits/0a1b2c", "pull_request", "overview", null],
    ["https://github.com/acme/web/pull/7/checks", "pull_request", "overview", "checks"],
    [
      "https://github.com/acme/web/pull/7#issuecomment-42",
      "pull_request",
      "overview",
      "issuecomment-42",
    ],
    ["https://github.com/acme/web/pull/7#r99", "pull_request", "overview", "discussion_r99"],
    ["https://github.com/acme/web/issues/7", "issue", "overview", null],
    ["https://github.com/acme/web/issues/7#issuecomment-1", "issue", "overview", "issuecomment-1"],
  ] as const)("reads %s", (url, kind, view, anchor) => {
    expect(parseGitHubThreadUrl(url)).toEqual({
      ref: { host: "github.com", owner: "acme", repo: "web", number: 7 },
      kind,
      reveal: { view, anchor },
    });
  });

  test.each([
    "https://github.com/acme/web",
    "https://github.com/acme/web/pulls",
    "https://github.com/acme/web/pull/0",
    "https://github.com/acme/web/pull/07",
    "https://github.com/acme/web/pull/99999999999",
    "https://github.com/acme/web/pull/7/files/a/b",
    "https://github.com/acme/web/pull/7/unknown",
    "https://github.com/acme/web/issues/7/edit",
    "https://github.com/acme/web/blob/main/pull/7",
    "https://github.com/acme//web/pull/7",
    "https://user:token@github.com/acme/web/pull/7",
    "https://github.com:8443/acme/web/pull/7",
    "ftp://github.com/acme/web/pull/7",
    "https://github.com/-acme/web/pull/7",
    "https://github.com/acme/../pull/7",
    "not a url",
  ])("leaves %s to ordinary link handling", (url) => {
    expect(parseGitHubThreadUrl(url)).toBeNull();
  });

  test("names an issue and a pull request with the same number as one thread", () => {
    const pull = parseGitHubThreadUrl("https://github.com/Acme/Web/pull/7");
    const issue = parseGitHubThreadUrl("https://github.com/acme/web/issues/7");
    expect(pull && issue && gitHubThreadKey(pull.ref)).toBe(issue && gitHubThreadKey(issue.ref));
  });

  test("round-trips a canonical URL and validates a stored reference", () => {
    const ref = { host: "github.com", owner: "acme", repo: "web.site", number: 12 };
    expect(gitHubThreadUrl(ref, "pull_request")).toBe("https://github.com/acme/web.site/pull/12");
    expect(parseGitHubThreadUrl(gitHubThreadUrl(ref, "issue"))?.ref).toEqual(ref);
    expect(gitHubThreadRefSchema.safeParse(ref).success).toBe(true);
    expect(gitHubThreadRefSchema.safeParse({ ...ref, host: "GitHub.com" }).success).toBe(false);
  });

  test("accepts only well-formed commands", () => {
    expect(gitHubThreadCommandSchema.safeParse({ type: "comment", body: "  " }).success).toBe(
      false,
    );
    expect(
      gitHubThreadCommandSchema.safeParse({
        type: "merge",
        method: "squash",
        expectedHeadSha: "a".repeat(40),
      }).success,
    ).toBe(true);
    expect(
      gitHubThreadCommandSchema.safeParse({
        type: "merge",
        method: "squash",
        expectedHeadSha: "main",
      }).success,
    ).toBe(false);
  });
});
