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

/** GitHub's eight reactions, in the order GitHub shows them. */
export const GITHUB_REACTIONS = [
  "thumbs_up",
  "thumbs_down",
  "laugh",
  "hooray",
  "confused",
  "heart",
  "rocket",
  "eyes",
] as const;

export type GitHubReactionContent = (typeof GITHUB_REACTIONS)[number];

export interface GitHubReaction {
  readonly content: GitHubReactionContent;
  readonly count: number;
  readonly viewerReacted: boolean;
}

/** The reactions on one thing people can react to: a description, comment or review. */
export interface GitHubReactions {
  /** The GraphQL node the reactions belong to. */
  readonly subjectId: string;
  /** Only reactions someone chose, in `GITHUB_REACTIONS` order. */
  readonly groups: readonly GitHubReaction[];
  readonly viewerCanReact: boolean;
}

export type GitHubDiffSide = "left" | "right";

export interface GitHubReviewComment {
  /** GraphQL node id. */
  readonly id: string;
  /** `discussion_r<databaseId>`. */
  readonly anchor: string;
  /** The review the comment was written in; a reply can belong to a later review. */
  readonly reviewId: string | null;
  readonly author: GitHubActor | null;
  readonly body: string;
  readonly createdAt: string;
  readonly edited: boolean;
  readonly url: string;
  /** Part of the viewer's unsubmitted review: only the viewer sees it. */
  readonly pending: boolean;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
  /** Null for pending comments, which nobody can react to yet. */
  readonly reactions: GitHubReactions | null;
}

/**
 * A conversation on lines of the change (or on a whole file), with its replies.
 *
 * `line`/`startLine` place it in the current diff and are null once the code it discussed
 * changed (`outdated`); `originalLine`/`originalStartLine` place it in the diff it was written
 * on, which `diffHunk` shows.
 */
export interface GitHubReviewThread {
  /** GraphQL node id, which replies and resolution address. */
  readonly id: string;
  readonly path: string;
  readonly subject: "line" | "file";
  readonly side: GitHubDiffSide;
  readonly startSide: GitHubDiffSide | null;
  readonly line: number | null;
  readonly startLine: number | null;
  readonly originalLine: number | null;
  readonly originalStartLine: number | null;
  /** The diff hunk GitHub stored with the first comment, ending at its line. */
  readonly diffHunk: string;
  readonly outdated: boolean;
  readonly resolved: boolean;
  readonly canReply: boolean;
  readonly canResolve: boolean;
  readonly canUnresolve: boolean;
  /** Oldest first; the first comment opened the thread. */
  readonly comments: readonly GitHubReviewComment[];
  /** The thread holds more replies than were read. */
  readonly commentsTruncated: boolean;
}

/** The viewer's own review, started and not yet submitted. Only the viewer sees it. */
export interface GitHubPendingReview {
  readonly id: string;
  /** The head the review was started on; comments anchor to that revision. */
  readonly commitSha: string | null;
  readonly body: string;
  readonly commentCount: number;
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
      readonly canEdit: boolean;
      readonly canDelete: boolean;
      readonly reactions: GitHubReactions;
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
      /** The review's own words can be changed; a submitted review cannot be deleted. */
      readonly canEdit: boolean;
      readonly reactions: GitHubReactions;
      /** Ids of the `reviewThreads` this review opened, in the order GitHub lists them. */
      readonly threadIds: readonly string[];
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
  /** Change the title and description. */
  readonly canEdit: boolean;
}

interface GitHubThreadDetailBase {
  /** Canonical identity as GitHub reports it, which can differ in case from the link. */
  readonly ref: GitHubThreadRef;
  readonly url: string;
  readonly title: string;
  /** GitHub Flavored Markdown. */
  readonly body: string;
  /** Reactions on the description. */
  readonly reactions: GitHubReactions;
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
  /** Waiting in the base branch's merge queue. */
  readonly mergeQueued: boolean;
  /** Every review conversation on the change, including the viewer's pending comments. */
  readonly reviewThreads: readonly GitHubReviewThread[];
  /** The change holds more review threads than were read. */
  readonly reviewThreadsTruncated: boolean;
  readonly pendingReview: GitHubPendingReview | null;
  /** Issues this pull request closes when merged. */
  readonly closingIssues: readonly GitHubThreadSummary[];
  readonly viewer: GitHubViewer & {
    readonly canMerge: boolean;
    /** Mark ready for review and convert to draft. */
    readonly canChangeDraft: boolean;
    /** Methods the repository allows, the preferred one first. */
    readonly mergeMethods: readonly GitHubMergeMethod[];
    /** Approve or request changes; GitHub never lets a pull request's author do either. */
    readonly canApprove: boolean;
    readonly canEnableAutoMerge: boolean;
    readonly canDisableAutoMerge: boolean;
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

/**
 * The viewer's mark on a changed file, kept by GitHub. `dismissed` means the file changed after
 * the viewer marked it viewed.
 */
export type GitHubFileViewedState = "viewed" | "unviewed" | "dismissed";

export interface GitHubPullRequestFile {
  readonly path: string;
  readonly previousPath: string | null;
  readonly status: GitHubPullRequestFileStatus;
  readonly additions: number;
  readonly deletions: number;
  /** The file's unified hunks without headers; null for binary files and diffs GitHub withholds. */
  readonly patch: string | null;
  readonly viewed: GitHubFileViewedState;
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

const commitSha = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u);
const nodeId = z.string().trim().min(1).max(200);
const markdownBody = z.string().trim().min(1).max(65_536);
const diffSide = z.enum(["left", "right"]);
const mergeMethod = z.enum(["merge", "squash", "rebase"]);

/**
 * Where a new line comment or reply goes.
 *
 * - `publish`: posted at once, visible to everyone.
 * - `start_review`: opens the viewer's pending review with this comment.
 * - `pending_review`: joins the viewer's pending review `reviewId`, which GitHub must still hold.
 *
 * While the viewer has a pending review, GitHub takes their new comments only into it.
 */
export const gitHubReviewDeliverySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("publish") }),
  z.strictObject({ kind: z.literal("start_review") }),
  z.strictObject({ kind: z.literal("pending_review"), reviewId: nodeId }),
]);
export type GitHubReviewDelivery = z.infer<typeof gitHubReviewDeliverySchema>;

export const gitHubThreadCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("comment"), body: markdownBody }),
  z.strictObject({
    type: z.literal("merge"),
    method: mergeMethod,
    /** GitHub refuses the merge when new commits arrived after the reader saw this head. */
    expectedHeadSha: commitSha,
  }),
  z.strictObject({
    type: z.literal("set_state"),
    state: z.enum(["open", "closed"]),
    reason: z.enum(["completed", "not_planned"]).optional(),
  }),
  z.strictObject({ type: z.literal("set_draft"), draft: z.boolean() }),
  /** The issue's or pull request's own title or description. */
  z
    .strictObject({
      type: z.literal("edit"),
      title: z.string().trim().min(1).max(1024).optional(),
      body: z.string().max(65_536).optional(),
    })
    .refine((command) => command.title !== undefined || command.body !== undefined),
  z.strictObject({
    type: z.literal("edit_comment"),
    target: z.strictObject({
      kind: z.enum(["issue_comment", "review", "review_comment"]),
      id: nodeId,
    }),
    body: z.string().max(65_536),
  }),
  z.strictObject({
    type: z.literal("delete_comment"),
    target: z.strictObject({ kind: z.enum(["issue_comment", "review_comment"]), id: nodeId }),
  }),
  z.strictObject({
    type: z.literal("react"),
    subjectId: nodeId,
    content: z.enum(GITHUB_REACTIONS),
    /** Whether the viewer's reaction should exist afterwards. */
    reacted: z.boolean(),
  }),
  /** A new conversation on a line, a range of lines, or (without `line`) a whole file. */
  z
    .strictObject({
      type: z.literal("add_review_comment"),
      path: z.string().min(1).max(4096),
      side: diffSide,
      line: z.number().int().min(1).nullable(),
      startSide: diffSide.optional(),
      startLine: z.number().int().min(1).optional(),
      body: markdownBody,
      /** The head the commenter saw; GitHub anchors the comment to it. */
      expectedHeadSha: commitSha,
      delivery: gitHubReviewDeliverySchema,
    })
    .refine(
      (command) =>
        command.startLine === undefined ||
        (command.line !== null &&
          command.startSide !== undefined &&
          (command.startSide !== command.side || command.startLine < command.line)),
    ),
  z.strictObject({
    type: z.literal("reply"),
    threadId: nodeId,
    body: markdownBody,
    /** `start_review` is not offered for replies: a reply joins or skips a pending review. */
    delivery: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("publish") }),
      z.strictObject({ kind: z.literal("pending_review"), reviewId: nodeId }),
    ]),
  }),
  z.strictObject({ type: z.literal("resolve_thread"), threadId: nodeId, resolved: z.boolean() }),
  /**
   * Submits a review: the viewer's pending review when `pendingReviewId` names it, a review of
   * `expectedHeadSha` with only `body` otherwise.
   */
  z.strictObject({
    type: z.literal("submit_review"),
    event: z.enum(["comment", "approve", "request_changes"]),
    body: z.string().max(65_536),
    expectedHeadSha: commitSha,
    pendingReviewId: nodeId.nullable(),
  }),
  z.strictObject({ type: z.literal("discard_review"), pendingReviewId: nodeId }),
  z.strictObject({
    type: z.literal("enable_auto_merge"),
    method: mergeMethod,
    expectedHeadSha: commitSha,
  }),
  z.strictObject({ type: z.literal("disable_auto_merge") }),
  z.strictObject({
    type: z.literal("set_file_viewed"),
    path: z.string().min(1).max(4096),
    viewed: z.boolean(),
  }),
]);

export type GitHubThreadCommand = z.infer<typeof gitHubThreadCommandSchema>;

export type GitHubThreadCommandResult =
  | { readonly status: "applied"; readonly url: string | null }
  /** The head moved since the reader saw it: a merge, review or line comment did not apply. */
  | { readonly status: "head_changed" }
  /** The viewer's pending review was submitted, discarded or replaced meanwhile. */
  | { readonly status: "review_changed" }
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
