const variables = "$owner: String!, $repo: String!, $number: Int!";
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

const actor = "login avatarUrl url __typename";
const label = "name color description";
const common = `
  url title body createdAt updatedAt closedAt locked state
  viewerCanClose viewerCanReopen
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
  ... on IssueComment { id author { ${actor} } isMinimized body createdAt lastEditedAt url }
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
    id author { ${actor} } isMinimized state body submittedAt url
    comments(first: 100) {
      nodes {
        id author { ${actor} } isMinimized body createdAt url
        path line startLine diffHunk outdated replyTo { id }
      }
    }
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
    query NodexPullRequest(${variables}) {
      ${repository} {
        ${repositoryAccess}
        mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed viewerDefaultMergeMethod
        pullRequest(number: $number) {
          ${common}
          isDraft viewerCanUpdate
          baseRefName headRefName headRefOid isCrossRepository headRepository { nameWithOwner }
          additions deletions changedFiles mergedAt mergedBy { ${actor} }
          mergeable mergeStateStatus reviewDecision
          autoMergeRequest { mergeMethod enabledBy { login } }
          closingIssuesReferences(first: 100) { nodes { ...ThreadSummary } }
          reviewRequests(first: 100) { nodes { requestedReviewer { ${reviewer} } } }
          latestOpinionatedReviews(first: 100) {
            nodes { author { ${actor} } state isMinimized }
          }
          reviewThreads(first: 100) {
            nodes {
              diffSide isOutdated isResolved
              comments(first: 1) { nodes { id } }
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
