import { z } from "zod";
import {
  gitHubThreadKey,
  type GitHubActor,
  type GitHubCheck,
  type GitHubCheckStatus,
  type GitHubIssueDetail,
  type GitHubIssueStateReason,
  type GitHubMergeMethod,
  type GitHubPullRequestDetail,
  type GitHubReviewComment,
  type GitHubReviewer,
  type GitHubReviewState,
  type GitHubThreadRef,
  type GitHubThreadSummary,
  type GitHubTimelineEvent,
  type GitHubTimelineItem,
} from "../../shared/github-thread";
import type { readGitHubThreadSummaries } from "./GitHubThreadDocuments";

const text = z.string();
const count = z.number().int().nonnegative();
const actor = z.object({
  login: text,
  avatarUrl: text.nullable(),
  url: text.nullable(),
  __typename: text,
});
const label = z.object({ name: text, color: text, description: text.nullable() });
const oid = z.object({ oid: text });
const namedRepository = z.object({ name: text, owner: z.object({ login: text }) });
const repositoryAccess = z.object({
  viewerPermission: text.nullable(),
  isArchived: z.boolean(),
  isLocked: z.boolean(),
});
const connection = <T extends z.ZodType>(node: T) =>
  z.object({ nodes: z.array(node.nullable()).nullable() });
const nodes = <T>(value: { nodes: readonly (T | null)[] | null } | null | undefined): T[] =>
  value?.nodes?.filter((node): node is T => node !== null) ?? [];

const state = z.enum(["OPEN", "CLOSED", "MERGED"]);
const summaryFields = z.object({ number: count, url: text, title: text });
const summary = summaryFields.extend({
  __typename: z.enum(["Issue", "PullRequest"]),
  state,
  isDraft: z.boolean().optional(),
  stateReason: text.nullable().optional(),
  repository: namedRepository,
});
const summaryNode = z
  .discriminatedUnion("__typename", [
    summaryFields.extend({
      __typename: z.literal("PullRequest"),
      pullState: state,
      isDraft: z.boolean(),
    }),
    summaryFields.extend({
      __typename: z.literal("Issue"),
      issueState: z.enum(["OPEN", "CLOSED"]),
      stateReason: text.nullable(),
    }),
  ])
  .nullable();
const summariesResponse = z.object({
  data: z.record(z.string(), namedRepository.catchall(z.unknown()).nullable()),
});

const reviewer = z.object({ combinedSlug: text.optional() }).extend(actor.partial().shape);
const inline = z.object({
  id: text,
  author: actor.nullable(),
  isMinimized: z.boolean(),
  body: text,
  createdAt: text,
  url: text,
  path: text,
  line: count.nullable(),
  startLine: count.nullable(),
  diffHunk: text,
  outdated: z.boolean(),
  replyTo: z.object({ id: text }).nullable(),
});
const reviewThread = z.object({
  diffSide: z.enum(["LEFT", "RIGHT"]),
  isOutdated: z.boolean(),
  isResolved: z.boolean(),
  comments: connection(z.object({ id: text })),
});
const comment = z.object({
  __typename: z.literal("IssueComment"),
  id: text,
  author: actor.nullable(),
  isMinimized: z.boolean(),
  body: text,
  createdAt: text,
  lastEditedAt: text.nullable(),
  url: text,
});
const review = z.object({
  __typename: z.literal("PullRequestReview"),
  id: text,
  author: actor.nullable(),
  isMinimized: z.boolean(),
  state: text,
  body: text,
  submittedAt: text.nullable(),
  url: text,
  comments: connection(inline),
});
const commit = z.object({
  __typename: z.literal("PullRequestCommit"),
  id: text,
  commit: oid.extend({
    messageHeadline: text,
    committedDate: text,
    url: text,
    author: z.object({ name: text.nullable(), user: actor.nullable() }).nullable(),
  }),
});

const event = z.object({ id: text, actor: actor.nullable(), createdAt: text });
const timelineEvent = z.discriminatedUnion("__typename", [
  event.extend({ __typename: z.literal("ClosedEvent"), stateReason: text.nullable() }),
  event.extend({
    __typename: z.enum([
      "ReopenedEvent",
      "ReadyForReviewEvent",
      "ConvertToDraftEvent",
      "AutoMergeEnabledEvent",
      "AutoMergeDisabledEvent",
      "AutoRebaseEnabledEvent",
      "AutoSquashEnabledEvent",
    ]),
  }),
  event.extend({
    __typename: z.literal("MergedEvent"),
    commit: oid.nullable(),
    mergeRefName: text,
  }),
  event.extend({
    __typename: z.enum(["ReviewRequestedEvent", "ReviewRequestRemovedEvent"]),
    requestedReviewer: reviewer.nullable(),
  }),
  event.extend({ __typename: z.enum(["LabeledEvent", "UnlabeledEvent"]), label }),
  event.extend({
    __typename: z.enum(["AssignedEvent", "UnassignedEvent"]),
    assignee: z.object({ login: text.optional() }).nullable(),
  }),
  event.extend({
    __typename: z.literal("RenamedTitleEvent"),
    previousTitle: text,
    currentTitle: text,
  }),
  event.extend({
    __typename: z.literal("HeadRefForcePushedEvent"),
    beforeCommit: oid.nullable(),
    afterCommit: oid.nullable(),
  }),
  event.extend({
    __typename: z.literal("BaseRefChangedEvent"),
    previousRefName: text.nullable(),
    currentRefName: text.nullable(),
  }),
  event.extend({ __typename: z.literal("CrossReferencedEvent"), source: summary.nullable() }),
]);
const activity = z.discriminatedUnion("__typename", [comment, review, commit, timelineEvent]);
const base = z.object({
  url: text,
  title: text,
  body: text,
  createdAt: text,
  updatedAt: text,
  closedAt: text.nullable(),
  locked: z.boolean(),
  state,
  viewerCanClose: z.boolean(),
  viewerCanReopen: z.boolean(),
  author: actor.nullable(),
  labels: connection(label).nullable(),
  assignees: connection(actor),
  timelineItems: connection(activity).extend({
    pageInfo: z.object({ hasPreviousPage: z.boolean() }),
  }),
});

const issue = base.extend({
  state: z.enum(["OPEN", "CLOSED"]),
  stateReason: text.nullable(),
  closedByPullRequestsReferences: connection(summary),
});
const check = z.discriminatedUnion("__typename", [
  z.object({
    __typename: z.literal("CheckRun"),
    id: text,
    name: text,
    title: text.nullable().optional(),
    status: text,
    conclusion: text.nullable(),
    detailsUrl: text.nullable(),
    startedAt: text.nullable(),
    completedAt: text.nullable(),
    isRequired: z.boolean().nullish(),
    checkSuite: z
      .object({
        workflowRun: z.object({ workflow: z.object({ name: text }) }).nullable(),
      })
      .nullable(),
  }),
  z.object({
    __typename: z.literal("StatusContext"),
    id: text,
    context: text,
    state: text,
    description: text.nullable(),
    targetUrl: text.nullable(),
    createdAt: text,
    isRequired: z.boolean().nullish(),
  }),
]);
const pullRequest = base.extend({
  isDraft: z.boolean(),
  viewerCanUpdate: z.boolean(),
  baseRefName: text,
  headRefName: text,
  headRefOid: text,
  isCrossRepository: z.boolean(),
  headRepository: z.object({ nameWithOwner: text }).nullable(),
  additions: count,
  deletions: count,
  changedFiles: count,
  mergedAt: text.nullable(),
  mergedBy: actor.nullable(),
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  mergeStateStatus: z.enum([
    "CLEAN",
    "BLOCKED",
    "BEHIND",
    "DIRTY",
    "DRAFT",
    "HAS_HOOKS",
    "UNSTABLE",
    "UNKNOWN",
  ]),
  reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullable(),
  autoMergeRequest: z
    .object({
      mergeMethod: z.enum(["MERGE", "SQUASH", "REBASE"]),
      enabledBy: z.object({ login: text }).nullable(),
    })
    .nullable(),
  closingIssuesReferences: connection(summary),
  reviewRequests: connection(z.object({ requestedReviewer: reviewer.nullable() })).nullable(),
  latestOpinionatedReviews: connection(
    z.object({
      author: actor.nullable(),
      state: text,
      isMinimized: z.boolean(),
    }),
  ).nullable(),
  reviewThreads: connection(reviewThread),
  commits: connection(
    z.object({
      commit: z.object({
        statusCheckRollup: z
          .object({
            contexts: connection(check).extend({
              pageInfo: z.object({ hasNextPage: z.boolean() }),
            }),
          })
          .nullable(),
      }),
    }),
  ).extend({ totalCount: count }),
});

export const identityResponse = z.object({
  data: z.object({
    repository: namedRepository
      .extend({
        issueOrPullRequest: z
          .object({ __typename: z.enum(["Issue", "PullRequest"]), id: text })
          .nullable(),
      })
      .nullable(),
  }),
});
export const issueResponse = z.object({
  data: z.object({ repository: repositoryAccess.extend({ issue: issue.nullable() }).nullable() }),
});
export const pullRequestResponse = z.object({
  data: z.object({
    repository: repositoryAccess
      .extend({
        mergeCommitAllowed: z.boolean(),
        squashMergeAllowed: z.boolean(),
        rebaseMergeAllowed: z.boolean(),
        viewerDefaultMergeMethod: text.nullable(),
        pullRequest: pullRequest.nullable(),
      })
      .nullable(),
  }),
});

export function canonicalRef(
  ref: GitHubThreadRef,
  repository: z.infer<typeof namedRepository>,
): GitHubThreadRef {
  return { ...ref, owner: repository.owner.login, repo: repository.name };
}

function mapActor(value: z.infer<typeof actor> | null | undefined): GitHubActor | null {
  if (!value) return null;
  return {
    login: value.login,
    avatarUrl: value.avatarUrl,
    url: value.url,
    isBot: value.__typename === "Bot",
  };
}

function mapSummary(host: string, value: z.infer<typeof summary>): GitHubThreadSummary {
  return {
    ref: {
      host,
      owner: value.repository.owner.login,
      repo: value.repository.name,
      number: value.number,
    },
    kind: value.__typename === "Issue" ? "issue" : "pull_request",
    url: value.url,
    title: value.title,
    state: lower(value.state),
    draft: value.isDraft ?? false,
    ...(value.stateReason !== undefined && { stateReason: issueReason(value.stateReason) }),
  };
}

export function projectThreadSummaries(
  body: unknown,
  repositories: ReturnType<typeof readGitHubThreadSummaries>["repositories"],
): Record<string, GitHubThreadSummary | null> {
  const { data } = summariesResponse.parse(body);
  return Object.fromEntries(
    repositories.flatMap(({ alias, refs }) => {
      const repository = data[alias];
      if (repository === undefined) throw new Error("Missing GitHub repository field");
      return refs.map((ref, index): [string, GitHubThreadSummary | null] => {
        const key = gitHubThreadKey(ref);
        const node = repository === null ? null : summaryNode.parse(repository[`t${index}`]);
        if (node === null || repository === null) return [key, null];
        const summary =
          node.__typename === "Issue"
            ? { ...node, state: node.issueState }
            : { ...node, state: node.pullState };
        return [key, mapSummary(ref.host, { ...summary, repository })];
      });
    }),
  );
}

function lower<S extends string>(value: S): Lowercase<S> {
  return value.toLowerCase() as Lowercase<S>;
}

function issueReason(reason: string | null): GitHubIssueStateReason | null {
  if (reason === "COMPLETED" || reason === "NOT_PLANNED" || reason === "DUPLICATE")
    return lower(reason);
  return null;
}

function reviewState(value: string): GitHubReviewState | null {
  switch (value) {
    case "APPROVED":
    case "CHANGES_REQUESTED":
    case "COMMENTED":
    case "DISMISSED":
      return lower(value);
    default:
      return null;
  }
}

function reviewerName(value: z.infer<typeof reviewer> | null) {
  return value?.combinedSlug ?? value?.login ?? null;
}

/** GitHub's permalinks carry the actual anchor, including IDs beyond GraphQL's Int range. */
function anchor(url: string): string {
  const hash = url.split("#")[1] ?? "";
  return /^r\d+$/u.test(hash) ? `discussion_${hash}` : hash;
}

function projectEvent(
  host: string,
  node: z.infer<typeof timelineEvent>,
): GitHubTimelineEvent | null {
  switch (node.__typename) {
    case "ClosedEvent":
      return { type: "closed", reason: issueReason(node.stateReason) };
    case "ReopenedEvent":
      return { type: "reopened" };
    case "MergedEvent":
      return { type: "merged", commitOid: node.commit?.oid ?? null, baseBranch: node.mergeRefName };
    case "ReadyForReviewEvent":
      return { type: "ready_for_review" };
    case "ConvertToDraftEvent":
      return { type: "converted_to_draft" };
    case "ReviewRequestedEvent":
    case "ReviewRequestRemovedEvent": {
      const name = reviewerName(node.requestedReviewer);
      return name
        ? {
            type:
              node.__typename === "ReviewRequestedEvent"
                ? "review_requested"
                : "review_request_removed",
            reviewer: name,
          }
        : null;
    }
    case "LabeledEvent":
      return { type: "labeled", label: node.label };
    case "UnlabeledEvent":
      return { type: "unlabeled", label: node.label };
    case "AssignedEvent":
    case "UnassignedEvent":
      return node.assignee?.login
        ? {
            type: node.__typename === "AssignedEvent" ? "assigned" : "unassigned",
            assignee: node.assignee.login,
          }
        : null;
    case "RenamedTitleEvent":
      return { type: "renamed", from: node.previousTitle, to: node.currentTitle };
    case "HeadRefForcePushedEvent":
      return {
        type: "head_force_pushed",
        beforeOid: node.beforeCommit?.oid ?? null,
        afterOid: node.afterCommit?.oid ?? null,
      };
    case "BaseRefChangedEvent":
      return { type: "base_changed", from: node.previousRefName, to: node.currentRefName };
    case "CrossReferencedEvent":
      return node.source
        ? { type: "cross_referenced", source: mapSummary(host, node.source) }
        : null;
    case "AutoMergeEnabledEvent":
    case "AutoRebaseEnabledEvent":
    case "AutoSquashEnabledEvent":
      return { type: "auto_merge_enabled" };
    case "AutoMergeDisabledEvent":
      return { type: "auto_merge_disabled" };
  }
}

function projectInline(
  node: z.infer<typeof inline>,
  threads: ReadonlyMap<string, z.infer<typeof reviewThread>>,
): GitHubReviewComment {
  const thread = threads.get(node.replyTo?.id ?? node.id);
  const outdated = node.outdated || (thread?.isOutdated ?? false);
  return {
    id: node.id,
    anchor: anchor(node.url),
    author: mapActor(node.author),
    body: node.body,
    createdAt: node.createdAt,
    url: node.url,
    path: node.path,
    line: outdated ? null : node.line,
    startLine: outdated ? null : node.startLine,
    side: thread?.diffSide === "LEFT" ? "left" : "right",
    diffHunk: node.diffHunk,
    outdated,
    resolved: thread?.isResolved ?? false,
    replyToId: node.replyTo?.id ?? null,
  };
}

function projectTimeline(
  host: string,
  value: z.infer<typeof base>["timelineItems"],
  threads: ReadonlyMap<string, z.infer<typeof reviewThread>> = new Map(),
): GitHubTimelineItem[] {
  return nodes(value).flatMap((node): GitHubTimelineItem[] => {
    switch (node.__typename) {
      case "IssueComment":
        if (node.isMinimized) return [];
        return [
          {
            kind: "comment",
            id: node.id,
            anchor: anchor(node.url),
            author: mapActor(node.author),
            body: node.body,
            createdAt: node.createdAt,
            edited: node.lastEditedAt !== null,
            url: node.url,
          },
        ];
      case "PullRequestReview": {
        const state = reviewState(node.state);
        if (node.isMinimized || !state || !node.submittedAt) return [];
        return [
          {
            kind: "review",
            id: node.id,
            anchor: anchor(node.url),
            author: mapActor(node.author),
            state,
            body: node.body,
            submittedAt: node.submittedAt,
            url: node.url,
            comments: nodes(node.comments)
              .filter((comment) => !comment.isMinimized)
              .map((comment) => projectInline(comment, threads)),
          },
        ];
      }
      case "PullRequestCommit":
        return [
          {
            kind: "commit",
            id: node.id,
            oid: node.commit.oid,
            headline: node.commit.messageHeadline,
            author: mapActor(node.commit.author?.user),
            authorName: node.commit.author?.user ? null : (node.commit.author?.name ?? null),
            committedAt: node.commit.committedDate,
            url: node.commit.url,
          },
        ];
      default: {
        const event = projectEvent(host, node);
        return event
          ? [
              {
                kind: "event",
                id: node.id,
                actor: mapActor(node.actor),
                createdAt: node.createdAt,
                event,
              },
            ]
          : [];
      }
    }
  });
}

function projectBase(
  thread: z.infer<typeof base>,
  repository: z.infer<typeof repositoryAccess>,
  ref: GitHubThreadRef,
  login: string,
  observedAt: string,
  threads?: ReadonlyMap<string, z.infer<typeof reviewThread>>,
) {
  const canWrite =
    repository.viewerPermission === "WRITE" ||
    repository.viewerPermission === "MAINTAIN" ||
    repository.viewerPermission === "ADMIN";
  const writable = !repository.isArchived && !repository.isLocked;
  return {
    ref,
    url: thread.url,
    title: thread.title,
    body: thread.body,
    author: mapActor(thread.author),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    closedAt: thread.closedAt,
    labels: nodes(thread.labels),
    assignees: nodes(thread.assignees).flatMap((value) => mapActor(value) ?? []),
    timeline: projectTimeline(ref.host, thread.timelineItems, threads),
    timelineTruncated: thread.timelineItems.pageInfo.hasPreviousPage,
    locked: thread.locked,
    observedAt,
    viewer: {
      login,
      canComment: writable && (!thread.locked || canWrite),
      canChangeState:
        writable && (thread.state === "OPEN" ? thread.viewerCanClose : thread.viewerCanReopen),
    },
  };
}

export function projectIssue(
  repository: NonNullable<z.infer<typeof issueResponse>["data"]["repository"]>,
  value: z.infer<typeof issue>,
  ref: GitHubThreadRef,
  login: string,
  observedAt: string,
): GitHubIssueDetail {
  return {
    ...projectBase(value, repository, ref, login, observedAt),
    kind: "issue",
    state: lower(value.state),
    stateReason: issueReason(value.stateReason),
    closingPullRequests: nodes(value.closedByPullRequestsReferences).map((item) =>
      mapSummary(ref.host, item),
    ),
  };
}

function checkStatus(value: string | null): GitHubCheckStatus {
  switch (value) {
    case "ACTION_REQUIRED":
    case "STALE":
      return "action_required";
    case "ERROR":
    case "FAILURE":
    case "TIMED_OUT":
    case "STARTUP_FAILURE":
      return "failure";
    case "CANCELLED":
    case "SUCCESS":
    case "SKIPPED":
    case "NEUTRAL":
      return lower(value);
    default:
      return "pending";
  }
}

function projectCheck(value: z.infer<typeof check>): GitHubCheck {
  const required = value.isRequired ?? false;
  if (value.__typename === "StatusContext") {
    const status = checkStatus(value.state);
    return {
      id: value.id,
      name: value.context,
      status,
      required,
      workflow: null,
      description: value.description,
      url: value.targetUrl,
      startedAt: null,
      completedAt: status === "pending" ? null : value.createdAt,
    };
  }
  return {
    id: value.id,
    name: value.name,
    status: value.status === "COMPLETED" ? checkStatus(value.conclusion) : "pending",
    required,
    workflow: value.checkSuite?.workflowRun?.workflow.name ?? null,
    description: value.title ?? null,
    url: value.detailsUrl,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
  };
}

function projectReviewers(value: z.infer<typeof pullRequest>): GitHubReviewer[] {
  const reviewers = new Map<string, GitHubReviewer>();
  for (const review of nodes(value.latestOpinionatedReviews)) {
    const state = reviewState(review.state);
    const author = mapActor(review.author);
    if (review.isMinimized || !state || !author) continue;
    reviewers.set(lower(author.login), { name: author.login, actor: author, state });
  }
  for (const { requestedReviewer: requested } of nodes(value.reviewRequests)) {
    const name = reviewerName(requested);
    if (!name) continue;
    const actor = requested?.login
      ? {
          login: requested.login,
          avatarUrl: requested.avatarUrl ?? null,
          url: requested.url ?? null,
          isBot: requested.__typename === "Bot",
        }
      : null;
    reviewers.set(lower(name), { name, actor, state: "pending" });
  }
  return [...reviewers.values()];
}

export function projectPullRequest(
  repository: NonNullable<z.infer<typeof pullRequestResponse>["data"]["repository"]>,
  value: z.infer<typeof pullRequest>,
  ref: GitHubThreadRef,
  login: string,
  observedAt: string,
): GitHubPullRequestDetail {
  const threads = new Map(
    nodes(value.reviewThreads).flatMap((thread) => {
      const root = nodes(thread.comments)[0];
      return root ? [[root.id, thread] as const] : [];
    }),
  );
  const contexts = nodes(value.commits)[0]?.commit.statusCheckRollup?.contexts;
  const mergeMethods: GitHubMergeMethod[] = [];
  if (repository.mergeCommitAllowed) mergeMethods.push("merge");
  if (repository.squashMergeAllowed) mergeMethods.push("squash");
  if (repository.rebaseMergeAllowed) mergeMethods.push("rebase");
  const preferred = repository.viewerDefaultMergeMethod?.toLowerCase();
  mergeMethods.sort((a, b) => Number(b === preferred) - Number(a === preferred));
  const base = projectBase(value, repository, ref, login, observedAt, threads);
  const autoMerge = value.autoMergeRequest;
  const canUpdate = value.state === "OPEN" && !repository.isArchived && !repository.isLocked;
  return {
    ...base,
    kind: "pull_request",
    state: lower(value.state),
    draft: value.isDraft,
    baseBranch: value.baseRefName,
    headBranch: value.headRefName,
    headSha: value.headRefOid,
    headRepository: value.isCrossRepository ? (value.headRepository?.nameWithOwner ?? null) : null,
    additions: value.additions,
    deletions: value.deletions,
    changedFiles: value.changedFiles,
    commitCount: value.commits.totalCount,
    mergedAt: value.mergedAt,
    mergedBy: mapActor(value.mergedBy),
    mergeable: lower(value.mergeable),
    mergeState: lower(value.mergeStateStatus),
    reviewDecision: value.reviewDecision && lower(value.reviewDecision),
    reviewers: projectReviewers(value),
    checks: nodes(contexts).map(projectCheck),
    checksTruncated: contexts?.pageInfo.hasNextPage ?? false,
    autoMerge: autoMerge
      ? { method: lower(autoMerge.mergeMethod), enabledBy: autoMerge.enabledBy?.login ?? null }
      : null,
    closingIssues: nodes(value.closingIssuesReferences).map((item) => mapSummary(ref.host, item)),
    viewer: {
      ...base.viewer,
      canMerge:
        canUpdate &&
        !value.isDraft &&
        mergeMethods.length > 0 &&
        ["WRITE", "MAINTAIN", "ADMIN"].includes(repository.viewerPermission ?? ""),
      canChangeDraft: canUpdate && value.viewerCanUpdate,
      mergeMethods,
    },
  };
}
