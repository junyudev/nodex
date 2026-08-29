import type { ReactNode } from "react";
import { CloseIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ImageEditorToolbarVariant = "compact" | "imageTools";

export interface ImageEditorToolbarPillProps {
  ariaLabel?: string;
  children: ReactNode;
  className?: string;
  variant?: ImageEditorToolbarVariant;
}

export function ImageEditorToolbarPill({
  ariaLabel,
  children,
  className,
  variant = "compact",
}: ImageEditorToolbarPillProps) {
  return (
    <div
      role={ariaLabel ? "toolbar" : undefined}
      aria-label={ariaLabel}
      className={cn(
        "flex w-fit max-w-full select-none items-center overflow-hidden rounded-full p-0.5 shadow-md",
        variant === "imageTools"
          ? "gap-0 border border-token-border bg-token-background"
          : "gap-0.5 bg-token-editor-background/95 ring-1 ring-token-border-light backdrop-blur-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface ImageCommentModeToolbarProps {
  ariaLabel?: string;
  commentCount: number;
  emptyMessage: ReactNode;
  isSubmitting?: boolean;
  onCancel: () => void;
  onSend: () => void;
  variant?: ImageEditorToolbarVariant;
}

export function ImageCommentModeToolbar({
  ariaLabel,
  commentCount,
  emptyMessage,
  isSubmitting = false,
  onCancel,
  onSend,
  variant = "compact",
}: ImageCommentModeToolbarProps) {
  return (
    <ImageEditorToolbarPill ariaLabel={ariaLabel} variant={variant}>
      <span
        className={cn(
          "min-w-0 truncate leading-[18px]",
          variant === "imageTools" ? "px-2.5 text-sm" : "px-1.5 text-base",
          commentCount === 0 ? "text-token-text-tertiary" : "text-token-foreground",
        )}
      >
        {commentCount === 0
          ? emptyMessage
          : `${commentCount} ${commentCount === 1 ? "comment" : "comments"}`}
      </span>
      <NodexButton
        variant="accentAction"
        size="composer"
        disabled={commentCount === 0 || isSubmitting}
        aria-busy={isSubmitting || undefined}
        className={cn(
          variant === "imageTools"
            ? "!h-9 !rounded-full !px-3 !text-sm font-medium"
            : "!h-token-button-composer-sm !px-2 !text-base",
        )}
        onClick={onSend}
      >
        Send
      </NodexButton>
      <NodexButton
        variant="ghost"
        size="icon-xs"
        aria-label="Cancel"
        className={cn(
          "rounded-full text-token-text-tertiary",
          variant === "imageTools" ? "!size-9" : "!size-7",
        )}
        onClick={onCancel}
      >
        <CloseIcon aria-hidden="true" className="icon-2xs" />
      </NodexButton>
    </ImageEditorToolbarPill>
  );
}
