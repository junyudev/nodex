import type { GitHubThreadRef } from "../../shared/github-thread";

const variables = "$owner: String!, $repo: String!, $number: Int!";
const reviewVariables = `${variables}, $login: String!`;
const repository = "repository(owner: $owner, name: $repo)";
const repositoryIdentity = "name owner { login }";

export const resolveGitHubThread = `
  query NodexThreadIdentity(${variables}) {
    ${repository} {
      ${repositoryIdentity}
      issueOrPullRequest(number: $number) {
        __typename
        ... on Node { id }
      }
    }
  }
`;

export function readGitHubThreadSummaries(refs: readonly GitHubThreadRef[]) {
  const grouped = new Map<
    string,
    { alias: string; refs: [GitHubThreadRef, ...GitHubThreadRef[]] }
  >();
  for (const ref of refs) {
    const key = `${ref.owner}/${ref.repo}`;
    const group = grouped.get(key);
    if (group) group.refs.push(ref);
    else grouped.set(key, { alias: `r${grouped.size}`, refs: [ref] });
  }
  const repositories = [...grouped.values()];
  const variables: Record<string, string | number> = {};
  const declarations: string[] = [];
  const variable = (name: string, type: "String!" | "Int!", value: string | number) => {
    variables[name] = value;
    declarations.push(`$${name}: ${type}`);
    return `$${name}`;
  };
  const selections = repositories.map(({ alias, refs }) => {
    const [first] = refs;
    const owner = variable(`${alias}Owner`, "String!", first.owner);
    const repo = variable(`${alias}Repo`, "String!", first.repo);
    const threads = refs.map(
      ({ number }, index) => `
      t${index}: issueOrPullRequest(number: ${variable(`${alias}Number${index}`, "Int!", number)}) {
        __typename
        ... on PullRequest { number url title pullState: state isDraft }
        ... on Issue { number url title issueState: state stateReason(enableDuplicate: true) }
      }
    `,
    );
    return `
      ${alias}: repository(owner: ${owner}, name: ${repo}) {
        ${repositoryIdentity}
        ${threads.join("")}
      }
    `;
  });
  return {
    query: `query NodexThreadSummaries(${declarations.join(", ")}) { ${selections.join("")} }`,
    variables,
    repositories,
  };
}

const actor = "login avatarUrl url __typename";
const label = "name color description";
const reactions =
  "viewerCanReact reactionGroups { content viewerHasReacted reactors { totalCount } }";
const pendingReviews = (fields: string) =>
  `reviews(first: 1, author: $login, states: PENDING) { nodes { ${fields} } }`;
const common = `
  id url title body createdAt updatedAt closedAt locked state
  viewerCanClose viewerCanReopen viewerCanUpdate ${reactions}
  author { ${actor} }
  labels(first: 100) { nodes { ${label} } }
  assignees(first: 100) { nodes { ${actor} } }
`;
const repositoryAccess = "viewerPermission isArchived isLocked";
const threadSummary = `
  fragment ThreadSummary on ReferencedSubject {
    __typename
    ... on Issue { number url title state repository { ${repositoryIdentity} } }
    ... on PullRequest { number url title state isDraft repository { ${repositoryIdentity} } }
  }
`;
const commonTimelineTypes = `
  ISSUE_COMMENT, CLOSED_EVENT, REOPENED_EVENT, LABELED_EVENT, UNLABELED_EVENT,
  ASSIGNED_EVENT, UNASSIGNED_EVENT, RENAMED_TITLE_EVENT, CROSS_REFERENCED_EVENT
`;
const event = `id createdAt actor { ${actor} }`;
const commonTimeline = `
  __typename
  ... on IssueComment {
    id author { ${actor} } isMinimized body createdAt lastEditedAt url
    viewerCanUpdate viewerCanDelete ${reactions}
  }
  ... on ClosedEvent { ${event} stateReason }
  ... on ReopenedEvent { ${event} }
  ... on LabeledEvent { ${event} label { ${label} } }
  ... on UnlabeledEvent { ${event} label { ${label} } }
  ... on AssignedEvent { ${event} assignee { ... on Actor { login } } }
  ... on UnassignedEvent { ${event} assignee { ... on Actor { login } } }
  ... on RenamedTitleEvent { ${event} previousTitle currentTitle }
  ... on CrossReferencedEvent { ${event} source { ...ThreadSummary } }
`;

export const readGitHubIssue = `
  query NodexIssue(${variables}) {
    ${repository} {
      ${repositoryAccess}
      issue(number: $number) {
        ${common}
        stateReason(enableDuplicate: true)
        closedByPullRequestsReferences(first: 100, includeClosedPrs: true) {
          nodes { ...ThreadSummary }
        }
        timelineItems(last: 100, itemTypes: [${commonTimelineTypes}]) {
          pageInfo { hasPreviousPage }
          nodes { ${commonTimeline} }
        }
      }
    }
  }
  ${threadSummary}
`;

const prTimelineTypes = `
  PULL_REQUEST_REVIEW, PULL_REQUEST_COMMIT, MERGED_EVENT, READY_FOR_REVIEW_EVENT,
  CONVERT_TO_DRAFT_EVENT, REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT,
  HEAD_REF_FORCE_PUSHED_EVENT, BASE_REF_CHANGED_EVENT, AUTO_MERGE_ENABLED_EVENT,
  AUTO_MERGE_DISABLED_EVENT, AUTO_REBASE_ENABLED_EVENT, AUTO_SQUASH_ENABLED_EVENT
`;
const reviewer = `
  ... on Actor { ${actor} }
  ... on Team { combinedSlug }
`;
const prTimeline = `
  ... on PullRequestReview {
    id author { ${actor} } isMinimized state body submittedAt url viewerCanUpdate ${reactions}
  }
  ... on PullRequestCommit {
    id
    commit { oid messageHeadline committedDate url author { name user { ${actor} } } }
  }
  ... on MergedEvent { ${event} commit { oid } mergeRefName }
  ... on ReadyForReviewEvent { ${event} }
  ... on ConvertToDraftEvent { ${event} }
  ... on ReviewRequestedEvent { ${event} requestedReviewer { ${reviewer} } }
  ... on ReviewRequestRemovedEvent { ${event} requestedReviewer { ${reviewer} } }
  ... on HeadRefForcePushedEvent { ${event} beforeCommit { oid } afterCommit { oid } }
  ... on BaseRefChangedEvent { ${event} previousRefName currentRefName }
  ... on AutoMergeEnabledEvent { ${event} }
  ... on AutoMergeDisabledEvent { ${event} }
  ... on AutoRebaseEnabledEvent { ${event} }
  ... on AutoSquashEnabledEvent { ${event} }
`;

export const readGitHubPullRequest = (required: boolean) => {
  const requirement = required ? "isRequired(pullRequestNumber: $number)" : "";
  return `
    query NodexPullRequest(${reviewVariables}) {
      ${repository} {
        ${repositoryAccess}
        mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed viewerDefaultMergeMethod
        pullRequest(number: $number) {
          ${common}
          isDraft isInMergeQueue viewerCanEnableAutoMerge viewerCanDisableAutoMerge
          baseRefName headRefName headRefOid isCrossRepository headRepository { nameWithOwner }
          additions deletions changedFiles mergedAt mergedBy { ${actor} }
          mergeable mergeStateStatus reviewDecision
          autoMergeRequest { mergeMethod enabledBy { login } }
          closingIssuesReferences(first: 100) { nodes { ...ThreadSummary } }
          reviewRequests(first: 100) { nodes { requestedReviewer { ${reviewer} } } }
          latestOpinionatedReviews(first: 100) {
            nodes { author { ${actor} } state isMinimized }
          }
          ${pendingReviews("id body commit { oid } comments { totalCount }")}
          reviewThreads(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              id path subjectType line startLine originalLine originalStartLine
              diffSide startDiffSide isOutdated isResolved
              viewerCanReply viewerCanResolve viewerCanUnresolve
              comments(first: 100) {
                pageInfo { hasNextPage }
                nodes {
                  id databaseId author { ${actor} } body createdAt lastEditedAt url diffHunk state
                  pullRequestReview { id }
                  viewerCanUpdate viewerCanDelete ${reactions}
                }
              }
            }
          }
          commits(last: 1) {
            totalCount
            nodes {
              commit {
                statusCheckRollup {
                  contexts(first: 100) {
                    pageInfo { hasNextPage }
                    nodes {
                      __typename
                      ... on CheckRun {
                        id name title status conclusion detailsUrl startedAt completedAt ${requirement}
                        checkSuite { workflowRun { workflow { name } } }
                      }
                      ... on StatusContext {
                        id context state description targetUrl createdAt ${requirement}
                      }
                    }
                  }
                }
              }
            }
          }
          timelineItems(last: 100, itemTypes: [${commonTimelineTypes}, ${prTimelineTypes}]) {
            pageInfo { hasPreviousPage }
            nodes { ${commonTimeline} ${prTimeline} }
          }
        }
      }
    }
    ${threadSummary}
  `;
};

export const setGitHubPullRequestDraft = (draft: boolean) => {
  const field = draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
  return `
    mutation NodexSetDraft($id: ID!) {
      change: ${field}(input: { pullRequestId: $id }) { pullRequest { url } }
    }
  `;
};

export const readGitHubReviewContext = (includeThread: boolean) => `
  query NodexReviewContext(${reviewVariables}${includeThread ? ", $threadId: ID!" : ""}) {
    ${repository} {
      pullRequest(number: $number) {
        id headRefOid
        ${pendingReviews("id commit { oid }")}
      }
    }
    ${includeThread ? "node(id: $threadId) { ... on PullRequestReviewThread { pullRequest { id } } }" : ""}
  }
`;

export const readGitHubFileViews = `
  query NodexFileViews(${variables}, $cursor: String) {
    ${repository} {
      pullRequest(number: $number) {
        headRefOid baseRefOid
        files(first: 100, after: $cursor) {
          nodes { path viewerViewedState }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

function mutation(field: string, input: string, selection = "clientMutationId") {
  return `
    mutation NodexThreadMutation($input: ${input}!) {
      change: ${field}(input: $input) { ${selection} }
    }
  `;
}

export const gitHubThreadMutations = {
  editComment: {
    issue_comment: mutation("updateIssueComment", "UpdateIssueCommentInput"),
    review: mutation("updatePullRequestReview", "UpdatePullRequestReviewInput"),
    review_comment: mutation(
      "updatePullRequestReviewComment",
      "UpdatePullRequestReviewCommentInput",
    ),
  },
  deleteComment: {
    issue_comment: mutation("deleteIssueComment", "DeleteIssueCommentInput"),
    review_comment: mutation(
      "deletePullRequestReviewComment",
      "DeletePullRequestReviewCommentInput",
    ),
  },
  addReaction: mutation("addReaction", "AddReactionInput"),
  removeReaction: mutation("removeReaction", "RemoveReactionInput"),
  startReview: mutation(
    "addPullRequestReview",
    "AddPullRequestReviewInput",
    "pullRequestReview { id }",
  ),
  addThread: mutation("addPullRequestReviewThread", "AddPullRequestReviewThreadInput"),
  reply: mutation("addPullRequestReviewThreadReply", "AddPullRequestReviewThreadReplyInput"),
  resolve: mutation("resolveReviewThread", "ResolveReviewThreadInput"),
  unresolve: mutation("unresolveReviewThread", "UnresolveReviewThreadInput"),
  submitReview: mutation("submitPullRequestReview", "SubmitPullRequestReviewInput"),
  discardReview: mutation("deletePullRequestReview", "DeletePullRequestReviewInput"),
  enableAutoMerge: mutation("enablePullRequestAutoMerge", "EnablePullRequestAutoMergeInput"),
  disableAutoMerge: mutation("disablePullRequestAutoMerge", "DisablePullRequestAutoMergeInput"),
  markViewed: mutation("markFileAsViewed", "MarkFileAsViewedInput"),
  unmarkViewed: mutation("unmarkFileAsViewed", "UnmarkFileAsViewedInput"),
};
