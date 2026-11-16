import { getIntl } from "@/lib/i18n";
import { useCallback } from "react";
import { toast } from "@/components/ui/toast";
import { useSetScopedAtom } from "@/lib/maitai";
import { prepareReviewOpenAtom, type ReviewOpenIntent } from "../model/review-view-state";

export interface UseOpenReviewOptions {
  readonly activateReviewTab: () => Promise<boolean>;
}

export function useOpenReview({
  activateReviewTab,
}: UseOpenReviewOptions): (intent: ReviewOpenIntent) => Promise<void> {
  const prepareReviewOpen = useSetScopedAtom(prepareReviewOpenAtom);

  return useCallback(
    async (intent: ReviewOpenIntent) => {
      try {
        const activated = await activateReviewTab();
        if (!activated) {
          toast.danger(
            getIntl().formatMessage({
              id: "review.useOpenReview.unavailable",
              defaultMessage: "Review is unavailable for this conversation.",
            }),
          );
          return;
        }
        prepareReviewOpen(intent);
      } catch (error) {
        toast.danger(
          error instanceof Error
            ? error.message
            : getIntl().formatMessage({
                id: "review.useOpenReview.openFailed",
                defaultMessage: "Could not open Review.",
              }),
        );
      }
    },
    [activateReviewTab, prepareReviewOpen],
  );
}
