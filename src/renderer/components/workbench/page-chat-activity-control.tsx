import { useInfiniteQuery } from "@tanstack/react-query";
import { useState, type MouseEvent } from "react";

import { ActivitySpinnerIcon, CloseIcon } from "@/components/shared/icons";
import { PageChatActivityGlyph } from "@/components/shared/page-chat-activity-glyph";
import { NodexButton } from "@/components/ui/button";
import {
  NodexPopover,
  NodexPopoverContent,
  NodexPopoverTitle,
  NodexPopoverTrigger,
} from "@/components/ui/popover";
import { NodexTooltip } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/toast";
import {
  presentPageChatActivity,
  presentPageChatItemActivity,
} from "@/lib/page-chat-activity-presentation";
import { pageChatWindowQueryOptions } from "@/lib/query-options";
import type { PageChatActivitySummary, PageChatItem } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface PageChatActivityDetailOverride {
  readonly items: readonly PageChatItem[];
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly hasMore?: boolean;
  readonly loadingMore?: boolean;
  readonly onLoadMore?: () => Promise<void> | void;
}

export interface PageChatActivityControlProps {
  readonly pageAccessProjectId: string;
  readonly pageId: string;
  readonly summary: PageChatActivitySummary;
  readonly onOpenChat: (sessionId: string) => Promise<void> | void;
  readonly onRemoveRelation?: (sessionId: string) => Promise<void> | void;
  readonly idleVisibilityClassName?: string;
  readonly detailOverride?: PageChatActivityDetailOverride;
}

function RelatedChatRow({
  item,
  removing,
  onOpen,
  onRemove,
}: {
  readonly item: PageChatItem;
  readonly removing: boolean;
  readonly onOpen: () => void;
  readonly onRemove?: () => void;
}) {
  const activity = presentPageChatItemActivity(item);
  const projectLabel = item.projectName?.trim() || "Chats";
  return (
    <div
      className="group/related-chat flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-token-list-hover-background"
      data-related-chat-session-id={item.sessionId}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-token-focus"
        onClick={onOpen}
      >
        <PageChatActivityGlyph
          activity={activity}
          unreadRingClassName="ring-token-dropdown-background"
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate text-xs font-medium text-token-foreground">
              {item.displayTitle}
            </span>
            <span className="shrink-0 text-[10px] text-token-description-foreground">
              {projectLabel}
            </span>
          </span>
          <span className="block truncate text-[11px] text-token-description-foreground">
            {item.threadPreview.trim() || (item.threadId ? "No preview" : "No thread yet")}
          </span>
        </span>
      </button>
      {onRemove ? (
        <NodexButton
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove relation to ${item.displayTitle}`}
          disabled={removing}
          className="size-6 text-token-description-foreground opacity-0 group-hover/related-chat:opacity-100 group-focus-within/related-chat:opacity-100"
          onClick={onRemove}
        >
          {removing ? <ActivitySpinnerIcon className="size-3" /> : <CloseIcon className="size-3" />}
        </NodexButton>
      ) : null}
    </div>
  );
}

export function PageChatActivityControl({
  pageAccessProjectId,
  pageId,
  summary,
  onOpenChat,
  onRemoveRelation,
  idleVisibilityClassName,
  detailOverride,
}: PageChatActivityControlProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [removingSessionId, setRemovingSessionId] = useState<string | null>(null);
  const activity = presentPageChatActivity(summary);
  const detailQuery = useInfiniteQuery({
    ...pageChatWindowQueryOptions({
      pageAccessProjectId,
      pageId,
      includeArchived: false,
      first: 20,
    }),
    enabled: pickerOpen && !detailOverride && summary.relatedCount > 0,
  });
  if (summary.relatedCount === 0) return null;

  const queriedItems = detailQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const items = detailOverride?.items ?? queriedItems;
  const loading = detailOverride ? detailOverride.loading === true : detailQuery.isPending;
  const error = detailOverride
    ? (detailOverride.error ?? null)
    : detailQuery.error
      ? "Couldn’t load linked chats"
      : null;
  const hasMore = detailOverride ? detailOverride.hasMore === true : detailQuery.hasNextPage;
  const loadingMore = detailOverride
    ? detailOverride.loadingMore === true
    : detailQuery.isFetchingNextPage;
  const openRelatedChat = (sessionId: string): void => {
    setPickerOpen(false);
    void Promise.resolve(onOpenChat(sessionId)).catch((cause) => {
      toast.danger(cause instanceof Error ? cause.message : "Couldn’t open linked chat");
    });
  };
  const removeRelation = (item: PageChatItem): void => {
    if (!onRemoveRelation || removingSessionId) return;
    setRemovingSessionId(item.sessionId);
    void Promise.resolve(onRemoveRelation(item.sessionId))
      .then(async () => {
        if (items.length <= 1) {
          setPickerOpen(false);
          return;
        }
        if (!detailOverride) await detailQuery.refetch();
      })
      .catch((cause) => {
        toast.danger(cause instanceof Error ? cause.message : "Couldn’t remove relation");
      })
      .finally(() => setRemovingSessionId(null));
  };
  const handleTriggerClick = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    // Tooltip and Popover both compose this button. Own the
    // primary action here so production event composition cannot lose it.
    event.preventDefault();
    if (summary.soleSessionId) {
      openRelatedChat(summary.soleSessionId);
      return;
    }
    setPickerOpen(!pickerOpen);
  };

  return (
    <NodexPopover
      open={pickerOpen}
      onOpenChange={(open) => {
        if (!open) {
          setPickerOpen(false);
          return;
        }
        if (summary.soleSessionId) {
          openRelatedChat(summary.soleSessionId);
          return;
        }
        setPickerOpen(true);
      }}
    >
      <NodexTooltip tooltipContent={activity.accessibleLabel} side="top" delayOpen>
        <NodexPopoverTrigger>
          <button
            type="button"
            aria-label={activity.accessibleLabel}
            data-page-chat-activity-control="true"
            className={cn(
              "relative flex size-5 shrink-0 items-center justify-center rounded outline-none transition-opacity",
              "focus-visible:ring-2 focus-visible:ring-token-focus",
              !activity.visibleAtRest && "opacity-0 focus-visible:opacity-100",
              !activity.visibleAtRest && idleVisibilityClassName,
            )}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={handleTriggerClick}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <PageChatActivityGlyph
              activity={activity}
              unreadRingClassName="ring-token-main-surface-primary"
            />
          </button>
        </NodexPopoverTrigger>
      </NodexTooltip>
      {pickerOpen ? (
        <NodexPopoverContent
          align="start"
          side="bottom"
          sideOffset={6}
          className="w-[320px] max-w-[calc(100vw-16px)] overflow-hidden p-1"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="flex items-center justify-between px-2 py-1.5">
            <NodexPopoverTitle className="text-xs">Linked chats</NodexPopoverTitle>
            <span className="text-[10px] tabular-nums text-token-description-foreground">
              {summary.relatedCount}
            </span>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {loading ? (
              <div className="flex h-16 items-center justify-center text-token-description-foreground">
                <ActivitySpinnerIcon className="size-3.5" />
              </div>
            ) : error ? (
              <div className="px-2 py-3 text-xs text-token-error-foreground">
                <p>{error}</p>
                {!detailOverride ? (
                  <NodexButton
                    variant="ghost"
                    size="xs"
                    className="mt-1"
                    onClick={() => void detailQuery.refetch()}
                  >
                    Retry
                  </NodexButton>
                ) : null}
              </div>
            ) : items.length === 0 ? (
              <p className="px-2 py-3 text-xs text-token-description-foreground">
                No linked chats remain.
              </p>
            ) : (
              items.map((item) => (
                <RelatedChatRow
                  key={item.sessionId}
                  item={item}
                  removing={removingSessionId === item.sessionId}
                  onOpen={() => openRelatedChat(item.sessionId)}
                  onRemove={onRemoveRelation ? () => removeRelation(item) : undefined}
                />
              ))
            )}
          </div>
          {hasMore ? (
            <NodexButton
              variant="ghost"
              size="xs"
              disabled={loadingMore}
              className="mt-1 w-full"
              onClick={() => {
                if (detailOverride?.onLoadMore) {
                  void detailOverride.onLoadMore();
                  return;
                }
                void detailQuery.fetchNextPage();
              }}
            >
              {loadingMore ? <ActivitySpinnerIcon className="size-3" /> : null}
              Load more
            </NodexButton>
          ) : null}
        </NodexPopoverContent>
      ) : null}
    </NodexPopover>
  );
}
