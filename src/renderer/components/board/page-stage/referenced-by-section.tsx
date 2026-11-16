import { defineMessages, useIntl, type MessageDescriptor } from "@/lib/i18n";
import { useState } from "react";

import { ChevronRightIcon, PageIcon } from "@/components/shared/icons";
import type { ContentRoutingContext } from "../../../../shared/content-routing-context";
import type {
  LibraryPageBacklink,
  LibraryPageReferencePresentation,
} from "../../../../shared/library-module";
import { cn } from "@/lib/utils";
import { usePageBacklinks } from "@/lib/use-page-backlinks";

const PRESENTATION_LABELS = defineMessages({
  mention: { id: "board.referencedBySection.mention", defaultMessage: "Mention" },
  reference_block: { id: "board.referencedBySection.embed", defaultMessage: "Embed" },
  link: { id: "board.referencedBySection.link", defaultMessage: "Link" },
} satisfies Record<LibraryPageReferencePresentation, MessageDescriptor>);

export interface ReferencedBySectionProps {
  readonly items: readonly LibraryPageBacklink[];
  readonly sourcePageCount: number;
  readonly loading?: boolean;
  readonly loadingMore?: boolean;
  readonly hasMore?: boolean;
  readonly error?: Error | null;
  readonly defaultExpanded?: boolean;
  readonly onOpen: (item: LibraryPageBacklink) => void;
  readonly onLoadMore?: () => void;
}

export function ReferencedBySection({
  items,
  sourcePageCount,
  loading = false,
  loadingMore = false,
  hasMore = false,
  error = null,
  defaultExpanded = false,
  onOpen,
  onLoadMore,
}: ReferencedBySectionProps) {
  const intl = useIntl();

  const [expanded, setExpanded] = useState(defaultExpanded);
  const countLabel = intl.formatNumber(sourcePageCount, { useGrouping: false });

  // Appears only once a source Page is known, so a Page without references never flashes it.
  if (sourcePageCount === 0) return null;

  return (
    <section className="border-t border-token-border pt-3" data-page-backlinks-section="true">
      <button
        type="button"
        className="flex w-full items-center gap-2 py-1 text-left text-sm text-token-text-secondary hover:text-token-text-primary"
        aria-label={intl.formatMessage(
          {
            id: "board.referencedBySection.referencesLabel",
            defaultMessage: "Referenced by {count}",
          },
          { count: countLabel },
        )}
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <ChevronRightIcon className={cn("icon-2xs shrink-0", expanded && "rotate-90")} />
        <span className="font-medium">
          {intl.formatMessage({
            id: "board.referencedBySection.referencedBy",
            defaultMessage: "Referenced by",
          })}
        </span>
        <span className="text-xs tabular-nums text-token-description-foreground">{countLabel}</span>
      </button>

      {expanded ? (
        <div className="mt-1 pl-5">
          {error ? (
            <p className="py-2 text-xs text-token-danger-foreground">
              {intl.formatMessage({
                id: "board.referencedBySection.loadFailed",
                defaultMessage: "Couldn’t load references.",
              })}
            </p>
          ) : loading ? (
            <p className="py-2 text-xs text-token-description-foreground">
              {intl.formatMessage({
                id: "board.referencedBySection.loading",
                defaultMessage: "Loading…",
              })}
            </p>
          ) : items.length === 0 ? (
            <p className="py-2 text-xs text-token-description-foreground">
              {intl.formatMessage({
                id: "board.referencedBySection.noReferences",
                defaultMessage: "No Pages reference this Page.",
              })}
            </p>
          ) : (
            <div className="divide-y divide-token-border-subtle">
              {items.map((item) => (
                <button
                  key={`${item.sourcePageId}:${item.sourceBlockId}`}
                  type="button"
                  className="group flex w-full items-start gap-2 py-2 text-left"
                  onClick={() => onOpen(item)}
                >
                  <PageIcon className="icon-xs mt-0.5 shrink-0 text-token-description-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-token-text-primary group-hover:underline">
                      {item.sourceTitle ||
                        intl.formatMessage({
                          id: "board.referencedBySection.untitled",
                          defaultMessage: "Untitled Page",
                        })}
                    </span>
                    <span className="block truncate text-xs text-token-description-foreground">
                      {[
                        item.locationLabel,
                        item.presentations
                          .map((value) => intl.formatMessage(PRESENTATION_LABELS[value]))
                          .join(" · "),
                      ]
                        .filter(Boolean)
                        .join(" — ")}
                    </span>
                  </span>
                  {item.occurrenceCount > 1 ? (
                    <span className="shrink-0 text-xs tabular-nums text-token-description-foreground">
                      ×{item.occurrenceCount}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          )}

          {hasMore && !error ? (
            <button
              type="button"
              className="mt-1 py-1 text-xs font-medium text-token-text-secondary hover:text-token-text-primary disabled:opacity-50"
              disabled={loadingMore}
              onClick={onLoadMore}
            >
              {loadingMore
                ? intl.formatMessage({
                    id: "board.referencedBySection.loadingMore",
                    defaultMessage: "Loading…",
                  })
                : intl.formatMessage({
                    id: "board.referencedBySection.showMore",
                    defaultMessage: "Show more",
                  })}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function PageStageReferencedBy({
  routingContext,
  pageId,
  onOpenPage,
}: {
  readonly routingContext: ContentRoutingContext;
  readonly pageId: string;
  readonly onOpenPage?: (input: {
    readonly routingContext: ContentRoutingContext;
    readonly pageId: string;
    readonly titleSnapshot?: string;
    readonly sourceBlockId?: string;
  }) => void | Promise<void>;
}) {
  const backlinks = usePageBacklinks(routingContext, pageId);
  return (
    <ReferencedBySection
      {...backlinks}
      onOpen={(item) => {
        void onOpenPage?.({
          routingContext,
          pageId: item.sourcePageId,
          titleSnapshot: item.sourceTitle,
          sourceBlockId: item.sourceBlockId,
        });
      }}
      onLoadMore={() => {
        void backlinks.loadMore();
      }}
    />
  );
}
