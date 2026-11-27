import type { ComponentType } from "react";
import {
  IssueCompletedIcon,
  IssueNotPlannedIcon,
  IssueOpenIcon,
  PullRequestClosedIcon,
  PullRequestDraftIcon,
  PullRequestIcon,
  PullRequestMergedIcon,
  type CanonicalIconProps,
} from "@/components/shared/icons";
import type {
  GitHubIssueStateReason,
  GitHubThreadDetail,
  GitHubThreadKind,
  GitHubThreadSummary,
} from "../../../shared/github-thread";

/**
 * Where a thread stands, as one closed set. Every surface that shows a thread's state (the tab,
 * the header, linked threads, cross-references) derives its glyph and tone from this.
 */
export type GitHubThreadState =
  | "pull_open"
  | "pull_draft"
  | "pull_merged"
  | "pull_closed"
  | "issue_open"
  | "issue_completed"
  | "issue_not_planned"
  | "unknown_pull"
  | "unknown_issue";

export function gitHubThreadStateOf(
  detail: Pick<GitHubThreadDetail, "kind" | "state"> & {
    readonly draft?: boolean;
    readonly stateReason?: GitHubIssueStateReason | null;
  },
): GitHubThreadState {
  if (detail.kind === "pull_request") {
    if (detail.state === "merged") return "pull_merged";
    if (detail.state === "closed") return "pull_closed";
    return detail.draft ? "pull_draft" : "pull_open";
  }
  if (detail.state === "open") return "issue_open";
  return detail.stateReason === "not_planned" || detail.stateReason === "duplicate"
    ? "issue_not_planned"
    : "issue_completed";
}

export function gitHubThreadSummaryState(summary: GitHubThreadSummary): GitHubThreadState {
  return gitHubThreadStateOf(summary);
}

export function unknownGitHubThreadState(kind: GitHubThreadKind): GitHubThreadState {
  return kind === "pull_request" ? "unknown_pull" : "unknown_issue";
}

interface GitHubThreadStatePresentation {
  readonly Icon: ComponentType<CanonicalIconProps>;
  /** Text tone for the glyph; muted until the state is known. */
  readonly tone: string;
}

const PRESENTATION: Record<GitHubThreadState, GitHubThreadStatePresentation> = {
  pull_open: { Icon: PullRequestIcon, tone: "text-token-charts-green" },
  pull_draft: { Icon: PullRequestDraftIcon, tone: "text-token-description-foreground" },
  pull_merged: { Icon: PullRequestMergedIcon, tone: "text-token-charts-purple" },
  pull_closed: { Icon: PullRequestClosedIcon, tone: "text-token-charts-red" },
  issue_open: { Icon: IssueOpenIcon, tone: "text-token-charts-green" },
  issue_completed: { Icon: IssueCompletedIcon, tone: "text-token-charts-purple" },
  issue_not_planned: { Icon: IssueNotPlannedIcon, tone: "text-token-description-foreground" },
  unknown_pull: { Icon: PullRequestIcon, tone: "text-token-description-foreground" },
  unknown_issue: { Icon: IssueOpenIcon, tone: "text-token-description-foreground" },
};

export function gitHubThreadStatePresentation(
  state: GitHubThreadState,
): GitHubThreadStatePresentation {
  return PRESENTATION[state];
}

/** The thread's state glyph in its tone. */
export function GitHubThreadStateIcon({
  state,
  className = "icon-xs",
}: {
  readonly state: GitHubThreadState;
  readonly className?: string;
}) {
  const { Icon, tone } = PRESENTATION[state];
  return <Icon className={`${className} shrink-0 ${tone}`} aria-hidden />;
}
