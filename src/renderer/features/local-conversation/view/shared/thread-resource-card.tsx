import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ThreadResourceCardProps extends Omit<
  ComponentPropsWithoutRef<"button">,
  "children" | "title" | "type"
> {
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly detail?: ReactNode;
  /** Revealed with hover or keyboard focus, for an affordance the card itself does not state. */
  readonly trailing?: ReactNode;
}

/** A discrete object the transcript points at, such as a created chat or a turn output. */
export function ThreadResourceCard({
  icon,
  title,
  detail,
  trailing,
  className,
  ...props
}: ThreadResourceCardProps) {
  return (
    <button
      {...props}
      type="button"
      className={cn(
        "group/resource-card flex min-w-0 items-center gap-3 rounded-lg border-[0.5px] border-token-border p-3 text-left hover:bg-token-list-hover-background focus-visible:outline-2 focus-visible:outline-token-focus-border",
        className,
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-token-text-secondary">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-token-foreground">{title}</span>
        {detail}
      </span>
      {trailing ? (
        <span className="flex shrink-0 text-token-text-secondary opacity-0 group-hover/resource-card:opacity-100 group-focus-visible/resource-card:opacity-100">
          {trailing}
        </span>
      ) : null}
    </button>
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
