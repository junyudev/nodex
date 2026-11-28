import { FormattedMessage, useIntl } from "@/lib/i18n";
import { useEffect, useId, useState, type ReactNode } from "react";
import {
  AssigneeIcon,
  BranchStatusIcon,
  ChevronDownIcon,
  CopyIcon,
  IssueOpenIcon,
  PageIcon,
  PullRequestIcon,
  SendToChatIcon,
  SuccessCircleIcon,
  TagsIcon,
  VisibilityIcon,
} from "@/components/shared/icons";
import { PersonCircleIcon } from "@/components/shared/icons/customize-action-icons";
import { PageStagePropertyRow } from "@/components/board/page-stage/property-row";
import { NodexReference } from "@/components/nodex-reference/nodex-reference";
import { NodexButton, NodexIconButton } from "@/components/ui/button";
import {
  NodexDropdownMenu,
  NodexDropdownRadioGroup,
  NodexDropdownRadioItem,
} from "@/components/ui/dropdown";
import { NodexTooltip } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/toast";
import { writeTextToClipboard } from "@/lib/clipboard";
import { getIntl } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type {
  GitHubCheck,
  GitHubIssueDetail,
  GitHubMergeMethod,
  GitHubPullRequestDetail,
  GitHubReviewer,
  GitHubThreadDetail,
  GitHubThreadLinks,
} from "../../../shared/github-thread";
import {
  gitHubChecksCountsLabel,
  gitHubMergeReadinessLabel,
  gitHubReviewerStateLabel,
  gitHubThreadStateLabel,
} from "./github-thread-copy";
import {
  checkLabel,
  gitHubCheckBucket,
  gitHubMergeDecision,
  summarizeGitHubChecks,
  type GitHubChatContextSubject,
  type GitHubCheckBucket,
} from "./github-thread-model";
import {
  GitHubActorName,
  GitHubAvatar,
  GitHubLabelChip,
  GitHubRelativeTime,
  GitHubThreadReferenceChip,
  useOpenOnGitHub,
} from "./github-thread-parts";
import {
  GitHubThreadStateIcon,
  gitHubThreadStateOf,
  gitHubThreadStatePresentation,
} from "./github-thread-state";
import type { GitHubThreadCommandRunner } from "./github-thread-surface-types";

interface PropertiesProps {
  readonly detail: GitHubThreadDetail;
  readonly links: GitHubThreadLinks | null;
  readonly run: GitHubThreadCommandRunner;
  readonly onShowFiles: () => void;
  readonly onAddToChat: ((subject: GitHubChatContextSubject) => void) | null;
  /** Unfold the checks once, as when a link pointed at them. */
  readonly revealChecks: boolean;
}

/** Where the thread stands, in the same label | value grammar as a Page's properties. */
export function GitHubThreadProperties(props: PropertiesProps) {
  const { detail } = props;
  return (
    <div className="flex flex-col pt-2" data-github-thread-properties="">
      <StatusRow {...props} />
      <AuthorRow detail={detail} />
      {detail.kind === "pull_request" ? (
        <>
          <BranchRow pr={detail} onShowFiles={props.onShowFiles} />
          {detail.checks.length > 0 ? (
            <ChecksRow
              pr={detail}
              revealChecks={props.revealChecks}
              onAddToChat={props.onAddToChat}
            />
          ) : null}
          {detail.reviewers.length > 0 ? <ReviewersRow reviewers={detail.reviewers} /> : null}
        </>
      ) : null}
      {detail.labels.length > 0 ? (
        <Row
          icon={<TagsIcon />}
          label={<FormattedMessage id="githubThread.properties.labels" defaultMessage="Labels" />}
        >
          <div className="flex min-w-0 flex-wrap items-center gap-1 py-1">
            {detail.labels.map((label) => (
              <GitHubLabelChip key={label.name} label={label} />
            ))}
          </div>
        </Row>
      ) : null}
      {detail.assignees.length > 0 ? (
        <Row
          icon={<AssigneeIcon />}
          label={
            <FormattedMessage id="githubThread.properties.assignees" defaultMessage="Assignees" />
          }
        >
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-1 text-sm">
            {detail.assignees.map((assignee) => (
              <GitHubActorName key={assignee.login} actor={assignee} />
            ))}
          </div>
        </Row>
      ) : null}
      <LinkedThreadsRow detail={detail} />
      {props.links && props.links.pages.length > 0 ? <WorkRow links={props.links} /> : null}
    </div>
  );
}

function Row({
  icon,
  label,
  children,
  className,
  disclosure,
}: {
  readonly icon: ReactNode;
  readonly label: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly disclosure?: Parameters<typeof PageStagePropertyRow>[0]["disclosure"];
}) {
  return (
    <PageStagePropertyRow icon={icon} label={label} className={className} disclosure={disclosure}>
      {children}
    </PageStagePropertyRow>
  );
}

/** The state in its color: categorical, so tinted. */
function StateChip({ detail }: { readonly detail: GitHubThreadDetail }) {
  const intl = useIntl();
  const state = gitHubThreadStateOf(detail);
  const { tone } = gitHubThreadStatePresentation(state);
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-current/10 pr-2 pl-1.5 text-xs font-medium",
        tone,
      )}
    >
      <GitHubThreadStateIcon state={state} className="icon-2xs" />
      {gitHubThreadStateLabel(intl, state)}
    </span>
  );
}

function StatusRow({ detail, run }: PropertiesProps) {
  const intl = useIntl();
  const label = <FormattedMessage id="githubThread.properties.status" defaultMessage="Status" />;
  if (detail.kind === "issue") return <IssueStatusRow issue={detail} label={label} />;
  const decision = gitHubMergeDecision(detail);
  const readiness = gitHubMergeReadinessLabel(intl, decision.readiness);
  return (
    <Row icon={<PullRequestIcon />} label={label}>
      <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
        <StateChip detail={detail} />
        {detail.state === "merged" && detail.mergedAt ? (
          <span className="flex min-w-0 items-center gap-1.5 text-token-description-foreground">
            {detail.mergedBy ? <GitHubActorName actor={detail.mergedBy} /> : null}
            <GitHubRelativeTime at={detail.mergedAt} />
          </span>
        ) : detail.state === "closed" && detail.closedAt ? (
          <GitHubRelativeTime at={detail.closedAt} />
        ) : readiness ? (
          <span className="min-w-0 truncate text-token-description-foreground">{readiness}</span>
        ) : null}
        {detail.state === "open" ? (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {detail.draft ? (
              <NodexButton
                size="toolbar"
                variant="secondary"
                disabled={!detail.viewer.canChangeDraft || run.pending}
                onClick={() => void run.run({ type: "set_draft", draft: false })}
              >
                <FormattedMessage
                  id="githubThread.actions.readyForReview"
                  defaultMessage="Ready for review"
                />
              </NodexButton>
            ) : detail.autoMerge ? (
              detail.viewer.canDisableAutoMerge ? (
                <NodexButton
                  size="toolbar"
                  variant="secondary"
                  disabled={run.pending}
                  onClick={() => void run.run({ type: "disable_auto_merge" })}
                >
                  <FormattedMessage
                    id="githubThread.merge.cancelAuto"
                    defaultMessage="Cancel auto-merge"
                  />
                </NodexButton>
              ) : null
            ) : detail.mergeQueued ? null : (
              <MergeButton pr={detail} canMerge={decision.canMerge} run={run} />
            )}
          </span>
        ) : null}
      </div>
    </Row>
  );
}

function IssueStatusRow({
  issue,
  label,
}: {
  readonly issue: GitHubIssueDetail;
  readonly label: ReactNode;
}) {
  return (
    <Row icon={<IssueOpenIcon />} label={label}>
      <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
        <StateChip detail={issue} />
        {issue.state === "closed" && issue.closedAt ? (
          <GitHubRelativeTime at={issue.closedAt} />
        ) : null}
      </div>
    </Row>
  );
}

const MERGE_CONFIRM_MS = 4000;

/**
 * Merging cannot be taken back, so the button asks once more in place: the first press arms it,
 * the second merges. While GitHub still waits on checks or reviews, it offers to merge when they
 * are met instead, which can be cancelled. The method stays a choice beside it.
 */
function MergeButton({
  pr,
  canMerge,
  run,
}: {
  readonly pr: GitHubPullRequestDetail;
  readonly canMerge: boolean;
  readonly run: GitHubThreadCommandRunner;
}) {
  const intl = useIntl();
  const methods = pr.viewer.mergeMethods;
  const [chosen, setChosen] = useState<GitHubMergeMethod | null>(null);
  const method = chosen && methods.includes(chosen) ? chosen : (methods[0] ?? "merge");
  const [armedAt, setArmedAt] = useState<number | null>(null);
  useEffect(() => {
    if (armedAt === null) return;
    const timeout = window.setTimeout(() => setArmedAt(null), MERGE_CONFIRM_MS);
    return () => window.clearTimeout(timeout);
  }, [armedAt]);
  const whenReady = !canMerge && pr.viewer.canEnableAutoMerge;
  if (!pr.viewer.canMerge || methods.length === 0) return null;
  const methodLabel = (value: GitHubMergeMethod) =>
    whenReady
      ? intl.formatMessage(
          {
            id: "githubThread.merge.whenReady",
            defaultMessage:
              "{method, select, squash {Squash when ready} rebase {Rebase when ready} other {Merge when ready}}",
          },
          { method: value },
        )
      : intl.formatMessage(
          {
            id: "githubThread.merge.method",
            defaultMessage:
              "{method, select, squash {Squash and merge} rebase {Rebase and merge} other {Merge}}",
          },
          { method: value },
        );
  const armed = armedAt !== null;
  const disabled = !(canMerge || whenReady) || run.pending;
  const press = () => {
    if (whenReady) {
      void run.run({ type: "enable_auto_merge", method, expectedHeadSha: pr.headSha });
      return;
    }
    if (!armed) {
      setArmedAt(Date.now());
      return;
    }
    setArmedAt(null);
    void run.run({ type: "merge", method, expectedHeadSha: pr.headSha });
  };
  const button = (
    <NodexButton
      size="toolbar"
      variant={armed ? "accentAction" : whenReady ? "secondary" : "primary"}
      disabled={disabled}
      className={cn(methods.length > 1 && "rounded-r-none")}
      onClick={press}
    >
      {armed
        ? intl.formatMessage(
            {
              id: "githubThread.merge.confirm",
              defaultMessage:
                "{method, select, squash {Confirm squash} rebase {Confirm rebase} other {Confirm merge}}",
            },
            { method },
          )
        : methodLabel(method)}
    </NodexButton>
  );
  return (
    <span className="flex items-center">
      {whenReady ? (
        <NodexTooltip
          tooltipContent={intl.formatMessage({
            id: "githubThread.merge.whenReadyTooltip",
            defaultMessage: "GitHub merges it once its checks and reviews are met",
          })}
          side="top"
        >
          <span className="inline-flex">{button}</span>
        </NodexTooltip>
      ) : (
        button
      )}
      {methods.length > 1 ? (
        <NodexDropdownMenu
          align="end"
          disabled={disabled}
          triggerButton={
            <NodexButton
              size="toolbar"
              variant={whenReady ? "secondary" : "primary"}
              disabled={disabled}
              aria-label={intl.formatMessage({
                id: "githubThread.merge.chooseMethod",
                defaultMessage: "Choose how to merge",
              })}
              className={cn(
                "rounded-l-none border-l-[0.5px] px-1",
                whenReady
                  ? "border-l-token-border"
                  : "border-l-(--color-background-primary-solid-hover)",
              )}
            >
              <ChevronDownIcon className="icon-2xs" />
            </NodexButton>
          }
        >
          <NodexDropdownRadioGroup
            value={method}
            onValueChange={(value) => {
              setChosen(value as GitHubMergeMethod);
              setArmedAt(null);
            }}
          >
            {methods.map((value) => (
              <NodexDropdownRadioItem key={value} value={value}>
                {methodLabel(value)}
              </NodexDropdownRadioItem>
            ))}
          </NodexDropdownRadioGroup>
        </NodexDropdownMenu>
      ) : null}
    </span>
  );
}

function AuthorRow({ detail }: { readonly detail: GitHubThreadDetail }) {
  return (
    <Row
      icon={<PersonCircleIcon />}
      label={<FormattedMessage id="githubThread.properties.author" defaultMessage="Author" />}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-sm">
        <GitHubActorName actor={detail.author} />
        <GitHubRelativeTime at={detail.createdAt} />
      </div>
    </Row>
  );
}

async function copyBranch(branch: string) {
  const intl = getIntl();
  if (await writeTextToClipboard(branch))
    toast.success(
      intl.formatMessage({ id: "githubThread.copiedBranch", defaultMessage: "Copied branch name" }),
    );
  else
    toast.danger(
      intl.formatMessage({
        id: "githubThread.copyBranchFailed",
        defaultMessage: "Couldn’t copy the branch name",
      }),
    );
}

function BranchRow({
  pr,
  onShowFiles,
}: {
  readonly pr: GitHubPullRequestDetail;
  readonly onShowFiles: () => void;
}) {
  const intl = useIntl();
  const head = pr.headRepository
    ? `${pr.headRepository.split("/")[0]}:${pr.headBranch}`
    : pr.headBranch;
  return (
    <Row
      icon={<BranchStatusIcon />}
      label={<FormattedMessage id="githubThread.properties.branch" defaultMessage="Branch" />}
      className="group/branch"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
        <NodexTooltip tooltipContent={head} delayOpen>
          <span className="min-w-0 truncate font-mono text-xs text-token-text-primary">{head}</span>
        </NodexTooltip>
        <span className="shrink-0 text-token-description-foreground">→</span>
        <span className="shrink-0 font-mono text-xs text-token-text-secondary">
          {pr.baseBranch}
        </span>
        <NodexIconButton
          size="xs"
          icon={CopyIcon}
          ariaLabel={intl.formatMessage({
            id: "githubThread.copyBranch",
            defaultMessage: "Copy branch name",
          })}
          title={intl.formatMessage({
            id: "githubThread.copyBranch",
            defaultMessage: "Copy branch name",
          })}
          className="shrink-0 opacity-0 group-hover/branch:opacity-100 focus-visible:opacity-100"
          onClick={() => void copyBranch(pr.headBranch)}
        />
        <button
          type="button"
          onClick={onShowFiles}
          className="cursor-interaction ml-auto flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-sm text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-text-primary"
        >
          <FormattedMessage
            id="githubThread.properties.files"
            defaultMessage="{count, plural, one {# file} other {# files}}"
            values={{ count: pr.changedFiles }}
          />
          <span className="tabular-nums text-token-git-decoration-added-resource-foreground">
            +{pr.additions}
          </span>
          <span className="tabular-nums text-token-git-decoration-deleted-resource-foreground">
            −{pr.deletions}
          </span>
        </button>
      </div>
    </Row>
  );
}

const CHECK_TONE: Record<GitHubCheckBucket, string> = {
  failing: "text-token-charts-red",
  running: "text-token-charts-orange",
  passed: "text-token-charts-green",
  skipped: "text-token-description-foreground",
};

function CheckGlyph({ bucket }: { readonly bucket: GitHubCheckBucket }) {
  if (bucket === "running")
    return (
      <span
        className={cn("flex size-3.5 shrink-0 items-center justify-center", CHECK_TONE.running)}
      >
        <span className="size-2 rounded-full bg-current" />
      </span>
    );
  if (bucket === "passed")
    return <SuccessCircleIcon className={cn("icon-2xs shrink-0", CHECK_TONE.passed)} />;
  return (
    <span className={cn("flex size-3.5 shrink-0 items-center justify-center", CHECK_TONE[bucket])}>
      <span
        className={cn(
          "size-2 rounded-full",
          bucket === "failing" ? "bg-current" : "ring-1 ring-current ring-inset",
        )}
      />
    </span>
  );
}

function ChecksRow({
  pr,
  revealChecks,
  onAddToChat,
}: {
  readonly pr: GitHubPullRequestDetail;
  readonly revealChecks: boolean;
  readonly onAddToChat: ((subject: GitHubChatContextSubject) => void) | null;
}) {
  const intl = useIntl();
  const summary = summarizeGitHubChecks(pr.checks);
  const listId = useId();
  // A failing check is what the reader came for, so its list starts open; a green run stays folded.
  const [expanded, setExpanded] = useState(summary.counts.failing > 0 || revealChecks);
  return (
    <div id="checks" data-github-anchor="checks" className="scroll-mt-16">
      <Row
        icon={<SuccessCircleIcon />}
        label={<FormattedMessage id="githubThread.properties.checks" defaultMessage="Checks" />}
        disclosure={{ expanded, controls: listId, onToggle: () => setExpanded((open) => !open) }}
      >
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          className="cursor-interaction flex min-w-0 items-center gap-1.5 text-sm text-token-text-secondary"
        >
          {summary.rollup ? <CheckGlyph bucket={summary.rollup} /> : null}
          <span className="min-w-0 truncate">{gitHubChecksCountsLabel(intl, summary.counts)}</span>
          {pr.checksTruncated ? (
            <span className="text-token-description-foreground">
              <FormattedMessage id="githubThread.checks.more" defaultMessage="and more on GitHub" />
            </span>
          ) : null}
        </button>
      </Row>
      {expanded ? (
        <ul
          id={listId}
          className="mb-1 ml-2 flex flex-col border-l-[0.5px] border-token-border pl-4"
          aria-label={intl.formatMessage({
            id: "githubThread.checks.list",
            defaultMessage: "Checks",
          })}
        >
          {summary.ordered.map((check) => (
            <CheckRow key={check.id} check={check} onAddToChat={onAddToChat} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function CheckRow({
  check,
  onAddToChat,
}: {
  readonly check: GitHubCheck;
  readonly onAddToChat: ((subject: GitHubChatContextSubject) => void) | null;
}) {
  const intl = useIntl();
  const openOnGitHub = useOpenOnGitHub();
  const bucket = gitHubCheckBucket(check.status);
  return (
    <li className="group/check flex h-7 min-w-0 items-center gap-2 text-sm">
      <CheckGlyph bucket={bucket} />
      <span className="min-w-0 truncate">{checkLabel(check)}</span>
      {check.required ? (
        <span className="shrink-0 text-xs text-token-description-foreground">
          <FormattedMessage id="githubThread.checks.required" defaultMessage="Required" />
        </span>
      ) : null}
      {check.description ? (
        <span className="min-w-0 flex-1 truncate text-xs text-token-description-foreground">
          {check.description}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      {onAddToChat && bucket === "failing" ? (
        <NodexIconButton
          size="xs"
          icon={SendToChatIcon}
          ariaLabel={intl.formatMessage({
            id: "githubThread.activity.addToChat",
            defaultMessage: "Add to chat",
          })}
          title={intl.formatMessage({
            id: "githubThread.activity.addToChat",
            defaultMessage: "Add to chat",
          })}
          className="shrink-0 opacity-0 group-hover/check:opacity-100 focus-visible:opacity-100"
          onClick={() => onAddToChat({ kind: "check", check })}
        />
      ) : null}
      {check.url ? (
        <a
          href={check.url}
          onClick={(event) => openOnGitHub(check.url ?? "", event)}
          className="shrink-0 text-xs text-token-description-foreground hover:text-token-text-primary hover:underline"
        >
          <FormattedMessage id="githubThread.checks.details" defaultMessage="Details" />
        </a>
      ) : null}
    </li>
  );
}

const REVIEWER_TONE: Record<GitHubReviewer["state"], string> = {
  approved: "text-token-charts-green",
  changes_requested: "text-token-charts-red",
  commented: "text-token-description-foreground",
  dismissed: "text-token-description-foreground",
  pending: "text-token-charts-orange",
};

function ReviewersRow({ reviewers }: { readonly reviewers: readonly GitHubReviewer[] }) {
  const intl = useIntl();
  return (
    <Row
      icon={<VisibilityIcon />}
      label={<FormattedMessage id="githubThread.properties.reviews" defaultMessage="Reviews" />}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-1 text-sm">
        {reviewers.map((reviewer) => (
          <NodexTooltip
            key={reviewer.name}
            tooltipContent={`${reviewer.name} · ${gitHubReviewerStateLabel(intl, reviewer.state)}`}
            delayOpen
          >
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <GitHubAvatar actor={reviewer.actor} />
              <span className="min-w-0 truncate">{reviewer.name}</span>
              <span className={cn("shrink-0 text-xs", REVIEWER_TONE[reviewer.state])}>
                {gitHubReviewerStateLabel(intl, reviewer.state)}
              </span>
            </span>
          </NodexTooltip>
        ))}
      </div>
    </Row>
  );
}

function LinkedThreadsRow({ detail }: { readonly detail: GitHubThreadDetail }) {
  const threads =
    detail.kind === "pull_request" ? detail.closingIssues : detail.closingPullRequests;
  if (threads.length === 0) return null;
  return (
    <Row
      icon={detail.kind === "pull_request" ? <IssueOpenIcon /> : <PullRequestIcon />}
      label={
        detail.kind === "pull_request" ? (
          <FormattedMessage id="githubThread.properties.closes" defaultMessage="Closes" />
        ) : (
          <FormattedMessage
            id="githubThread.properties.pullRequests"
            defaultMessage="Pull requests"
          />
        )
      }
    >
      <div className="flex min-w-0 flex-col items-start gap-1 py-1">
        {threads.map((thread) => (
          <GitHubThreadReferenceChip
            key={`${thread.ref.owner}/${thread.ref.repo}#${thread.ref.number}`}
            thread={thread}
            from={detail.ref}
          />
        ))}
      </div>
    </Row>
  );
}

/** The Nodex work this thread belongs to: its Pages and the chats working on them. */
function WorkRow({ links }: { readonly links: GitHubThreadLinks }) {
  return (
    <Row
      icon={<PageIcon />}
      label={<FormattedMessage id="githubThread.properties.work" defaultMessage="Work" />}
    >
      <div className="flex min-w-0 flex-col items-start gap-1 py-1 text-sm">
        {links.pages.map((page) => (
          <span key={page.pageId} className="flex min-w-0 max-w-full items-center gap-2">
            <NodexReference
              destination={{ kind: "page", pageId: page.pageId }}
              variant="mention"
              titleSnapshot={page.title}
            />
            {page.activeChat ? (
              <NodexReference
                destination={{ kind: "session", sessionId: page.activeChat.sessionId }}
                variant="mention"
                titleSnapshot={page.activeChat.title}
              />
            ) : null}
          </span>
        ))}
      </div>
    </Row>
  );
}
