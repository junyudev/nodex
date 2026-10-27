import { Fragment, type ReactNode } from "react";
import { ChevronRightLgIcon } from "@/components/shared/icons/customize-action-icons";
import { ToolbarButton } from "./toolbar-button";

export interface ToolbarBreadcrumbAncestor {
  readonly id: string;
  readonly label: ReactNode;
  readonly onSelect: () => void;
}

/**
 * A titlebar trail: muted ghost buttons for the ancestors, chevrons between them, and the
 * current page as plain text.
 */
export function ToolbarBreadcrumb({
  ancestors,
  current,
}: {
  readonly ancestors: readonly ToolbarBreadcrumbAncestor[];
  readonly current?: ReactNode;
}) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex min-w-0 items-center gap-1 text-sm text-token-description-foreground"
    >
      {ancestors.map((ancestor, index) => (
        <Fragment key={ancestor.id}>
          {index > 0 ? <ChevronRightLgIcon className="shrink-0" /> : null}
          <ToolbarButton className="min-w-0" onClick={ancestor.onSelect}>
            <span className="min-w-0 truncate">{ancestor.label}</span>
          </ToolbarButton>
        </Fragment>
      ))}
      {current == null ? null : (
        <>
          {ancestors.length > 0 ? <ChevronRightLgIcon className="shrink-0" /> : null}
          <span
            aria-current="page"
            className="flex h-token-button-composer min-w-0 flex-auto items-center truncate px-2 text-token-foreground"
          >
            {current}
          </span>
        </>
      )}
    </nav>
  );
}
