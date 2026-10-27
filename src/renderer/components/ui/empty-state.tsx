import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly width?: "compact" | "wide";
  readonly className?: string;
  readonly contentClassName?: string;
}

/** A centered icon, title, optional description, and optional actions for an empty surface. */
export function EmptyState({
  icon,
  title,
  description,
  actions,
  width = "compact",
  className,
  contentClassName,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex w-full flex-col items-center justify-center px-4 py-8 text-center",
        className,
      )}
    >
      <div
        className={cn(
          "flex w-full min-w-0 flex-col items-center gap-3",
          width === "wide" ? "max-w-xl" : "max-w-72",
          contentClassName,
        )}
      >
        <div className="flex items-center justify-center [&>svg]:size-8 [&>svg]:text-(--color-text-secondary)">
          {icon}
        </div>
        <div className="flex w-full min-w-0 flex-col items-center gap-2">
          <div className="text-lg leading-6 font-medium text-(--color-text)">{title}</div>
          {description == null ? null : (
            <div className="w-full min-w-0 text-sm semantic-text-secondary">{description}</div>
          )}
        </div>
        {actions == null ? null : (
          <div className="flex flex-wrap items-center justify-center gap-2">{actions}</div>
        )}
      </div>
    </div>
  );
}
