import {
  ActivitySpinnerIcon,
  PermissionAskForApprovalIcon,
  ThreadIcon,
} from "@/components/shared/icons";
import { CircleAlert, TextCursorInput } from "@/components/shared/icons/generic-icons";
import type { PageChatActivityPresentation } from "@/lib/page-chat-activity-presentation";
import { cn } from "@/lib/utils";

export function PageChatActivityGlyph({
  activity,
  className,
  unreadRingClassName,
}: {
  readonly activity: Pick<PageChatActivityPresentation, "execution" | "unread">;
  readonly className?: string;
  readonly unreadRingClassName?: string;
}) {
  const glyph =
    activity.execution === "working" ? (
      <ActivitySpinnerIcon className="size-3" animationDurationMs={2_000} />
    ) : activity.execution === "error" ? (
      <CircleAlert className="size-3" />
    ) : activity.execution === "approval" ? (
      <PermissionAskForApprovalIcon className="size-3" />
    ) : activity.execution === "input" ? (
      <TextCursorInput className="size-3" />
    ) : (
      <ThreadIcon className="size-3" />
    );

  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative flex size-5 shrink-0 items-center justify-center",
        activity.execution === "error"
          ? "text-token-error-foreground"
          : activity.execution === "approval" || activity.execution === "input"
            ? "text-token-warning-foreground"
            : "text-token-description-foreground",
        className,
      )}
    >
      {glyph}
      {activity.unread ? (
        <span
          data-page-chat-unread="true"
          className={cn(
            "absolute right-0 top-0 size-1.5 rounded-full bg-token-charts-blue ring-1",
            unreadRingClassName,
          )}
        />
      ) : null}
    </span>
  );
}
