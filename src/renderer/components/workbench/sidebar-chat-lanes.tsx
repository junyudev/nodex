import type { ReactNode } from "react";
import { defineMessages, useIntl, type MessageDescriptor } from "@/lib/i18n";
import { CODEX_SIDEBAR_PROJECTLESS_THREAD_MAX_ITEMS } from "@/lib/codex-sidebar-pagination";
import type { SidebarChatShelf } from "@/lib/sidebar-chat-lifecycle";
import type { SidebarGroupStatus } from "@/lib/sidebar-status";
import { SIDEBAR_GROUP_STATUS_LABELS } from "@/lib/sidebar-status";
import type { WorkbenchSessionCollectionState } from "@/lib/use-workbench-session-catalog";
import { CheckmarkIcon, OpenInIcon } from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  CODEX_SIDEBAR_SECTION_ACTION_BUTTON_CLASS,
  CodexSidebarPagerButton,
  CodexSidebarSection,
} from "./codex-sidebar";
import { SidebarPaginatedItems, SidebarPaginatedRows } from "./sidebar-paginated-items";
import { SidebarStatusIndicator } from "./sidebar-status-indicator";

/** Settled chats shown before Show more; a settled chat is rarely the one a person wants. */
const SIDEBAR_SETTLED_SHELF_MAX_ITEMS = 10;
/** The most settled chats the sidebar reveals; older ones are browsed on the Settled page. */
const SIDEBAR_SETTLED_SHELF_REVEAL_LIMIT = 30;

const SHELF_HEADINGS: Readonly<Record<SidebarChatShelf, MessageDescriptor>> = defineMessages({
  pinned: { id: "workbench.sidebarChatLanes.pinned", defaultMessage: "Pinned" },
  active: { id: "workbench.sidebarChatLanes.active", defaultMessage: "Active" },
  working: { id: "workbench.sidebarChatLanes.working", defaultMessage: "Working" },
  snoozed: { id: "workbench.sidebarChatLanes.snoozed", defaultMessage: "Snoozed" },
  settled: { id: "workbench.sidebarChatLanes.settled", defaultMessage: "Settled" },
});

/** What a lane says when it holds nothing; a lane with no line here hides instead. */
const SHELF_EMPTY_TEXT: Readonly<Partial<Record<SidebarChatShelf, MessageDescriptor>>> =
  defineMessages({
    active: {
      id: "workbench.sidebarChatLanes.activeEmpty",
      defaultMessage: "Nothing is waiting on you",
    },
    settled: {
      id: "workbench.sidebarChatLanes.settledEmpty",
      defaultMessage: "No settled chats yet",
    },
  });

function ShelfCount({ count }: { count: number }) {
  return (
    <span className="pe-1 text-xs text-token-description-foreground tabular-nums">{count}</span>
  );
}

function ShelfFallback({
  shelf,
  state,
  onRetry,
}: {
  shelf: SidebarChatShelf;
  state: WorkbenchSessionCollectionState;
  onRetry: () => void | Promise<void>;
}) {
  const intl = useIntl();
  const rowClassName = "px-row-x py-row-y text-sm text-token-description-foreground";
  if (state.kind === "loading" || state.kind === "idle")
    return (
      <div className={rowClassName} role="listitem">
        {intl.formatMessage({
          id: "workbench.sidebarChatLanes.loading",
          defaultMessage: "Loading chats...",
        })}
      </div>
    );
  if (state.kind === "error")
    return (
      <div className={rowClassName} role="listitem">
        <button
          type="button"
          className="hover:text-token-foreground"
          onClick={() => void onRetry()}
        >
          {intl.formatMessage({
            id: "workbench.sidebarChatLanes.retry",
            defaultMessage: "Retry chats",
          })}
        </button>
      </div>
    );
  const emptyText = SHELF_EMPTY_TEXT[shelf];
  return emptyText ? (
    <div className={rowClassName} role="listitem">
      {intl.formatMessage(emptyText)}
    </div>
  ) : null;
}

/**
 * One lane of the reader's chats across every Project. A lane that never shows an empty line
 * disappears while it holds nothing, so the sidebar lists only what exists.
 */
export function SidebarChatLaneSection({
  shelf,
  threadKeys,
  collapsed,
  onToggle,
  state,
  onRetry,
  attention,
  source,
  extraPages,
  onExtraPagesChange,
  forcedVisibleKey,
  fold = null,
  actions,
  tool,
  total,
  onOpenPage,
  renderThread,
  renderRows,
}: {
  shelf: SidebarChatShelf;
  threadKeys: readonly string[];
  collapsed: boolean;
  onToggle: () => void;
  state: WorkbenchSessionCollectionState;
  onRetry: () => void | Promise<void>;
  /** What the lane's chats ask of the reader, summarized while the lane is collapsed. */
  attention?: SidebarGroupStatus | null;
  /** Rows the list has not read yet. */
  source?: {
    readonly hasMore: boolean;
    readonly loadMore: () => void | Promise<void>;
    readonly loading?: boolean;
    readonly failed?: boolean;
  };
  /** How many chats the lane holds, read or not, for the way to its page. */
  total?: number | null;
  /** Opens the lane's own page, where its whole history is browsed. */
  onOpenPage?: () => void;
  extraPages: number;
  onExtraPagesChange: (extraPages: number) => void;
  forcedVisibleKey: string | null;
  /**
   * Folds the rows from `from` on behind one row that counts the chats it hides and says when they
   * return, as the Snoozed lane does with chats returning later.
   */
  fold?: { readonly from: number; readonly count: number; readonly range: string | null } | null;
  actions?: ReactNode;
  /** A control the lane's heading keeps in reach, such as the arrangement's view options. */
  tool?: ReactNode;
  renderThread: (threadKey: string) => ReactNode;
  /** Renders the visible rows together, for a lane whose rows drag into a new order. */
  renderRows?: (visibleThreadKeys: readonly string[]) => ReactNode;
}) {
  const intl = useIntl();
  const heading = intl.formatMessage(SHELF_HEADINGS[shelf]);
  const settled = state.kind === "ready";
  if (threadKeys.length === 0 && settled && !SHELF_EMPTY_TEXT[shelf]) return null;
  if (threadKeys.length === 0 && !settled && shelf !== "active" && shelf !== "settled") return null;
  const foldLabel = fold
    ? fold.range
      ? intl.formatMessage(
          {
            id: "workbench.sidebarChatLanes.laterUntil",
            defaultMessage: "{count} later · {range}",
          },
          { count: fold.count, range: fold.range },
        )
      : intl.formatMessage(
          { id: "workbench.sidebarChatLanes.later", defaultMessage: "{count} later" },
          { count: fold.count },
        )
    : null;

  return (
    <CodexSidebarSection
      heading={heading}
      collapsed={collapsed}
      onToggle={onToggle}
      tool={tool}
      actions={
        onOpenPage ? (
          <>
            {actions}
            <SidebarOpenLanePageButton heading={heading} onOpen={onOpenPage} />
          </>
        ) : (
          actions
        )
      }
      status={
        attention ? (
          <SidebarStatusIndicator
            status={attention}
            label={SIDEBAR_GROUP_STATUS_LABELS[attention]}
          />
        ) : threadKeys.length > 0 ? (
          <ShelfCount count={threadKeys.length} />
        ) : null
      }
    >
      <div data-app-action-sidebar-chat-lane={shelf}>
        <SidebarPaginatedItems
          items={threadKeys as string[]}
          getKey={(threadKey) => threadKey}
          maxItems={
            fold
              ? fold.from
              : shelf === "settled"
                ? SIDEBAR_SETTLED_SHELF_MAX_ITEMS
                : CODEX_SIDEBAR_PROJECTLESS_THREAD_MAX_ITEMS
          }
          // The later chats unfold together, and fold back together with Show less.
          pageIncrement={fold ? Math.max(1, threadKeys.length - fold.from) : undefined}
          showMoreLabel={foldLabel}
          extraPages={extraPages}
          onExtraPagesChange={onExtraPagesChange}
          forcedVisibleKey={forcedVisibleKey}
          source={
            source
              ? {
                  hasMore: source.hasMore,
                  loading: source.loading,
                  failed: state.kind === "error" || source.failed === true,
                  loadMore: source.loadMore,
                }
              : undefined
          }
          revealLimit={onOpenPage ? SIDEBAR_SETTLED_SHELF_REVEAL_LIMIT : undefined}
          overflowAction={
            onOpenPage ? (
              <CodexSidebarPagerButton
                onClick={onOpenPage}
                data-app-action-sidebar-lane-view-all=""
              >
                {intl.formatMessage(
                  {
                    id: "workbench.sidebarChatLanes.viewAll",
                    defaultMessage: "{count, plural, =0 {View all} other {View all #}}",
                  },
                  { count: total ?? 0 },
                )}
              </CodexSidebarPagerButton>
            ) : undefined
          }
          endNote={
            fold
              ? undefined
              : intl.formatMessage({
                  id: "workbench.sidebarChatLanes.endOfLane",
                  defaultMessage: "That’s all",
                })
          }
        >
          {(pagination, pager) => (
            <div className="isolate flex flex-col [contain:layout]">
              <div className="flex flex-col" role="list" aria-label={heading}>
                <SidebarPaginatedRows>
                  {renderRows
                    ? renderRows(pagination.visibleItems)
                    : pagination.visibleItems.map((threadKey) => renderThread(threadKey))}
                  {pagination.visibleItems.length === 0 || state.kind === "error" ? (
                    <ShelfFallback shelf={shelf} state={state} onRetry={onRetry} />
                  ) : null}
                </SidebarPaginatedRows>
                {pager}
              </div>
            </div>
          )}
        </SidebarPaginatedItems>
      </div>
    </CodexSidebarSection>
  );
}

function SidebarOpenLanePageButton({ heading, onOpen }: { heading: string; onOpen: () => void }) {
  const intl = useIntl();
  const label = intl.formatMessage(
    { id: "workbench.sidebarChatLanes.openLanePage", defaultMessage: "Open {lane}" },
    { lane: heading },
  );
  return (
    <NodexTooltip tooltipContent={label} side="bottom">
      <button
        type="button"
        aria-label={label}
        className={CODEX_SIDEBAR_SECTION_ACTION_BUTTON_CLASS}
        data-app-action-sidebar-lane-open-page=""
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
      >
        <OpenInIcon className="icon-xs" />
      </button>
    </NodexTooltip>
  );
}

/** Settles the Active chats the reader has read and that ask nothing more, with one Undo. */
export function SidebarSettleReadChatsButton({
  count,
  onSettle,
}: {
  count: number;
  onSettle: () => void | Promise<void>;
}) {
  const intl = useIntl();
  const label = intl.formatMessage(
    {
      id: "workbench.sidebarChatLanes.settleRead",
      defaultMessage: "{count, plural, one {Settle # read chat} other {Settle # read chats}}",
    },
    { count },
  );
  return (
    <NodexTooltip tooltipContent={label} side="bottom">
      <button
        type="button"
        aria-label={label}
        className={CODEX_SIDEBAR_SECTION_ACTION_BUTTON_CLASS}
        data-app-action-sidebar-settle-read=""
        onClick={(event) => {
          event.stopPropagation();
          void onSettle();
        }}
      >
        <CheckmarkIcon className="icon-xs" />
      </button>
    </NodexTooltip>
  );
}
