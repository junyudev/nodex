import { describe, expect, test } from "vite-plus/test";
import type {
  GitHubCheck,
  GitHubPullRequestDetail,
  GitHubReactions,
  GitHubReviewThread,
  GitHubTimelineItem,
} from "../../../shared/github-thread";
import {
  gitHubMergeDecision,
  gitHubThreadLines,
  linkGitHubReferences,
  projectGitHubActivity,
  summarizeGitHubChecks,
  toggleGitHubReaction,
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
  mergeQueued: false,
  autoMerge: null,
  viewer: {
    login: "me",
    canComment: true,
    canChangeState: true,
    canEdit: true,
    canMerge: true,
    canChangeDraft: true,
    mergeMethods: ["squash"],
    canApprove: true,
    canEnableAutoMerge: false,
    canDisableAutoMerge: false,
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
    [{ mergeQueued: true, checks: [check("e2e", "pending")] }, "queued", false],
    [
      { mergeState: "blocked", autoMerge: { method: "squash", enabledBy: "me" } },
      "auto_merge",
      false,
    ],
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
  const bot = { login: "lint-bot", avatarUrl: null, url: null, isBot: true };
  const reactions: GitHubReactions = { subjectId: "s", groups: [], viewerCanReact: true };
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
  const comment = (id: string, author = actor): GitHubTimelineItem => ({
    kind: "comment",
    id,
    anchor: `issuecomment-${id}`,
    author,
    body: "ok",
    createdAt: "2026-01-01T00:00:00Z",
    edited: false,
    url: "",
    canEdit: false,
    canDelete: false,
    reactions,
  });
  const review = (id: string, threadIds: string[], body = ""): GitHubTimelineItem => ({
    kind: "review",
    id,
    anchor: `pullrequestreview-${id}`,
    author: actor,
    state: "commented",
    body,
    submittedAt: "2026-01-01T00:00:00Z",
    url: "",
    canEdit: false,
    reactions,
    threadIds,
  });
  const thread = (id: string): GitHubReviewThread => ({
    id,
    path: "src/a.ts",
    subject: "line",
    side: "right",
    startSide: null,
    line: 4,
    startLine: null,
    originalLine: 4,
    originalStartLine: null,
    diffHunk: "@@ -1 +1 @@\n+a",
    outdated: false,
    resolved: false,
    canReply: true,
    canResolve: true,
    canUnresolve: false,
    comments: [],
    commentsTruncated: false,
  });

  test("folds consecutive pushes and drops reviews that say nothing of their own", () => {
    const rows = projectGitHubActivity(
      [
        commit("a"),
        commit("b"),
        // A reply posted from a conversation: it reads in the thread it answers.
        review("reply-only", []),
        review("opened", ["t1", "missing"]),
        comment("c1"),
        commit("c"),
      ],
      "pull_request",
      { threads: [thread("t1")] },
    );
    expect(rows.map((row) => row.kind)).toEqual(["commits", "review", "comment", "commits"]);
    expect(rows[0]?.kind === "commits" && rows[0].commits.length).toBe(2);
    expect(rows[1]?.kind === "review" && rows[1].threads.map((item) => item.id)).toEqual(["t1"]);
  });

  test("filters to what people wrote, with or without bots", () => {
    const timeline = [commit("a"), comment("c1"), comment("c2", bot), review("r1", [], "LGTM")];
    const ids = (filter: "all" | "comments" | "people") =>
      projectGitHubActivity(timeline, "pull_request", { filter }).map((row) => row.id);
    expect(ids("all")).toEqual(["commits:a", "c1", "c2", "r1"]);
    expect(ids("comments")).toEqual(["c1", "c2", "r1"]);
    expect(ids("people")).toEqual(["c1", "r1"]);
  });

  test("an outdated thread points at the lines it was written on", () => {
    expect(gitHubThreadLines({ ...thread("t"), startLine: 2 })).toEqual({ start: 2, end: 4 });
    expect(
      gitHubThreadLines({
        ...thread("t"),
        outdated: true,
        line: null,
        startLine: null,
        originalLine: 9,
        originalStartLine: 7,
      }),
    ).toEqual({ start: 7, end: 9 });
  });
});

describe("GitHub reactions", () => {
  const reactions: GitHubReactions = {
    subjectId: "s",
    viewerCanReact: true,
    groups: [
      { content: "thumbs_up", count: 2, viewerReacted: false },
      { content: "eyes", count: 1, viewerReacted: true },
    ],
  };

  test("the viewer's choice shows at once, in GitHub's order, and an emptied reaction leaves", () => {
    expect(toggleGitHubReaction(reactions, "rocket", true).groups.map((g) => g.content)).toEqual([
      "thumbs_up",
      "rocket",
      "eyes",
    ]);
    expect(toggleGitHubReaction(reactions, "thumbs_up", true).groups[0]).toEqual({
      content: "thumbs_up",
      count: 3,
      viewerReacted: true,
    });
    expect(toggleGitHubReaction(reactions, "eyes", false).groups).toHaveLength(1);
    // Repeating a choice the viewer already holds changes nothing.
    expect(toggleGitHubReaction(reactions, "eyes", true)).toBe(reactions);
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
