import type { ReactNode } from "react";
import { CloseIcon } from "@/components/shared/icons";
import {
  NodexDialog,
  NodexDialogBody,
  NodexDialogClose,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogFrame,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * The dialog a skill or app row opens: an outlined icon, the name and description, a body, and
 * a footer. Header actions sit beside the close button. `editor` is a fixed 600×720 frame for
 * long contents; `wide` is 600px wide and as tall as its contents.
 */
export function DetailDialog({
  open,
  onOpenChange,
  icon,
  iconShape = "circle",
  size = "editor",
  title,
  titleText,
  description,
  headerActions,
  footer,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly icon?: ReactNode;
  readonly iconShape?: "circle" | "rounded";
  readonly size?: "editor" | "wide";
  readonly title: ReactNode;
  readonly titleText: string;
  readonly description?: string | null;
  readonly headerActions?: ReactNode;
  readonly footer?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <NodexDialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <NodexDialogContent
        showCloseButton={headerActions == null}
        closeButtonAriaLabel="Close dialog"
        className={cn(
          "flex max-h-full w-[600px] max-w-full flex-col",
          size === "editor" ? "h-[720px]" : "max-h-[min(92vh,720px)]",
        )}
      >
        {headerActions == null ? null : (
          <div className="no-drag absolute top-5 right-5 flex items-center gap-1">
            {headerActions}
            <NodexDialogClose>
              <button
                type="button"
                aria-label="Close dialog"
                className="cursor-interaction rounded p-1 leading-none text-token-foreground/80 hover:bg-token-toolbar-hover-background focus:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border"
              >
                <CloseIcon className="icon-xs" />
              </button>
            </NodexDialogClose>
          </div>
        )}
        <NodexDialogFrame className={size === "editor" ? "h-full min-h-0" : "min-h-0 flex-1"}>
          <NodexDialogBody>
            <div className="flex flex-col items-start gap-3">
              {icon == null ? null : (
                <span
                  className={cn(
                    "flex size-10 shrink-0 items-center justify-center border border-(--color-border) text-(--color-text-secondary)",
                    iconShape === "rounded" ? "rounded-lg" : "rounded-full",
                  )}
                >
                  {icon}
                </span>
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-1 self-stretch">
                <NodexDialogTitle
                  aria-label={titleText}
                  className={headerActions != null && icon == null ? "pe-32" : undefined}
                >
                  {title}
                </NodexDialogTitle>
                {description ? (
                  <NodexDialogDescription className="text-lg leading-normal text-(--color-text-secondary)">
                    {description}
                  </NodexDialogDescription>
                ) : null}
              </div>
            </div>
          </NodexDialogBody>
          {children == null ? null : size === "editor" ? (
            <NodexDialogBody className="min-h-0 flex-1">
              <div className="h-full overflow-y-auto">{children}</div>
            </NodexDialogBody>
          ) : (
            // A wide dialog's contents scroll themselves, so their headers can stick.
            <NodexDialogBody className="min-h-0 flex-1">{children}</NodexDialogBody>
          )}
          <NodexDialogFooter bodyClassName="pt-5">
            {footer ?? (
              <NodexDialogClose>
                <button
                  type="button"
                  className="flex h-token-button-composer w-full cursor-interaction items-center justify-center rounded-full px-2 text-sm text-token-foreground hover:bg-token-list-hover-background"
                >
                  Close
                </button>
              </NodexDialogClose>
            )}
          </NodexDialogFooter>
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}

/** A dialog title: the name, an optional badge, and what kind of thing it is. */
export function DetailDialogTitle({
  title,
  kind,
  badge,
}: {
  readonly title: string;
  readonly kind: "Skill" | "App";
  readonly badge?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="min-w-0 truncate">{title}</div>
      {badge}
      <div className="heading-dialog shrink-0 font-normal text-(--color-text-secondary)">
        {kind}
      </div>
    </div>
  );
}
