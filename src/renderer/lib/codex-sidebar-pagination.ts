/** Rows each Show more reveals. Show less returns a list to its first page. */
export const CODEX_SIDEBAR_PAGE_INCREMENT = 5;
export const CODEX_SIDEBAR_PROJECT_THREAD_MAX_ITEMS = 5;
export const CODEX_SIDEBAR_PROJECTLESS_THREAD_MAX_ITEMS = 50;
export const CODEX_SIDEBAR_PROJECT_GROUP_MAX_GROUPS = 5;

export const CODEX_SIDEBAR_PAGER_BUTTON_CLASS =
  "border-token-border no-drag cursor-interaction flex items-center gap-1 border whitespace-nowrap select-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-full text-token-muted-foreground enabled:hover:bg-transparent data-[state=open]:bg-transparent hover:text-token-foreground border-transparent px-2 py-0.5 text-sm leading-[18px] -ml-[9px] text-token-description-foreground hover:text-token-foreground transition-[color,opacity] duration-basic ease-basic";
export const CODEX_SIDEBAR_DEFAULT_PAGER_ROW_CLASS = "flex items-center gap-1 px-row-x py-0.5";
// Match grouped Session titles: 8px row inset + 16px status slot + 8px title gap.
// The pager button cancels its own 9px border/padding inset.
export const CODEX_SIDEBAR_PROJECT_THREAD_PAGER_ROW_CLASS =
  "flex gap-1 px-8 py-1 after:block after:h-px after:content-[''] last:after:hidden";

/**
 * The deepest Show more step a list takes when it reveals at most `revealLimit` rows; a
 * remembered depth beyond it shows the limit.
 */
export function clampCodexSidebarExtraPages(
  extraPages: number,
  maxItems: number | null,
  revealLimit: number | undefined,
): number {
  if (maxItems === null || revealLimit === undefined) return extraPages;
  const deepest = Math.max(0, Math.ceil((revealLimit - maxItems) / CODEX_SIDEBAR_PAGE_INCREMENT));
  return Math.min(extraPages, deepest);
}

export interface CodexSidebarPaginationResult<T> {
  filteredItems: T[];
  visibleItems: T[];
  /** Rows the remembered depth reveals; a list read in windows fills one row past it. */
  visibleCount: number;
  hasOverflow: boolean;
  /** Show less would hide a row by returning the list to its first page. */
  canShowLess: boolean;
  showPager: boolean;
}

export function paginateCodexSidebarItems<T>(input: {
  items: readonly T[];
  getKey: (item: T) => string;
  maxItems?: number | null;
  /** Show more steps beyond the first page; 0 is the first page. */
  extraPages: number;
  /** Rows each Show more step reveals. */
  pageIncrement?: number;
  forcedVisibleKey?: string | null;
  suppressedKeys?: ReadonlySet<string>;
  pagerEnabled?: boolean;
  /** The source holds rows beyond `items`, so even one hidden row keeps Show more. */
  moreAtSource?: boolean;
}): CodexSidebarPaginationResult<T> {
  const filteredItems = input.suppressedKeys
    ? input.items.filter((item) => !input.suppressedKeys?.has(input.getKey(item)))
    : [...input.items];
  const maxItems = input.maxItems ?? null;
  const pageEnd = (extraPages: number) =>
    maxItems === null
      ? filteredItems.length
      : maxItems + (input.pageIncrement ?? CODEX_SIDEBAR_PAGE_INCREMENT) * Math.max(0, extraPages);
  // The forced item is guaranteed visible without taking a page slot from anything else:
  // inside the page nothing changes, and beyond it the item joins in list order as one extra row.
  const forcedIndex =
    input.forcedVisibleKey == null
      ? -1
      : filteredItems.findIndex((item) => input.getKey(item) === input.forcedVisibleKey);
  // Unforced rows a depth hides. A lone last row is shown rather than paged behind a pager
  // row of the same height, unless the source may still hold more.
  const hiddenAt = (extraPages: number) => {
    const end = pageEnd(extraPages);
    const hidden = Math.max(0, filteredItems.length - end) - (forcedIndex >= end ? 1 : 0);
    return hidden === 1 && !input.moreAtSource ? 0 : hidden;
  };
  const hidden = hiddenAt(input.extraPages);
  const end = hidden === 0 ? filteredItems.length : pageEnd(input.extraPages);
  const visibleItems = filteredItems.filter((_, index) => index < end || index === forcedIndex);
  const hasOverflow = visibleItems.length < filteredItems.length;
  const pagerEnabled = input.pagerEnabled !== false;
  // Show less returns to the first page, so it is offered only while that page would hide
  // an unforced row the list shows now.
  const canShowLess = pagerEnabled && hiddenAt(0) > hidden;

  return {
    filteredItems,
    visibleItems,
    visibleCount: pageEnd(input.extraPages),
    hasOverflow,
    canShowLess,
    showPager: pagerEnabled && (hasOverflow || canShowLess),
  };
}
