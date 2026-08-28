import { ChevronRightIcon } from "@/components/shared/icons";
import { MoreActionsIcon } from "@/components/shared/icons";
import { NodexDropdownItem, NodexDropdownMenu } from "@/components/ui/dropdown";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface PageStageBreadcrumbItem {
  readonly projectId: string;
  readonly pageId: string;
  readonly title: string;
  readonly disabled?: boolean;
}

export interface PageStageBreadcrumbProps {
  readonly ancestors: readonly PageStageBreadcrumbItem[];
  readonly currentTitle: string;
  readonly disabled?: boolean;
  readonly onOpenAncestor: (ancestor: PageStageBreadcrumbItem, ancestorIndex: number) => void;
}

interface IndexedBreadcrumbItem {
  readonly item: PageStageBreadcrumbItem;
  readonly index: number;
}

const MAX_INLINE_ANCESTORS = 3;

function breadcrumbLabel(title: string): string {
  return title.trim() || "Untitled";
}

function PageStageBreadcrumbSeparator() {
  return (
    <ChevronRightIcon
      aria-hidden="true"
      className="icon-2xs shrink-0 text-token-description-foreground"
    />
  );
}

function PageStageBreadcrumbAncestor({
  entry,
  showSeparator,
  disabled,
  onOpenAncestor,
}: {
  readonly entry: IndexedBreadcrumbItem;
  readonly showSeparator: boolean;
  readonly disabled: boolean;
  readonly onOpenAncestor: PageStageBreadcrumbProps["onOpenAncestor"];
}) {
  const label = breadcrumbLabel(entry.item.title);
  const itemDisabled = disabled || entry.item.disabled === true;
  return (
    <li className="flex min-w-0 shrink items-center gap-1">
      {showSeparator ? <PageStageBreadcrumbSeparator /> : null}
      <NodexTooltip tooltipContent={label} side="bottom">
        <button
          type="button"
          disabled={itemDisabled}
          onClick={() => onOpenAncestor(entry.item, entry.index)}
          className={cn(
            "min-w-0 max-w-36 truncate rounded-md px-1 py-0.5 text-token-text-secondary outline-hidden",
            "hover:bg-token-foreground/5 hover:text-token-text-primary focus-visible:ring-token-focus focus-visible:ring-2",
            itemDisabled &&
              "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-token-text-secondary",
          )}
        >
          {label}
        </button>
      </NodexTooltip>
    </li>
  );
}

export function PageStageBreadcrumb({
  ancestors,
  currentTitle,
  disabled = false,
  onOpenAncestor,
}: PageStageBreadcrumbProps) {
  if (ancestors.length === 0) return null;

  const indexedAncestors = ancestors.map((item, index) => ({ item, index }));
  const hasOverflow = indexedAncestors.length > MAX_INLINE_ANCESTORS;
  const leading = hasOverflow ? indexedAncestors.slice(0, 1) : indexedAncestors;
  const overflow = hasOverflow ? indexedAncestors.slice(1, -2) : [];
  const trailing = hasOverflow ? indexedAncestors.slice(-2) : [];
  const currentLabel = breadcrumbLabel(currentTitle);

  return (
    <nav
      aria-label="Page hierarchy"
      className="min-w-0 flex-1 overflow-hidden text-xs"
      data-page-stage-breadcrumb="true"
    >
      <ol className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap">
        {leading.map((entry, index) => (
          <PageStageBreadcrumbAncestor
            key={`${entry.item.projectId}:${entry.item.pageId}:${entry.index}`}
            entry={entry}
            showSeparator={index > 0}
            disabled={disabled}
            onOpenAncestor={onOpenAncestor}
          />
        ))}

        {overflow.length > 0 ? (
          <li className="flex shrink-0 items-center gap-1">
            <PageStageBreadcrumbSeparator />
            <NodexDropdownMenu
              disabled={disabled}
              side="bottom"
              align="start"
              contentWidth="menuBounded"
              triggerTooltipContent="More ancestor pages"
              triggerButton={
                <button
                  type="button"
                  aria-label="More ancestor pages"
                  className={cn(
                    "inline-flex size-6 items-center justify-center rounded-md text-token-description-foreground outline-hidden",
                    "hover:bg-token-foreground/5 hover:text-token-text-primary focus-visible:ring-token-focus focus-visible:ring-2",
                    disabled &&
                      "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-token-description-foreground",
                  )}
                >
                  <MoreActionsIcon className="icon-2xs shrink-0" />
                </button>
              }
            >
              {overflow.map((entry) => {
                const label = breadcrumbLabel(entry.item.title);
                return (
                  <NodexDropdownItem
                    key={`${entry.item.projectId}:${entry.item.pageId}:${entry.index}`}
                    tooltipText={label}
                    disabled={disabled || entry.item.disabled === true}
                    onSelect={() => onOpenAncestor(entry.item, entry.index)}
                  >
                    {label}
                  </NodexDropdownItem>
                );
              })}
            </NodexDropdownMenu>
          </li>
        ) : null}

        {trailing.map((entry) => (
          <PageStageBreadcrumbAncestor
            key={`${entry.item.projectId}:${entry.item.pageId}:${entry.index}`}
            entry={entry}
            showSeparator={true}
            disabled={disabled}
            onOpenAncestor={onOpenAncestor}
          />
        ))}

        <li className="flex min-w-0 flex-1 items-center gap-1">
          <PageStageBreadcrumbSeparator />
          <NodexTooltip tooltipContent={currentLabel} side="bottom">
            <span
              aria-current="page"
              className="min-w-0 truncate px-1 py-0.5 text-token-text-primary"
            >
              {currentLabel}
            </span>
          </NodexTooltip>
        </li>
      </ol>
    </nav>
  );
}
