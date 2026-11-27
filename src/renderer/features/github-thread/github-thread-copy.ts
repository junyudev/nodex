import type { IntlShape } from "@/lib/i18n";
import type {
  GitHubReviewerState,
  GitHubThreadKind,
  GitHubUnavailableReason,
} from "../../../shared/github-thread";
import type { GitHubCheckBucket, GitHubMergeReadiness } from "./github-thread-model";
import type { GitHubThreadState } from "./github-thread-state";

/** Product words for a thread's state, the label of its state chip. */
export function gitHubThreadStateLabel(intl: IntlShape, state: GitHubThreadState): string {
  return intl.formatMessage(
    {
      id: "githubThread.state.label",
      defaultMessage:
        "{state, select, pull_open {Open} pull_draft {Draft} pull_merged {Merged} pull_closed {Closed} issue_open {Open} issue_completed {Closed} issue_not_planned {Not planned} other {Loading}}",
    },
    { state },
  );
}

export function gitHubThreadKindLabel(intl: IntlShape, kind: GitHubThreadKind): string {
  return intl.formatMessage(
    {
      id: "githubThread.kind.label",
      defaultMessage: "{kind, select, pull_request {pull request} other {issue}}",
    },
    { kind },
  );
}

/** What the person can do next, said once. */
export function gitHubMergeReadinessLabel(
  intl: IntlShape,
  readiness: GitHubMergeReadiness,
): string | null {
  switch (readiness.kind) {
    case "merged":
    case "closed":
      return null;
    case "draft":
      return intl.formatMessage({
        id: "githubThread.readiness.draft",
        defaultMessage: "Still a draft",
      });
    case "conflicts":
      return intl.formatMessage({
        id: "githubThread.readiness.conflicts",
        defaultMessage: "Has conflicts with its base",
      });
    case "checks_failing":
      return intl.formatMessage(
        {
          id: "githubThread.readiness.checksFailing",
          defaultMessage: "{count, plural, one {# check failing} other {# checks failing}}",
        },
        { count: readiness.count },
      );
    case "changes_requested":
      return intl.formatMessage({
        id: "githubThread.readiness.changesRequested",
        defaultMessage: "Changes requested",
      });
    case "review_required":
      return intl.formatMessage({
        id: "githubThread.readiness.reviewRequired",
        defaultMessage: "Waiting for review",
      });
    case "checks_running":
      return intl.formatMessage(
        {
          id: "githubThread.readiness.checksRunning",
          defaultMessage: "{count, plural, one {# check running} other {# checks running}}",
        },
        { count: readiness.count },
      );
    case "behind":
      return intl.formatMessage({
        id: "githubThread.readiness.behind",
        defaultMessage: "Behind its base branch",
      });
    case "blocked":
      return intl.formatMessage({
        id: "githubThread.readiness.blocked",
        defaultMessage: "Blocked by branch rules",
      });
    case "checking":
      return intl.formatMessage({
        id: "githubThread.readiness.checking",
        defaultMessage: "Checking mergeability…",
      });
    case "ready":
      return intl.formatMessage({
        id: "githubThread.readiness.ready",
        defaultMessage: "Ready to merge",
      });
  }
}

export function gitHubChecksCountsLabel(
  intl: IntlShape,
  counts: Readonly<Record<GitHubCheckBucket, number>>,
): string {
  const parts = (["failing", "running", "passed", "skipped"] as const)
    .filter((bucket) => counts[bucket] > 0)
    .map((bucket) =>
      intl.formatMessage(
        {
          id: "githubThread.checks.count",
          defaultMessage:
            "{bucket, select, failing {{count} failing} running {{count} running} passed {{count} passed} other {{count} skipped}}",
        },
        { bucket, count: counts[bucket] },
      ),
    );
  return parts.join(" · ");
}

export function gitHubReviewerStateLabel(intl: IntlShape, state: GitHubReviewerState): string {
  return intl.formatMessage(
    {
      id: "githubThread.reviewer.state",
      defaultMessage:
        "{state, select, approved {Approved} changes_requested {Requested changes} commented {Commented} dismissed {Dismissed} other {Review requested}}",
    },
    { state },
  );
}

export function gitHubUnavailableTitle(intl: IntlShape, reason: GitHubUnavailableReason): string {
  return intl.formatMessage(
    {
      id: "githubThread.unavailable.title",
      defaultMessage:
        "{reason, select, not_connected {Connect GitHub to read this here} reconnect {Reconnect GitHub to read this here} not_found {This isn’t available} rate_limited {GitHub asked Nodex to wait} team_space {GitHub tabs read with your personal Space’s account} other {Couldn’t load this from GitHub}}",
    },
    { reason },
  );
}

export function gitHubUnavailableDescription(
  intl: IntlShape,
  reason: GitHubUnavailableReason,
  kind: GitHubThreadKind,
): string | null {
  switch (reason) {
    case "not_connected":
      return intl.formatMessage({
        id: "githubThread.unavailable.notConnected",
        defaultMessage:
          "Nodex reads issues and pull requests with the GitHub account you connect in Settings.",
      });
    case "reconnect":
      return intl.formatMessage({
        id: "githubThread.unavailable.reconnect",
        defaultMessage: "The connected GitHub account stopped working or changed.",
      });
    case "not_found":
      return intl.formatMessage(
        {
          id: "githubThread.unavailable.notFound",
          defaultMessage:
            "The {kind} may have been deleted, or the connected account can’t see it.",
        },
        { kind: gitHubThreadKindLabel(intl, kind) },
      );
    case "team_space":
      return intl.formatMessage({
        id: "githubThread.unavailable.teamSpace",
        defaultMessage: "Open it on GitHub from here, or from your personal Space.",
      });
    case "rate_limited":
    case "failed":
      return null;
  }
}
