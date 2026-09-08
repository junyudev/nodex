import { useState } from "react";
import { motion } from "motion/react";
import { ChevronRightIcon } from "@/components/shared/icons";
import { cn } from "../../../../lib/utils";
import type { CodexConversationItem } from "../../../../lib/types";
import {
  buildAutomaticApprovalReviewActionSummary,
  buildAutomaticApprovalReviewSummary,
  buildAutomaticApprovalReviewTitle,
  normalizeAutomaticApprovalReviewPayload,
} from "../../../../../shared/codex-transcript-special-items";
import { CodexShimmerText } from "./codex-shimmer-text";
import { CODEX_THREAD_ACCORDION_TRANSITION } from "./thread-motion";
import { ThreadActivityDisclosure } from "./tools/tool-primitives";
import { AutomaticApprovalReviewIcon } from "@/components/shared/icons";

export function AutomaticApprovalReviewShield({
  className,
  tone = "default",
}: {
  className?: string;
  tone?: "default" | "warning";
}) {
  return (
    <AutomaticApprovalReviewIcon
      aria-hidden
      className={cn(
        "icon-xs shrink-0",
        tone === "warning"
          ? "text-token-editor-warning-foreground"
          : "text-token-input-placeholder-foreground",
        className,
      )}
    />
  );
}

export function AutomaticApprovalReviewRow({
  className,
  isExpandable = true,
  item,
}: {
  className?: string;
  isExpandable?: boolean;
  item: CodexConversationItem;
}) {
  const [expanded, setExpanded] = useState(false);
  const review = normalizeAutomaticApprovalReviewPayload(item.rawItem);
  if (!review) return null;

  const details = buildAutomaticApprovalReviewSummary(review);
  const title = buildAutomaticApprovalReviewTitle(review);
  const isInProgress = review.status === "inProgress";
  const isHighRiskDenied = review.status === "denied" && review.riskLevel === "high";

  if (!isExpandable) {
    return (
      <div className={cn("min-w-0 truncate pt-1 text-token-description-foreground/80", className)}>
        {title}
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col pt-1", className)}>
      <button
        type="button"
        className="group/automatic-approval-review inline-flex w-fit max-w-full cursor-interaction items-center gap-1.5 text-left"
        aria-expanded={expanded}
        onClick={() => {
          setExpanded((current) => !current);
        }}
      >
        <CodexShimmerText
          active={isInProgress}
          className={cn(
            "min-w-0 truncate",
            isHighRiskDenied
              ? "text-token-editor-warning-foreground"
              : "text-token-description-foreground/80 group-hover/automatic-approval-review:text-token-foreground",
          )}
        >
          {title}
        </CodexShimmerText>
        <ChevronRightIcon
          className={cn(
            "icon-2xs shrink-0 text-token-input-placeholder-foreground opacity-0 transition-[opacity,transform] duration-basic group-hover/automatic-approval-review:opacity-100",
            expanded && "rotate-90 opacity-100",
          )}
        />
      </button>
      <motion.div
        initial={false}
        animate={{ height: expanded ? "auto" : 0, opacity: expanded ? 1 : 0 }}
        transition={CODEX_THREAD_ACCORDION_TRANSITION}
        style={{ overflow: "hidden", pointerEvents: expanded ? "auto" : "none" }}
      >
        <p className="text-size-chat max-w-[80ch] pt-1 leading-relaxed whitespace-pre-wrap text-token-conversation-body">
          {details}
        </p>
      </motion.div>
    </div>
  );
}

export function AutomaticApprovalReviewRows({
  className,
  isDeclined = false,
  isExpandable = true,
  items,
}: {
  className?: string;
  isDeclined?: boolean;
  isExpandable?: boolean;
  items: readonly CodexConversationItem[];
}) {
  if (items.length === 0) return null;
  if (isDeclined) {
    const isHighRisk = items.some((item) => {
      const review = normalizeAutomaticApprovalReviewPayload(item.rawItem);
      return review?.status === "denied" && review.riskLevel === "high";
    });
    return (
      <p
        className={cn(
          "max-w-[80ch] pt-1 text-size-chat leading-relaxed text-token-foreground/60",
          className,
        )}
      >
        {isHighRisk
          ? "Requires explicit authorization because this action is considered high risk"
          : "Requires explicit authorization"}
      </p>
    );
  }
  return (
    <>
      {items.map((item) => (
        <AutomaticApprovalReviewRow
          key={item.entryId ?? item.itemId}
          className={className}
          isExpandable={isExpandable}
          item={item}
        />
      ))}
    </>
  );
}

export function AutomaticApprovalReviewSurface({ item }: { item: CodexConversationItem }) {
  const review = normalizeAutomaticApprovalReviewPayload(item.rawItem);
  if (!review) return null;

  const actionSummary = buildAutomaticApprovalReviewActionSummary(review.action);
  const isInProgress = review.status === "inProgress";
  const isDenied = review.status === "denied";

  return (
    <ThreadActivityDisclosure
      icon={<AutomaticApprovalReviewShield tone={isDenied ? "warning" : "default"} />}
      status={isInProgress ? "running" : "completed"}
      summary={
        <CodexShimmerText
          active={isInProgress}
          className="min-w-0 truncate text-token-foreground/30 group-hover/activity-header:text-token-foreground"
        >
          {actionSummary}
        </CodexShimmerText>
      }
    >
      <AutomaticApprovalReviewRows items={[item]} isDeclined={isDenied} />
    </ThreadActivityDisclosure>
  );
}
