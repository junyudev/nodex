import { useIntl } from "@/lib/i18n";
import { Fragment, type ReactNode } from "react";
import { ChevronRightLgIcon } from "@/components/shared/icons/customize-action-icons";
import { cn } from "@/lib/utils";
import { NodexButton } from "./button";
import { ToolbarButton } from "./toolbar-button";

export interface ToolbarBreadcrumbAncestor {
  readonly id: string;
  readonly label: ReactNode;
  readonly ariaLabel?: string;
  readonly onSelect: () => void;
}

/**
 * A titlebar trail: muted ghost buttons for the ancestors, chevrons between them, and the
 * current page as plain text.
 */
export function ToolbarBreadcrumb({
  ancestors,
  current,
  ariaLabel,
  variant,
}: {
  readonly ancestors: readonly ToolbarBreadcrumbAncestor[];
  readonly current?: ReactNode;
  readonly ariaLabel?: string;
  readonly variant?: "settings";
}) {
  const intl = useIntl();
  return (
    <nav
      aria-label={
        ariaLabel ??
        intl.formatMessage({
          id: "ui.toolbarBreadcrumb.label",
          defaultMessage: "Breadcrumb",
        })
      }
      className="flex min-w-0 items-center gap-1 text-sm text-token-description-foreground"
    >
      {ancestors.map((ancestor, index) => (
        <Fragment key={ancestor.id}>
          {index > 0 ? <ChevronRightLgIcon className="shrink-0" /> : null}
          {variant === "settings" ? (
            <NodexButton
              aria-label={ancestor.ariaLabel}
              className="min-w-0 shrink"
              onClick={ancestor.onSelect}
              size="toolbar"
              variant="ghostSecondary"
            >
              <span className="min-w-0 truncate">{ancestor.label}</span>
            </NodexButton>
          ) : (
            <ToolbarButton
              aria-label={ancestor.ariaLabel}
              className="min-w-0"
              onClick={ancestor.onSelect}
            >
              <span className="min-w-0 truncate">{ancestor.label}</span>
            </ToolbarButton>
          )}
        </Fragment>
      ))}
      {current == null ? null : (
        <>
          {ancestors.length > 0 ? <ChevronRightLgIcon className="shrink-0" /> : null}
          <span
            aria-current="page"
            className={cn(
              "min-w-0 truncate px-2 text-token-foreground",
              variant !== "settings" && "flex h-token-button-composer flex-auto items-center",
            )}
          >
            {current}
          </span>
        </>
      )}
    </nav>
  );
}
