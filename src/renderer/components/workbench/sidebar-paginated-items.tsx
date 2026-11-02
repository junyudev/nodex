import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import {
  CODEX_SIDEBAR_DEFAULT_PAGER_ROW_CLASS,
  paginateCodexSidebarItems,
  type CodexSidebarPaginationResult,
} from "@/lib/codex-sidebar-pagination";
import { CodexSidebarPagerButton } from "./codex-sidebar";
import { useSidebarPagerMotion } from "./use-sidebar-pager-motion";

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
  readonly items: readonly T[];
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

interface SidebarPaginatedRowsMotion {
  readonly clipRef: RefObject<HTMLDivElement | null>;
  readonly contentRef: RefObject<HTMLDivElement | null>;
}

const SidebarPaginatedRowsContext = createContext<SidebarPaginatedRowsMotion | null>(null);

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
  const hasMoreAtSource = source?.hasMore ?? false;
  // While Show less folds the list, the rows it hides stay on screen at this depth.
  const [heldExtraPages, setHeldExtraPages] = useState<number | null>(null);

  const paginate = useCallback(
    (depth: number) =>
      paginateCodexSidebarItems({
        items,
        getKey,
        maxItems,
        extraPages: depth,
        forcedVisibleKey,
        suppressedKeys,
        pagerEnabled: Boolean(onExtraPagesChange),
        moreAtSource: hasMoreAtSource,
      }),
    [
      forcedVisibleKey,
      getKey,
      hasMoreAtSource,
      items,
      maxItems,
      onExtraPagesChange,
      suppressedKeys,
    ],
  );
  // The pager and source filling follow the owner's depth; the rows follow a fold in flight.
  const pagination = useMemo(() => paginate(extraPages), [extraPages, paginate]);
  const shown = useMemo(
    () => (heldExtraPages === null ? pagination : paginate(heldExtraPages)),
    [heldExtraPages, paginate, pagination],
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

  const { clipRef, contentRef, contentHeight, fold, hold, interruptFold } = useSidebarPagerMotion(
    !fillsFromSource && !source?.loading,
  );
  const rowsMotion = useMemo(() => ({ clipRef, contentRef }), [clipRef, contentRef]);

  // The pressed button can unmount when its direction runs out; keep focus on the pager
  // without scrolling the sidebar to it.
  const restorePagerFocus = useCallback(() => {
    queueMicrotask(() => {
      focusRestoreTargetRef.current?.focus({ preventScroll: true });
    });
  }, []);

  const showMore = useCallback(() => {
    // A press during a fold lets the rows it still covers go and unfolds from there.
    interruptFold();
    setHeldExtraPages(null);
    hold();
    onExtraPagesChange?.(extraPages + 1);
    restorePagerFocus();
  }, [extraPages, hold, interruptFold, onExtraPagesChange, restorePagerFocus]);

  const { lessExtraPages } = pagination;
  const showLess = useCallback(() => {
    if (lessExtraPages === null) return;
    interruptFold();
    const onScreen = heldExtraPages ?? extraPages;
    if (!hold()) {
      setHeldExtraPages(null);
      onExtraPagesChange?.(lessExtraPages);
      restorePagerFocus();
      return;
    }
    // Lay out the rows that remain to learn the list's folded height, then bring back the
    // rows on screen before the frame paints and fold the list up past them.
    flushSync(() => {
      setHeldExtraPages(null);
      onExtraPagesChange?.(lessExtraPages);
    });
    const foldedHeight = contentHeight();
    flushSync(() => setHeldExtraPages(onScreen));
    if (foldedHeight === null) setHeldExtraPages(null);
    else fold(foldedHeight, () => setHeldExtraPages(null));
    restorePagerFocus();
  }, [
    contentHeight,
    extraPages,
    fold,
    heldExtraPages,
    hold,
    interruptFold,
    lessExtraPages,
    onExtraPagesChange,
    restorePagerFocus,
  ]);

  const hasOverflow = pagination.hasOverflow || hasMoreAtSource;
  const pager =
    pagination.showPager || hasMoreAtSource ? (
      <div className={pagerClassName} role="listitem">
        {hasOverflow ? (
          <CodexSidebarPagerButton ref={focusRestoreTargetRef} onClick={showMore}>
            Show more
          </CodexSidebarPagerButton>
        ) : null}
        {lessExtraPages !== null ? (
          <CodexSidebarPagerButton
            ref={hasOverflow ? undefined : focusRestoreTargetRef}
            onClick={showLess}
          >
            Show less
          </CodexSidebarPagerButton>
        ) : null}
      </div>
    ) : null;

  return (
    <SidebarPaginatedRowsContext value={rowsMotion}>
      {children(shown, pager)}
    </SidebarPaginatedRowsContext>
  );
}

/**
 * The rows of a paginated list, with its pager rendered after this box. Pager presses ease
 * the box's height to the rows' new height while the pager rides its edge.
 */
export function SidebarPaginatedRows({ children }: { readonly children: ReactNode }) {
  const motion = useContext(SidebarPaginatedRowsContext);
  return (
    <div ref={motion?.clipRef} data-sidebar-paginated-rows="">
      <div ref={motion?.contentRef} className="flex flex-col">
        {children}
      </div>
    </div>
  );
}
