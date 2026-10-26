import { useCallback, useEffect, useEffectEvent, useMemo, useRef, type ReactNode } from "react";
import {
  CODEX_SIDEBAR_DEFAULT_PAGER_ROW_CLASS,
  paginateCodexSidebarItems,
  type CodexSidebarPaginationResult,
} from "@/lib/codex-sidebar-pagination";
import { CodexSidebarPagerButton } from "./codex-sidebar";

/** A source the list reads in bounded windows after its first loaded rows. */
export interface SidebarPaginatedSource {
  readonly hasMore: boolean;
  /** A window read is in flight. */
  readonly loading?: boolean;
  /** Reading stopped on an error; filling resumes once the owner recovers. */
  readonly failed?: boolean;
  readonly loadMore: () => void | Promise<unknown>;
}

export interface SidebarPaginatedItemsProps<T> {
  readonly items: T[];
  readonly getKey: (item: T) => string;
  readonly maxItems?: number | null;
  /** Show more steps beyond the first page. The owner decides how long it is remembered. */
  readonly extraPages: number;
  readonly onExtraPagesChange?: (extraPages: number) => void;
  readonly forcedVisibleKey?: string | null;
  readonly suppressedKeys?: ReadonlySet<string>;
  readonly pagerClassName?: string;
  readonly source?: SidebarPaginatedSource;
  readonly children: (pagination: CodexSidebarPaginationResult<T>, pager: ReactNode) => ReactNode;
}

export function SidebarPaginatedItems<T>({
  items,
  getKey,
  maxItems = null,
  extraPages,
  onExtraPagesChange,
  forcedVisibleKey = null,
  suppressedKeys,
  pagerClassName = CODEX_SIDEBAR_DEFAULT_PAGER_ROW_CLASS,
  source,
  children,
}: SidebarPaginatedItemsProps<T>) {
  const focusRestoreTargetRef = useRef<HTMLButtonElement | null>(null);
  const expanded = extraPages > 0;
  const hasMoreAtSource = source?.hasMore ?? false;

  const pagination = useMemo(
    () =>
      paginateCodexSidebarItems({
        items,
        getKey,
        maxItems,
        extraPages,
        forcedVisibleKey,
        suppressedKeys,
        pagerEnabled: Boolean(onExtraPagesChange),
      }),
    [extraPages, forcedVisibleKey, getKey, items, maxItems, onExtraPagesChange, suppressedKeys],
  );

  // Keep one row beyond the revealed depth loaded, so a remembered depth refills itself
  // and Show more reveals rows that are already present.
  const loadedRows = pagination.filteredItems.length;
  const fillsFromSource =
    maxItems !== null &&
    hasMoreAtSource &&
    !source?.loading &&
    !source?.failed &&
    loadedRows <= pagination.visibleCount;
  // Each landed window or deeper reveal asks again while the list is still short.
  const fillRequest = fillsFromSource ? `${loadedRows}:${pagination.visibleCount}` : null;
  const loadMore = useEffectEvent(() => {
    void source?.loadMore();
  });
  useEffect(() => {
    if (fillRequest !== null) loadMore();
  }, [fillRequest]);

  const restorePagerFocus = useCallback(() => {
    queueMicrotask(() => {
      focusRestoreTargetRef.current?.focus();
    });
  }, []);

  const showMore = useCallback(() => {
    onExtraPagesChange?.(extraPages + 1);
    restorePagerFocus();
  }, [extraPages, onExtraPagesChange, restorePagerFocus]);

  const showLess = useCallback(() => {
    onExtraPagesChange?.(0);
    restorePagerFocus();
  }, [onExtraPagesChange, restorePagerFocus]);

  const hasOverflow = pagination.hasOverflow || hasMoreAtSource;
  const pager =
    pagination.showPager || hasMoreAtSource ? (
      <div className={pagerClassName} role="listitem">
        {hasOverflow ? (
          <CodexSidebarPagerButton ref={focusRestoreTargetRef} onClick={showMore}>
            Show more
          </CodexSidebarPagerButton>
        ) : null}
        {expanded ? (
          <CodexSidebarPagerButton
            ref={hasOverflow ? undefined : focusRestoreTargetRef}
            onClick={showLess}
          >
            Show less
          </CodexSidebarPagerButton>
        ) : null}
      </div>
    ) : null;

  return <>{children(pagination, pager)}</>;
}
