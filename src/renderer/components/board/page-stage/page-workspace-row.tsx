import type { components } from "@nodex/core-protocol";
import {
  BranchStatusIcon,
  CopyIcon,
  ThreadSummaryCreatePullRequestIcon,
} from "@/components/shared/icons";
import { WebsiteGitHubIcon } from "@/components/shared/icons/website-icons";
import { NodexIconButton } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { NodexTooltip } from "@/components/ui/tooltip";
import { writeTextToClipboard } from "@/lib/clipboard";
import { openExternalUrl } from "@/lib/file-system-operations";
import { usePageWorkspace } from "@/lib/page-workspace-runtime";
import { cn } from "@/lib/utils";
import { PageStagePropertyRow } from "./property-row";

type PullRequest = { readonly number: number; readonly url: string; readonly state: string };
type Follow = components["schemas"]["PageThreadFollow"];

const titleCase = (state: string) => state.charAt(0).toUpperCase() + state.slice(1).toLowerCase();
const LINK_CLASS_NAME =
  "inline-flex shrink-0 items-center gap-1 text-sm text-token-text-secondary hover:text-token-text-primary";
const open = (url: string) => (event: { preventDefault(): void; stopPropagation(): void }) => {
  event.preventDefault();
  event.stopPropagation();
  void openExternalUrl(url);
};

/** The Page's own pull request: its number and state, or a marked number on a card. */
export function PagePullRequestLink({
  pullRequest,
  compact = false,
}: {
  readonly pullRequest: PullRequest;
  readonly compact?: boolean;
}) {
  const label = `PR #${pullRequest.number} · ${titleCase(pullRequest.state)}`;
  return (
    <a
      href={pullRequest.url}
      aria-label={label}
      className={cn(LINK_CLASS_NAME, compact && "text-xs")}
      onClick={open(pullRequest.url)}
    >
      {compact ? (
        <>
          <ThreadSummaryCreatePullRequestIcon className="size-3.5" />#{pullRequest.number}
        </>
      ) : (
        label
      )}
    </a>
  );
}

/** A GitHub thread the Page follows, beyond its own PR; its title and repository wait in a tooltip. */
function FollowedThreadLink({ follow }: { readonly follow: Follow }) {
  const { thread } = follow;
  const label = `${thread.kind === "pull_request" ? "PR" : "Issue"} #${thread.number}`;
  return (
    <NodexTooltip tooltipContent={`${thread.repository} · ${thread.title}`}>
      <a href={thread.url} className={LINK_CLASS_NAME} onClick={open(thread.url)}>
        {label}
      </a>
    </NodexTooltip>
  );
}

function CopyBranchButton({ branch }: { readonly branch: string }) {
  return (
    <NodexIconButton
      size="xs"
      icon={CopyIcon}
      ariaLabel="Copy branch name"
      className="ml-auto shrink-0 text-token-description-foreground opacity-0 group-hover/workspace:opacity-100 focus-visible:opacity-100"
      onClick={() =>
        void writeTextToClipboard(branch).then((copied) =>
          copied
            ? toast.success("Copied branch name")
            : toast.danger("Couldn’t copy the branch name"),
        )
      }
    />
  );
}

/**
 * Where the Page's code lives. With a pull request or followed GitHub threads the row is GitHub and
 * lists them, keeping the branch in its tooltip; a checkout alone shows its branch.
 */
export function PageWorkspaceRow({ pageId }: { readonly pageId: string }) {
  const { data } = usePageWorkspace(pageId);
  const pullRequest = data?.pull_request ?? null;
  // The own PR is followed too; it is already listed with its state.
  const follows = (data?.follows ?? []).filter(
    (follow) => follow.role !== "own_pr" && follow.thread.url !== pullRequest?.url,
  );
  const branch = data?.workspace?.branch_name ?? null;
  if (!pullRequest && follows.length === 0) {
    if (!branch) return null;
    return (
      <PageStagePropertyRow icon={<BranchStatusIcon />} label="Branch" className="group/workspace">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <NodexTooltip tooltipContent={branch}>
            <span className="min-w-0 truncate text-sm">{branch}</span>
          </NodexTooltip>
          <CopyBranchButton branch={branch} />
        </div>
      </PageStagePropertyRow>
    );
  }
  return (
    <PageStagePropertyRow
      icon={<WebsiteGitHubIcon />}
      label={
        branch ? (
          <NodexTooltip tooltipContent={`Branch ${branch}`}>
            <span>GitHub</span>
          </NodexTooltip>
        ) : (
          "GitHub"
        )
      }
      className="group/workspace"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        {pullRequest ? <PagePullRequestLink pullRequest={pullRequest} /> : null}
        {follows.map((follow) => (
          <FollowedThreadLink key={follow.thread.id} follow={follow} />
        ))}
        {branch ? <CopyBranchButton branch={branch} /> : null}
      </div>
    </PageStagePropertyRow>
  );
}
