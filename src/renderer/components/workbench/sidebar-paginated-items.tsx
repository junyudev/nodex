import { useCallback, useMemo, useRef, type ReactNode } from "react";
import {
  CODEX_SIDEBAR_DEFAULT_PAGER_ROW_CLASS,
  paginateCodexSidebarItems,
  type CodexSidebarPaginationResult,
} from "@/lib/codex-sidebar-pagination";
import { CodexSidebarPagerButton } from "./codex-sidebar";

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
  readonly hasMoreAtSource?: boolean;
  readonly onLoadMore?: () => void | Promise<void>;
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
  hasMoreAtSource = false,
  onLoadMore,
  children,
}: SidebarPaginatedItemsProps<T>) {
  const focusRestoreTargetRef = useRef<HTMLButtonElement | null>(null);
  const expanded = extraPages > 0;

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

  const restorePagerFocus = useCallback(() => {
    queueMicrotask(() => {
      focusRestoreTargetRef.current?.focus();
    });
  }, []);

  const showMore = useCallback(() => {
    if (hasMoreAtSource) void onLoadMore?.();
    onExtraPagesChange?.(extraPages + 1);
    restorePagerFocus();
  }, [extraPages, hasMoreAtSource, onExtraPagesChange, onLoadMore, restorePagerFocus]);

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
