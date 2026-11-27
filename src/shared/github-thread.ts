import { z } from "zod";

/**
 * GitHub issues and pull requests shown natively in a GitHub tab.
 *
 * A thread is addressed by its host, repository and number, independently of any checkout.
 * Issues and pull requests share one number space per repository, so `/issues/N` and `/pull/N`
 * name the same thread; the kind read from a link is only a hint until GitHub answers.
 */

export interface GitHubThreadRef {
  /** Lowercased hostname, such as `github.com`. */
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

export type GitHubThreadKind = "pull_request" | "issue";

/** The part of a thread a link points into. Never part of the thread's identity. */
export type GitHubThreadView = "overview" | "files";

export interface GitHubThreadReveal {
  readonly view: GitHubThreadView;
  /** A GitHub page anchor such as `issuecomment-1`, `pullrequestreview-2` or `discussion_r3`. */
  readonly anchor: string | null;
}

export interface GitHubThreadLink {
  readonly ref: GitHubThreadRef;
  readonly kind: GitHubThreadKind;
  readonly reveal: GitHubThreadReveal;
}

const OWNER_PATTERN = /^[a-z\d](?:[a-z\d-]{0,38})$/iu;
const REPO_PATTERN = /^[\w.-]{1,100}$/u;
const MAX_NUMBER = 2 ** 31 - 1;

export const gitHubThreadRefSchema = z.strictObject({
  host: z
    .string()
    .min(1)
    .max(253)
    .refine((host) => host === host.trim().toLowerCase()),
  owner: z.string().regex(OWNER_PATTERN),
  repo: z
    .string()
    .regex(REPO_PATTERN)
    .refine((repo) => repo !== "." && repo !== ".."),
  number: z.number().int().min(1).max(MAX_NUMBER),
}) satisfies z.ZodType<GitHubThreadRef>;

export const gitHubThreadKindSchema = z.enum(["pull_request", "issue"]);
export const gitHubThreadViewSchema = z.enum([
  "overview",
  "files",
]) satisfies z.ZodType<GitHubThreadView>;

export const gitHubThreadSurfaceConfigSchema = z.strictObject({
  thread: gitHubThreadRefSchema,
  kind: gitHubThreadKindSchema,
});
export type GitHubThreadSurfaceConfig = z.infer<typeof gitHubThreadSurfaceConfigSchema>;

export const gitHubThreadSurfaceStateSchema = z.strictObject({ view: gitHubThreadViewSchema });
export const DEFAULT_GITHUB_THREAD_SURFACE_STATE = { view: "overview" } as const;

/** One stable identity per thread: hosts and repository names compare case-insensitively. */
export function gitHubThreadKey(ref: GitHubThreadRef): string {
  return `${ref.host}/${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;
}

export function sameGitHubThread(a: GitHubThreadRef, b: GitHubThreadRef): boolean {
  return gitHubThreadKey(a) === gitHubThreadKey(b);
}

/** `owner/repo#N`, the way GitHub itself refers to a thread. */
export function gitHubThreadLabel(ref: GitHubThreadRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

export function gitHubThreadUrl(ref: GitHubThreadRef, kind: GitHubThreadKind): string {
  const segment = kind === "pull_request" ? "pull" : "issues";
  return `https://${ref.host}/${ref.owner}/${ref.repo}/${segment}/${ref.number}`;
}

const PULL_FILES_ROUTES = new Set(["files", "changes"]);
const PULL_OVERVIEW_ROUTES = new Set(["commits", "checks"]);

function normalizeAnchor(hash: string): string | null {
  const anchor = hash.replace(/^#/u, "").trim();
  if (!anchor || anchor.length > 200 || !/^[\w.-]+$/u.test(anchor)) return null;
  // GitHub shortens review-comment permalinks to `r<id>`; the page anchor is `discussion_r<id>`.
  const normalized = /^r\d+$/u.test(anchor) ? `discussion_${anchor}` : anchor;
  return normalized.length <= 200 ? normalized : null;
}

/**
 * Recognize a link to one GitHub issue or pull request.
 *
 * Accepts `https://HOST/OWNER/REPO/pull/N` (optionally `/files`, `/changes`, `/commits[/SHA]`,
 * `/checks`) and `https://HOST/OWNER/REPO/issues/N`, with any query and an optional anchor.
 * Credentials, explicit ports, other schemes and every other path are ordinary links. Whether a
 * host is served natively is the caller's decision.
 */
export function parseGitHubThreadUrl(value: string): GitHubThreadLink | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (!host) return null;
  const parts = url.pathname.split("/").slice(1);
  if (parts.at(-1) === "") parts.pop();
  if (parts.includes("")) return null;
  const [owner, repo, route, rawNumber, ...rest] = parts;
  if (!owner || !repo || !route || !rawNumber) return null;
  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo) || repo === "." || repo === "..")
    return null;
  if (!/^[1-9]\d{0,9}$/u.test(rawNumber)) return null;
  const number = Number(rawNumber);
  if (number > MAX_NUMBER) return null;
  const anchor = normalizeAnchor(url.hash);
  const ref: GitHubThreadRef = { host, owner, repo, number };
  if (route === "issues") {
    if (rest.length > 0) return null;
    return { ref, kind: "issue", reveal: { view: "overview", anchor } };
  }
  if (route !== "pull") return null;
  if (rest.length === 0) return { ref, kind: "pull_request", reveal: { view: "overview", anchor } };
  const [subroute, ...tail] = rest;
  if (subroute && PULL_FILES_ROUTES.has(subroute) && tail.length <= 1)
    return { ref, kind: "pull_request", reveal: { view: "files", anchor } };
  if (subroute === "checks" && tail.length === 0)
    return { ref, kind: "pull_request", reveal: { view: "overview", anchor: anchor ?? "checks" } };
  if (subroute && PULL_OVERVIEW_ROUTES.has(subroute) && tail.length <= 1)
    return { ref, kind: "pull_request", reveal: { view: "overview", anchor } };
  return null;
}

// ---------------------------------------------------------------------------------------------
// Read model. The Host projects GitHub's answer into these shapes; the renderer never sees raw
// GitHub payloads.

export interface GitHubActor {
  readonly login: string;
  readonly avatarUrl: string | null;
  readonly url: string | null;
  readonly isBot: boolean;
}

export interface GitHubLabel {
  readonly name: string;
  /** Six hex digits without `#`, as GitHub stores it. */
  readonly color: string;
  readonly description: string | null;
}

/** A compact reference to another thread, for linked issues, pull requests and mentions. */
export interface GitHubThreadSummary {
  readonly ref: GitHubThreadRef;
  readonly kind: GitHubThreadKind;
  readonly url: string;
  readonly title: string;
  readonly state: "open" | "closed" | "merged";
  readonly draft: boolean;
  /** Why a closed issue closed, when GitHub says. */
  readonly stateReason?: GitHubIssueStateReason | null;
}

export type GitHubIssueStateReason = "completed" | "not_planned" | "duplicate";

export type GitHubReviewState = "approved" | "changes_requested" | "commented" | "dismissed";

export interface GitHubReviewComment {
  readonly id: string;
  /** `discussion_r<databaseId>`. */
  readonly anchor: string;
  readonly author: GitHubActor | null;
  readonly body: string;
  readonly createdAt: string;
  readonly url: string;
  readonly path: string;
  /** Null when the comment no longer maps onto the current diff. */
  readonly line: number | null;
  readonly startLine: number | null;
  readonly side: "left" | "right";
  /** The diff hunk GitHub stored with the comment, ending at its line. */
  readonly diffHunk: string;
  readonly outdated: boolean;
  readonly resolved: boolean;
  /** The first comment of the thread this one replies to, when it is a reply. */
  readonly replyToId: string | null;
}

export type GitHubTimelineEvent =
  | { readonly type: "closed"; readonly reason: GitHubIssueStateReason | null }
  | { readonly type: "reopened" }
  | { readonly type: "merged"; readonly commitOid: string | null; readonly baseBranch: string }
  | { readonly type: "ready_for_review" }
  | { readonly type: "converted_to_draft" }
  | { readonly type: "review_requested"; readonly reviewer: string }
  | { readonly type: "review_request_removed"; readonly reviewer: string }
  | { readonly type: "labeled"; readonly label: GitHubLabel }
  | { readonly type: "unlabeled"; readonly label: GitHubLabel }
  | { readonly type: "assigned"; readonly assignee: string }
  | { readonly type: "unassigned"; readonly assignee: string }
  | { readonly type: "renamed"; readonly from: string; readonly to: string }
  | {
      readonly type: "head_force_pushed";
      readonly beforeOid: string | null;
      readonly afterOid: string | null;
    }
  | { readonly type: "base_changed"; readonly from: string | null; readonly to: string | null }
  | { readonly type: "cross_referenced"; readonly source: GitHubThreadSummary }
  | { readonly type: "auto_merge_enabled" }
  | { readonly type: "auto_merge_disabled" };

export type GitHubTimelineItem =
  | {
      readonly kind: "comment";
      readonly id: string;
      /** `issuecomment-<databaseId>`. */
      readonly anchor: string;
      readonly author: GitHubActor | null;
      readonly body: string;
      readonly createdAt: string;
      readonly edited: boolean;
      readonly url: string;
    }
  | {
      readonly kind: "review";
      readonly id: string;
      /** `pullrequestreview-<databaseId>`. */
      readonly anchor: string;
      readonly author: GitHubActor | null;
      readonly state: GitHubReviewState;
      readonly body: string;
      readonly submittedAt: string;
      readonly url: string;
      /** Inline comments submitted with this review, in thread order. */
      readonly comments: readonly GitHubReviewComment[];
    }
  | {
      readonly kind: "commit";
      readonly id: string;
      readonly oid: string;
      readonly headline: string;
      readonly author: GitHubActor | null;
      /** The committer's name when GitHub could not match the author to an account. */
      readonly authorName: string | null;
      readonly committedAt: string;
      readonly url: string;
    }
  | {
      readonly kind: "event";
      readonly id: string;
      readonly actor: GitHubActor | null;
      readonly createdAt: string;
      readonly event: GitHubTimelineEvent;
    };

export type GitHubCheckStatus =
  | "pending"
  | "action_required"
  | "failure"
  | "cancelled"
  | "success"
  | "skipped"
  | "neutral";

export interface GitHubCheck {
  readonly id: string;
  readonly name: string;
  /** The workflow a GitHub Actions check belongs to. */
  readonly workflow: string | null;
  readonly status: GitHubCheckStatus;
  readonly required: boolean;
  readonly description: string | null;
  readonly url: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export type GitHubReviewerState = GitHubReviewState | "pending";

export interface GitHubReviewer {
  /** A user login, or `org/team` for a team review request. */
  readonly name: string;
  readonly actor: GitHubActor | null;
  readonly state: GitHubReviewerState;
}

export type GitHubMergeMethod = "merge" | "squash" | "rebase";

export type GitHubMergeable = "mergeable" | "conflicting" | "unknown";

export type GitHubMergeState =
  | "clean"
  | "blocked"
  | "behind"
  | "dirty"
  | "draft"
  | "has_hooks"
  | "unstable"
  | "unknown";

export interface GitHubViewer {
  readonly login: string;
  readonly canComment: boolean;
  /** Close and reopen. */
  readonly canChangeState: boolean;
}

interface GitHubThreadDetailBase {
  /** Canonical identity as GitHub reports it, which can differ in case from the link. */
  readonly ref: GitHubThreadRef;
  readonly url: string;
  readonly title: string;
  /** GitHub Flavored Markdown. */
  readonly body: string;
  readonly author: GitHubActor | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly labels: readonly GitHubLabel[];
  readonly assignees: readonly GitHubActor[];
  /** Oldest first. */
  readonly timeline: readonly GitHubTimelineItem[];
  /** Older activity exists than the timeline holds. */
  readonly timelineTruncated: boolean;
  readonly locked: boolean;
  readonly observedAt: string;
}

export interface GitHubIssueDetail extends GitHubThreadDetailBase {
  readonly kind: "issue";
  readonly state: "open" | "closed";
  readonly stateReason: GitHubIssueStateReason | null;
  /** Pull requests that close this issue when merged. */
  readonly closingPullRequests: readonly GitHubThreadSummary[];
  readonly viewer: GitHubViewer;
}

export interface GitHubPullRequestDetail extends GitHubThreadDetailBase {
  readonly kind: "pull_request";
  readonly state: "open" | "closed" | "merged";
  readonly draft: boolean;
  readonly baseBranch: string;
  readonly headBranch: string;
  /** `owner/repo` of the head when it lives in another repository, such as a fork. */
  readonly headRepository: string | null;
  readonly headSha: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly commitCount: number;
  readonly mergedAt: string | null;
  readonly mergedBy: GitHubActor | null;
  readonly mergeable: GitHubMergeable;
  readonly mergeState: GitHubMergeState;
  readonly reviewDecision: "approved" | "changes_requested" | "review_required" | null;
  readonly reviewers: readonly GitHubReviewer[];
  /** Checks on the head commit. */
  readonly checks: readonly GitHubCheck[];
  readonly checksTruncated: boolean;
  readonly autoMerge: {
    readonly method: GitHubMergeMethod;
    readonly enabledBy: string | null;
  } | null;
  /** Issues this pull request closes when merged. */
  readonly closingIssues: readonly GitHubThreadSummary[];
  readonly viewer: GitHubViewer & {
    readonly canMerge: boolean;
    /** Mark ready for review and convert to draft. */
    readonly canChangeDraft: boolean;
    /** Methods the repository allows, the preferred one first. */
    readonly mergeMethods: readonly GitHubMergeMethod[];
  };
}

export type GitHubThreadDetail = GitHubIssueDetail | GitHubPullRequestDetail;

export type GitHubPullRequestFileStatus =
  | "added"
  | "removed"
  | "modified"
  | "renamed"
  | "copied"
  | "changed"
  | "unchanged";

export interface GitHubPullRequestFile {
  readonly path: string;
  readonly previousPath: string | null;
  readonly status: GitHubPullRequestFileStatus;
  readonly additions: number;
  readonly deletions: number;
  /** The file's unified hunks without headers; null for binary files and diffs GitHub withholds. */
  readonly patch: string | null;
}

export interface GitHubPullRequestFiles {
  readonly headSha: string;
  readonly files: readonly GitHubPullRequestFile[];
  /** The pull request changes more files than were read. */
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------------------------
// Outcomes

/**
 * Why a thread cannot be read or changed right now.
 *
 * - `not_connected`: no GitHub account is connected for the host in Settings → GitHub.
 * - `reconnect`: the connected account's credential stopped working or changed identity.
 * - `not_found`: GitHub has no such thread, or the account cannot see it.
 * - `rate_limited`: GitHub asked Nodex to wait; `retryAt` says until when when known.
 * - `team_space`: GitHub tabs read through the personal Space's account only.
 * - `failed`: the request failed for another reason, described by `message`.
 */
export type GitHubUnavailableReason =
  | "not_connected"
  | "reconnect"
  | "not_found"
  | "rate_limited"
  | "team_space"
  | "failed";

export interface GitHubUnavailable {
  readonly status: "unavailable";
  readonly reason: GitHubUnavailableReason;
  readonly message: string | null;
  readonly retryAt: string | null;
}

export type GitHubThreadReadResult =
  | { readonly status: "ready"; readonly detail: GitHubThreadDetail }
  | GitHubUnavailable;

export type GitHubPullRequestFilesResult =
  | { readonly status: "ready"; readonly files: GitHubPullRequestFiles }
  | GitHubUnavailable;

export const gitHubThreadCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("comment"), body: z.string().trim().min(1).max(65_536) }),
  z.strictObject({
    type: z.literal("merge"),
    method: z.enum(["merge", "squash", "rebase"]),
    /** GitHub refuses the merge when new commits arrived after the reader saw this head. */
    expectedHeadSha: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u),
  }),
  z.strictObject({
    type: z.literal("set_state"),
    state: z.enum(["open", "closed"]),
    reason: z.enum(["completed", "not_planned"]).optional(),
  }),
  z.strictObject({ type: z.literal("set_draft"), draft: z.boolean() }),
]);

export type GitHubThreadCommand = z.infer<typeof gitHubThreadCommandSchema>;

export type GitHubThreadCommandResult =
  | { readonly status: "applied"; readonly url: string | null }
  /** A merge was refused because the head moved since the reader saw it. */
  | { readonly status: "head_changed" }
  /** GitHub refused the change, for example a protected branch or a merge conflict. */
  | { readonly status: "rejected"; readonly message: string }
  | GitHubUnavailable;

// ---------------------------------------------------------------------------------------------
// Nodex work linked to a thread (Core-owned relations).

export type GitHubThreadLinkRole = "own_pr" | "origin" | "context" | "intake";

export interface GitHubThreadLinkedPage {
  readonly pageId: string;
  readonly title: string;
  readonly role: GitHubThreadLinkRole;
  readonly projectId: string | null;
  /** The Page's active chat, when it has one. */
  readonly activeChat: { readonly sessionId: string; readonly title: string } | null;
}

export interface GitHubThreadLinks {
  readonly pages: readonly GitHubThreadLinkedPage[];
}

// ---------------------------------------------------------------------------------------------
// Summaries: the title and state of many threads at once, for links that name them inline.

export const GITHUB_THREAD_SUMMARY_BATCH_LIMIT = 50;

export const gitHubThreadSummariesInputSchema = z
  .array(gitHubThreadRefSchema)
  .min(1)
  .max(GITHUB_THREAD_SUMMARY_BATCH_LIMIT);

export type GitHubThreadSummariesResult =
  | {
      readonly status: "ready";
      /** One entry per requested thread, keyed by `gitHubThreadKey`; null when GitHub has none. */
      readonly summaries: Readonly<Record<string, GitHubThreadSummary | null>>;
    }
  | GitHubUnavailable;
