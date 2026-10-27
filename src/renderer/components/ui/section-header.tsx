import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A browse or detail section's heading row: an 16px medium title, optional count, and action. */
export function SectionHeader({
  title,
  count,
  action,
  showDivider = true,
}: {
  readonly title?: ReactNode;
  readonly count?: ReactNode;
  readonly action?: ReactNode;
  readonly showDivider?: boolean;
}) {
  return (
    <div
      data-slot="section-header"
      className={cn(
        "flex items-center justify-between gap-3 ps-(--sectioned-page-leading-inset,0.5rem) pe-0.5 pb-2 text-token-foreground",
        showDivider && "border-b border-(--color-border-subtle)",
      )}
    >
      <h2 className="flex min-h-7 items-center gap-1.5 text-lg leading-6 font-medium">
        {title}
        {count == null ? null : <span className="text-tertiary">{count}</span>}
      </h2>
      {action == null ? null : <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** A titled section: its header, then content 16px below. */
export function PageSection({
  id,
  title,
  count,
  action,
  showDivider = true,
  children,
}: {
  readonly id?: string;
  readonly title?: ReactNode;
  readonly count?: ReactNode;
  readonly action?: ReactNode;
  readonly showDivider?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <section id={id} className="flex flex-col gap-4">
      {title == null && action == null && count == null ? null : (
        <SectionHeader title={title} count={count} action={action} showDivider={showDivider} />
      )}
      {children}
    </section>
  );
}

/** A centered empty or error message with an optional illustration above and actions below. */
export function PageEmptyState({
  illustration,
  title,
  description,
  actions,
}: {
  readonly illustration?: ReactNode;
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
}) {
  return (
    <div className="flex w-full flex-col items-center justify-center px-3 py-6">
      <div className="flex w-full max-w-xl flex-col items-center justify-center gap-3 text-center">
        {illustration == null ? null : (
          <div className="pointer-events-none flex items-center justify-center">{illustration}</div>
        )}
        {title != null || description != null ? (
          <div className="flex flex-col items-center gap-2">
            {title == null ? null : (
              <div className="text-lg leading-6 font-medium text-token-foreground">{title}</div>
            )}
            {description ? (
              <div className="text-sm text-(--color-text-secondary)">{description}</div>
            ) : null}
          </div>
        ) : null}
        {actions ? (
          <div className="flex w-full flex-wrap items-center justify-center gap-2">{actions}</div>
        ) : null}
      </div>
    </div>
  );
}
