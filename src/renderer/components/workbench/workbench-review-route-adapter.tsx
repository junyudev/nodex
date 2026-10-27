import { useCallback, type ReactNode } from "react";
import type { ThreadStageActions } from "@/features/local-conversation";
import { useOpenReview } from "@/features/review/hooks/use-open-review";

export function ReviewRouteOpenAdapter({
  activateReviewTab,
  children,
}: {
  activateReviewTab: () => Promise<boolean>;
  children: (actions: {
    onOpenTurnDiffReview: NonNullable<ThreadStageActions["onOpenTurnDiffReview"]>;
    onOpenSummaryGitReview: NonNullable<ThreadStageActions["onOpenSummaryGitReview"]>;
  }) => ReactNode;
}) {
  const openReview = useOpenReview({ activateReviewTab });
  const openSummaryGitReview = useCallback<
    NonNullable<ThreadStageActions["onOpenSummaryGitReview"]>
  >(
    async ({ source }) => {
      if (source === "unstaged" || source === "staged") {
        await openReview({ source: { kind: "git", mode: source } });
        return;
      }
      await openReview({ source: { kind: "git", mode: "branch", baseRef: "" } });
    },
    [openReview],
  );

  return children({
    onOpenTurnDiffReview: openReview,
    onOpenSummaryGitReview: openSummaryGitReview,
  });
}
