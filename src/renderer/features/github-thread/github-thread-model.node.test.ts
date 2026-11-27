import { describe, expect, test } from "vite-plus/test";
import type {
  GitHubCheck,
  GitHubPullRequestDetail,
  GitHubTimelineItem,
} from "../../../shared/github-thread";
import {
  gitHubMergeDecision,
  linkGitHubReferences,
  projectGitHubActivity,
  summarizeGitHubChecks,
} from "./github-thread-model";

const ref = { host: "github.com", owner: "acme", repo: "web", number: 7 };

const check = (name: string, status: GitHubCheck["status"], required = false): GitHubCheck => ({
  id: name,
  name,
  workflow: null,
  status,
  required,
  description: null,
  url: null,
  startedAt: null,
  completedAt: null,
});

type MergeInput = Parameters<typeof gitHubMergeDecision>[0];
const openPr = (overrides: Partial<MergeInput> = {}): MergeInput => ({
  state: "open",
  draft: false,
  mergeable: "mergeable",
  mergeState: "clean",
  reviewDecision: null,
  checks: [],
  viewer: {
    login: "me",
    canComment: true,
    canChangeState: true,
    canMerge: true,
    canChangeDraft: true,
    mergeMethods: ["squash"],
  } satisfies GitHubPullRequestDetail["viewer"],
  ...overrides,
});

describe("GitHub checks", () => {
  test("lead with what needs attention, required failures first", () => {
    const summary = summarizeGitHubChecks([
      check("lint", "success"),
      check("e2e", "pending"),
      check("docs", "failure"),
      check("build", "failure", true),
      check("deploy", "skipped"),
    ]);
    expect(summary.ordered.map((item) => item.name)).toEqual([
      "build",
      "docs",
      "e2e",
      "lint",
      "deploy",
    ]);
    expect(summary.counts).toEqual({ failing: 2, running: 1, passed: 1, skipped: 1 });
    expect(summary.rollup).toBe("failing");
    expect(summarizeGitHubChecks([check("deploy", "skipped")]).rollup).toBe("skipped");
    expect(summarizeGitHubChecks([]).rollup).toBeNull();
  });
});

describe("GitHub merge decision", () => {
  test.each([
    [{ state: "merged" }, "merged", false],
    [{ draft: true }, "draft", false],
    [{ mergeable: "conflicting" }, "conflicts", false],
    [{ mergeState: "blocked", checks: [check("build", "failure", true)] }, "checks_failing", false],
    [{ mergeState: "blocked", reviewDecision: "review_required" }, "review_required", false],
    [{ mergeState: "unstable", checks: [check("docs", "failure")] }, "checks_failing", true],
    [{ mergeState: "behind" }, "behind", false],
    [{ mergeable: "unknown", mergeState: "unknown" }, "checking", false],
    [{ checks: [check("e2e", "pending")] }, "checks_running", true],
    [{}, "ready", true],
    [{ viewer: { ...openPr().viewer, canMerge: false } }, "ready", false],
  ] as const)("%o reads as %s", (overrides, kind, canMerge) => {
    const decision = gitHubMergeDecision(openPr(overrides as Partial<MergeInput>));
    expect(decision.readiness.kind).toBe(kind);
    expect(decision.canMerge).toBe(canMerge);
  });
});

describe("GitHub activity", () => {
  const actor = { login: "ana", avatarUrl: null, url: null, isBot: false };
  const commit = (id: string): GitHubTimelineItem => ({
    kind: "commit",
    id,
    oid: id.padEnd(40, "0"),
    headline: `commit ${id}`,
    author: actor,
    authorName: null,
    committedAt: "2026-01-01T00:00:00Z",
    url: "",
  });

  test("folds consecutive pushes and drops reviews that say nothing", () => {
    const rows = projectGitHubActivity([
      commit("a"),
      commit("b"),
      {
        kind: "review",
        id: "r1",
        anchor: "pullrequestreview-1",
        author: actor,
        state: "commented",
        body: "",
        submittedAt: "2026-01-01T00:00:00Z",
        url: "",
        comments: [],
      },
      {
        kind: "comment",
        id: "c1",
        anchor: "issuecomment-1",
        author: actor,
        body: "ok",
        createdAt: "2026-01-01T00:00:00Z",
        edited: false,
        url: "",
      },
      commit("c"),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["commits", "comment", "commits"]);
    expect(rows[0]?.kind === "commits" && rows[0].commits.length).toBe(2);
  });
});

describe("GitHub merge events", () => {
  const event = (id: string, at: string, type: "merged" | "closed"): GitHubTimelineItem => ({
    kind: "event",
    id,
    actor: null,
    createdAt: at,
    event:
      type === "merged" ? { type, commitOid: null, baseBranch: "main" } : { type, reason: null },
  });

  test("a pull request's merge hides the close GitHub records with it, but not a later close", () => {
    const timeline = [
      event("m", "2026-01-01T00:00:00Z", "merged"),
      event("c1", "2026-01-01T00:00:01Z", "closed"),
      event("c2", "2026-01-02T00:00:00Z", "closed"),
    ];
    expect(projectGitHubActivity(timeline, "pull_request").map((row) => row.id)).toEqual([
      "m",
      "c2",
    ]);
    expect(projectGitHubActivity(timeline, "issue")).toHaveLength(3);
  });
});

describe("GitHub references in Markdown", () => {
  test("links issue, cross-repository and people references", () => {
    expect(linkGitHubReferences("Closes #12, see other/lib#3 (thanks @ana).", ref)).toBe(
      "Closes [#12](https://github.com/acme/web/issues/12), see [other/lib#3](https://github.com/other/lib/issues/3) (thanks [@ana](https://github.com/ana)).",
    );
  });

  test("leaves code, links, URLs, emails and headings alone", () => {
    const untouched = [
      "Run `npm test #12` first",
      "[#12](https://example.com) and https://github.com/acme/web/pull/12#issuecomment-1",
      "mail ana@example.com",
      "```\n#12 @ana\n```",
      "    indented #12",
      "issue#12",
    ].join("\n");
    expect(linkGitHubReferences(untouched, ref)).toBe(untouched);
  });
});
