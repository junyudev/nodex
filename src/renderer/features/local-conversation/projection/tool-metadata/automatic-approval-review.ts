import { normalizeAutomaticApprovalReviewPayload } from "../../../../../shared/codex-transcript-special-items";
import type { CodexConversationItem } from "../../../../lib/types";

/** A declined execution is an automatic-review refusal only when an attached review denied it. */
export function wasToolExecutionDeclinedByAutomaticReview(input: {
  type: "exec" | "fileChange";
  entry: Pick<CodexConversationItem, "executionStatus" | "status">;
  automaticApprovalReviews?: readonly Pick<CodexConversationItem, "rawItem">[];
}): boolean {
  const status = input.type === "exec" ? input.entry.executionStatus : input.entry.status;
  if (status !== "declined") return false;
  return (
    input.automaticApprovalReviews?.some(
      (review) => normalizeAutomaticApprovalReviewPayload(review.rawItem)?.status === "denied",
    ) === true
  );
}
