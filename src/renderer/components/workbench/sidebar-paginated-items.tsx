import { FormattedMessage } from "@/lib/i18n";
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
  clampCodexSidebarExtraPages,
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
  /** The most rows Show more reveals, for a list whose depths belong to a page of its own. */
  readonly revealLimit?: number;
  /** Offered after Show more while the list holds rows it does not show, such as its page. */
  readonly overflowAction?: ReactNode;
  /** Said where Show more was once the list has shown everything it holds. */
  readonly endNote?: ReactNode;
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
  revealLimit,
  overflowAction,
  endNote,
  children,
}: SidebarPaginatedItemsProps<T>) {
  const focusRestoreTargetRef = useRef<HTMLButtonElement | null>(null);
  const pagerRef = useRef<HTMLDivElement | null>(null);
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
  // A remembered depth past the reveal limit shows the limit.
  const depth = clampCodexSidebarExtraPages(extraPages, maxItems, revealLimit);
  // The pager and source filling follow the owner's depth; the rows follow a fold in flight.
  const pagination = useMemo(() => paginate(depth), [depth, paginate]);
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

  const { clipRef, contentRef, contentHeight, fold, hold, interruptFold, pinPager } =
    useSidebarPagerMotion(!fillsFromSource && !source?.loading);
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
    onExtraPagesChange?.(depth + 1);
    restorePagerFocus();
  }, [depth, hold, interruptFold, onExtraPagesChange, restorePagerFocus]);

  const { canShowLess } = pagination;
  const showLess = useCallback(() => {
    if (!canShowLess) return;
    interruptFold();
    const onScreen = heldExtraPages ?? depth;
    const keepPager = pinPager(pagerRef.current);
    const showFirstPage = () =>
      flushSync(() => {
        setHeldExtraPages(null);
        onExtraPagesChange?.(0);
      });
    if (!hold()) {
      showFirstPage();
      keepPager?.();
      restorePagerFocus();
      return;
    }
    // Lay out the first page to learn the list's folded height, then bring back the rows on
    // screen before the frame paints and fold the list up past them.
    showFirstPage();
    const foldedHeight = contentHeight();
    flushSync(() => setHeldExtraPages(onScreen));
    if (foldedHeight === null) setHeldExtraPages(null);
    else fold(foldedHeight, () => setHeldExtraPages(null), keepPager);
    restorePagerFocus();
  }, [
    canShowLess,
    contentHeight,
    depth,
    fold,
    heldExtraPages,
    hold,
    interruptFold,
    onExtraPagesChange,
    pinPager,
    restorePagerFocus,
  ]);

  const hasOverflow = pagination.hasOverflow || hasMoreAtSource;
  // Rows the depth asks for that reading stopped short of: the pager offers the read again.
  const readFailed =
    Boolean(source?.failed) && hasMoreAtSource && loadedRows <= pagination.visibleCount;
  const offersShowMore =
    hasOverflow &&
    (revealLimit === undefined || maxItems === null || pagination.visibleCount < revealLimit);
  const lead = readFailed ? (
    <CodexSidebarPagerButton ref={focusRestoreTargetRef} onClick={() => void source?.loadMore()}>
      <FormattedMessage
        id="workbench.sidebarPaginatedItems.retry"
        defaultMessage="Couldn’t load more · Retry"
      />
    </CodexSidebarPagerButton>
  ) : offersShowMore ? (
    <CodexSidebarPagerButton ref={focusRestoreTargetRef} onClick={showMore}>
      <FormattedMessage id="workbench.sidebarPaginatedItems.showMore" defaultMessage="Show more" />
    </CodexSidebarPagerButton>
  ) : !hasOverflow && canShowLess && endNote != null ? (
    <span className="px-2 py-0.5 text-sm leading-[18px] text-token-description-foreground -ml-[9px] select-none">
      {endNote}
    </span>
  ) : null;
  const pager =
    pagination.showPager || hasMoreAtSource ? (
      <div ref={pagerRef} className={pagerClassName} role="listitem">
        {lead}
        {hasOverflow ? overflowAction : null}
        {canShowLess ? (
          <CodexSidebarPagerButton
            ref={offersShowMore || readFailed ? undefined : focusRestoreTargetRef}
            onClick={showLess}
          >
            <FormattedMessage
              id="workbench.sidebarPaginatedItems.showLess"
              defaultMessage="Show less"
            />
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
