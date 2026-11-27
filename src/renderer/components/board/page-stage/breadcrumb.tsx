import { useIntl } from "@/lib/i18n";
import { BoardIcon, ChevronRightIcon, MoreActionsIcon, PageIcon } from "@/components/shared/icons";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownMessage,
} from "@/components/ui/dropdown";
import { NodexMenuRowContent } from "@/components/ui/menu-row";
import { NodexTooltip } from "@/components/ui/tooltip";
import { ViewerCapsule } from "@/components/ui/viewer-header";
import { presentLocationSegment } from "@/lib/resource-location-presentation";
import { useResourceLocation } from "@/lib/resource-location-queries";
import { cn } from "@/lib/utils";
import { parseDatabaseId, type DatabaseId } from "../../../../shared/database-identities";
import type { ResourceLocationSegment } from "../../../../shared/resource-locations";

export interface PageStageLocationProps {
  readonly pageId: string;
  /** Opens a Page the trail passes through. Absent while the Page opens: the trail only reads. */
  readonly onOpenPage?: (pageId: string, title: string) => void;
  /** Opens a Database the trail passes through. */
  readonly onOpenDatabase?: (databaseId: DatabaseId) => void;
}

interface IndexedSegment {
  readonly segment: ResourceLocationSegment;
  readonly index: number;
}

const MAX_INLINE_SEGMENTS = 3;

const segmentKey = ({ segment, index }: IndexedSegment): string =>
  `${segment.kind === "page" ? segment.pageId : segment.databaseId}:${index}`;

function PageStageBreadcrumbSeparator() {
  return (
    <ChevronRightIcon
      aria-hidden="true"
      className="icon-2xs shrink-0 text-token-description-foreground"
    />
  );
}

function PageStageBreadcrumbSegment({
  label,
  segment,
  showSeparator,
  onOpen,
}: {
  readonly label: string;
  readonly segment: ResourceLocationSegment;
  readonly showSeparator: boolean;
  readonly onOpen: (() => void) | null;
}) {
  return (
    <li className="flex min-w-0 shrink items-center gap-1">
      {showSeparator ? <PageStageBreadcrumbSeparator /> : null}
      <NodexTooltip tooltipContent={label} side="bottom">
        <button
          type="button"
          aria-disabled={onOpen ? undefined : true}
          onClick={onOpen ?? undefined}
          className={cn(
            "flex min-w-0 max-w-36 items-center gap-1 rounded-full px-1.5 py-0.5 text-token-text-secondary outline-hidden",
            "hover:bg-token-foreground/5 hover:text-token-text-primary focus-visible:ring-token-focus-border focus-visible:ring-2",
          )}
        >
          {segment.kind === "database" ? (
            <BoardIcon aria-hidden className="icon-2xs shrink-0" />
          ) : null}
          <span className="min-w-0 truncate">{label}</span>
        </button>
      </NodexTooltip>
    </li>
  );
}

/**
 * Where the Page lives: the Databases and Pages that own it, outermost first, each opening on
 * click. It reads the Page's ownership, so it is the same however the Page was opened, and it
 * is absent for a Page at the top level of Space.
 */
export function PageStageBreadcrumb({
  pageId,
  onOpenPage,
  onOpenDatabase,
}: PageStageLocationProps) {
  const intl = useIntl();
  const location = useResourceLocation({ kind: "page", pageId });
  const segments = location.data?.status === "available" ? location.data.segments : [];
  if (segments.length === 0) return null;

  const openerFor = (segment: ResourceLocationSegment, label: string): (() => void) | null => {
    if (segment.kind === "page") return onOpenPage ? () => onOpenPage(segment.pageId, label) : null;
    return onOpenDatabase ? () => onOpenDatabase(parseDatabaseId(segment.databaseId)) : null;
  };
  const indexed = segments.map((segment, index) => ({ segment, index }));
  const hasOverflow = indexed.length > MAX_INLINE_SEGMENTS;
  const leading = hasOverflow ? indexed.slice(0, 1) : indexed;
  const overflow = hasOverflow ? indexed.slice(1, -2) : [];
  const trailing = hasOverflow ? indexed.slice(-2) : [];
  const renderSegment = (entry: IndexedSegment, showSeparator: boolean) => {
    const label = presentLocationSegment(entry.segment, intl);
    return (
      <PageStageBreadcrumbSegment
        key={segmentKey(entry)}
        label={label}
        segment={entry.segment}
        showSeparator={showSeparator}
        onOpen={openerFor(entry.segment, label)}
      />
    );
  };
  const moreLabel = intl.formatMessage({
    id: "board.breadcrumb.moreLocation",
    defaultMessage: "More of this location",
  });

  return (
    <ViewerCapsule className="flex min-w-0 items-center">
      <nav
        aria-label={intl.formatMessage({
          id: "board.breadcrumb.location",
          defaultMessage: "Page location",
        })}
        className="flex h-full min-w-0 items-center overflow-hidden px-1.5 text-sm"
        data-page-stage-breadcrumb="true"
      >
        <ol className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap">
          {leading.map((entry, index) => renderSegment(entry, index > 0))}
          {overflow.length > 0 ? (
            <li className="flex shrink-0 items-center gap-1">
              <PageStageBreadcrumbSeparator />
              <NodexDropdownMenu
                side="bottom"
                align="start"
                contentWidth="menuBounded"
                triggerTooltipContent={moreLabel}
                triggerButton={
                  <button
                    type="button"
                    aria-label={moreLabel}
                    className={cn(
                      "inline-flex size-6 items-center justify-center rounded-md text-token-description-foreground outline-hidden",
                      "hover:bg-token-foreground/5 hover:text-token-text-primary focus-visible:ring-token-focus-border focus-visible:ring-2",
                    )}
                  >
                    <MoreActionsIcon className="icon-2xs shrink-0" />
                  </button>
                }
              >
                {overflow.map((entry) => {
                  const label = presentLocationSegment(entry.segment, intl);
                  const open = openerFor(entry.segment, label);
                  const Icon = entry.segment.kind === "database" ? BoardIcon : PageIcon;
                  const icon = <Icon aria-hidden className="icon-xs shrink-0" />;
                  if (!open) {
                    return (
                      <NodexDropdownMessage key={segmentKey(entry)} compact>
                        <NodexMenuRowContent leading={icon} highlight={false}>
                          {label}
                        </NodexMenuRowContent>
                      </NodexDropdownMessage>
                    );
                  }
                  return (
                    <NodexDropdownItem
                      key={segmentKey(entry)}
                      tooltipText={label}
                      leftSlot={icon}
                      onSelect={open}
                    >
                      {label}
                    </NodexDropdownItem>
                  );
                })}
              </NodexDropdownMenu>
            </li>
          ) : null}
          {trailing.map((entry) => renderSegment(entry, true))}
        </ol>
      </nav>
    </ViewerCapsule>
  );
}
