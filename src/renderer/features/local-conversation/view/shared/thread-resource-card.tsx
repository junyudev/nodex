import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ThreadResourceCardProps extends Omit<
  ComponentPropsWithoutRef<"button">,
  "children" | "title" | "type"
> {
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly detail?: ReactNode;
  /** Replaces the detail while the card itself is hovered or focused, to say what opening does. */
  readonly hoverDetail?: ReactNode;
  /** Controls of their own beside the card, such as an Open in menu. */
  readonly trailing?: ReactNode;
}

/**
 * A discrete object the transcript points at, such as a created chat or a turn output. The whole
 * card is one button; trailing controls sit above it and stay independently clickable.
 */
export function ThreadResourceCard({
  icon,
  title,
  detail,
  hoverDetail,
  trailing,
  className,
  ...props
}: ThreadResourceCardProps) {
  return (
    <div
      className={cn(
        "relative flex min-w-0 items-center gap-3 rounded-lg border-[0.5px] border-token-border p-3 has-[>button:hover]:bg-token-list-hover-background",
        className,
      )}
    >
      <button
        {...props}
        type="button"
        className="peer/resource-card absolute inset-0 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-token-focus-border"
      />
      <span className="pointer-events-none flex size-5 shrink-0 items-center justify-center text-token-text-secondary">
        {icon}
      </span>
      <span
        className={cn(
          "pointer-events-none flex min-w-0 flex-1 flex-col",
          hoverDetail &&
            "peer-hover/resource-card:[&>[data-card-detail=rest]]:hidden peer-hover/resource-card:[&>[data-card-detail=hover]]:flex peer-focus-visible/resource-card:[&>[data-card-detail=rest]]:hidden peer-focus-visible/resource-card:[&>[data-card-detail=hover]]:flex",
        )}
      >
        <span className="truncate font-medium text-token-foreground">{title}</span>
        {hoverDetail ? (
          <>
            <span data-card-detail="rest" className="flex min-w-0">
              {detail}
            </span>
            <span
              data-card-detail="hover"
              className="hidden min-w-0 text-sm text-token-description-foreground"
            >
              {hoverDetail}
            </span>
          </>
        ) : (
          detail
        )}
      </span>
      {trailing ? <span className="relative flex shrink-0 items-center">{trailing}</span> : null}
    </div>
  );
}

/** Cards share one responsive grid: one column, two once the thread is wide. */
export function ThreadResourceCardGrid({ children }: { readonly children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-2 @lg/thread-content:grid-cols-2">{children}</div>;
}

/** The text control that reveals (or hides) the rest of a capped card list. */
export function ThreadResourceCardMore({
  label,
  onClick,
  expanded,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly expanded?: boolean;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      className="self-start text-sm text-token-text-secondary hover:text-token-foreground"
      onClick={onClick}
    >
      {label}
    </button>
  );
}
