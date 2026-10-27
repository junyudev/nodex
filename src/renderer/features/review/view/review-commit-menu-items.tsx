import { CheckmarkIcon } from "@/components/shared/icons";
import {
  NodexDropdownItem,
  NodexDropdownMessage,
  NodexDropdownScrollList,
} from "@/components/ui/dropdown";
import type { GitReviewBranchCommit } from "@/lib/types";

export type ReviewCommitListStatus = "idle" | "loading" | "error" | "loaded";

/** Compact elapsed time since a commit, e.g. `5m`, `3d`, `2y`. */
export function formatReviewCommitRelativeTime(committedAt: string, now = Date.now()): string {
  const committedAtMs = Date.parse(committedAt);
  if (!Number.isFinite(committedAtMs)) return "";

  const elapsedMinutes = Math.floor(Math.max(0, now - committedAtMs) / 60_000);
  if (elapsedMinutes < 1) return "now";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 30) return `${elapsedDays}d`;

  const elapsedMonths = Math.floor(elapsedDays / 30);
  if (elapsedMonths < 12) return `${elapsedMonths}mo`;

  return `${Math.floor(elapsedMonths / 12)}y`;
}

/** The branch's commits as menu rows, with loading, failure, and empty states. */
export function ReviewCommitMenuItems({
  status,
  commits,
  errorMessage,
  selectedSha,
  onRetry,
  onSelect,
}: {
  readonly status: ReviewCommitListStatus;
  readonly commits: readonly GitReviewBranchCommit[];
  readonly errorMessage: string | null;
  readonly selectedSha: string | null;
  readonly onRetry: () => void;
  readonly onSelect: (commit: GitReviewBranchCommit) => void;
}) {
  if (status === "loading" || status === "idle")
    return <NodexDropdownMessage compact>Loading commits...</NodexDropdownMessage>;
  if (status === "error")
    return (
      <>
        <NodexDropdownMessage compact tone="error">
          {errorMessage ?? "Unable to load commits"}
        </NodexDropdownMessage>
        <NodexDropdownItem onSelect={onRetry}>Retry</NodexDropdownItem>
      </>
    );
  if (commits.length === 0)
    return <NodexDropdownMessage compact>No commits on branch</NodexDropdownMessage>;
  return (
    <NodexDropdownScrollList className="max-h-80">
      {commits.map((commit) => {
        const relativeTime = formatReviewCommitRelativeTime(commit.committedAt);
        return (
          <NodexDropdownItem
            key={commit.sha}
            onSelect={() => onSelect(commit)}
            tooltipText={commit.subject}
            rightSlot={selectedSha === commit.sha ? <CheckmarkIcon className="size-4" /> : null}
          >
            <span className="flex min-w-0 items-center justify-between gap-3">
              <span className="min-w-0 truncate">{commit.subject}</span>
              {relativeTime ? (
                <span className="shrink-0 text-xs text-token-description-foreground">
                  {relativeTime} ago
                </span>
              ) : null}
            </span>
          </NodexDropdownItem>
        );
      })}
    </NodexDropdownScrollList>
  );
}
