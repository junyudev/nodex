export const CODEX_SIDEBAR_PAGE_INCREMENT = 10;
export const CODEX_SIDEBAR_PROJECT_THREAD_MAX_ITEMS = 5;
export const CODEX_SIDEBAR_PROJECTLESS_THREAD_MAX_ITEMS = 50;
export const CODEX_SIDEBAR_PROJECT_GROUP_MAX_GROUPS = 5;

export const CODEX_SIDEBAR_PAGER_BUTTON_CLASS =
  "border-token-border no-drag cursor-interaction flex items-center gap-1 border whitespace-nowrap select-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-full text-token-muted-foreground enabled:hover:bg-transparent data-[state=open]:bg-transparent hover:text-token-foreground border-transparent px-2 py-0.5 text-sm leading-[18px] -ml-[9px] text-token-description-foreground hover:text-token-foreground";
export const CODEX_SIDEBAR_DEFAULT_PAGER_ROW_CLASS = "flex items-center gap-1 px-row-x py-0.5";
// Match grouped Session titles: 8px row inset + 16px status slot + 8px title gap.
// The pager button cancels its own 9px border/padding inset.
export const CODEX_SIDEBAR_PROJECT_THREAD_PAGER_ROW_CLASS =
  "flex gap-1 px-8 py-1 after:block after:h-px after:content-[''] last:after:hidden";

export interface CodexSidebarPaginationResult<T> {
  filteredItems: T[];
  visibleItems: T[];
  hiddenItems: T[];
  visibleCount: number;
  hasOverflow: boolean;
  showPager: boolean;
}

export function paginateCodexSidebarItems<T>(input: {
  items: readonly T[];
  getKey: (item: T) => string;
  maxItems?: number | null;
  expanded: boolean;
  extraPageCount: number;
  forcedVisibleKey?: string | null;
  suppressedKeys?: ReadonlySet<string>;
  pagerEnabled?: boolean;
}): CodexSidebarPaginationResult<T> {
  const filteredItems = input.suppressedKeys
    ? input.items.filter((item) => !input.suppressedKeys?.has(input.getKey(item)))
    : [...input.items];
  const maxItems = input.maxItems ?? null;
  const visibleCount =
    maxItems === null
      ? filteredItems.length
      : maxItems + (input.expanded ? CODEX_SIDEBAR_PAGE_INCREMENT * input.extraPageCount : 0);
  const forcedVisibleItem = input.forcedVisibleKey
    ? (filteredItems.find((item) => input.getKey(item) === input.forcedVisibleKey) ?? null)
    : null;
  const forcedVisibleKey = forcedVisibleItem === null ? null : input.getKey(forcedVisibleItem);
  const pageableItems =
    forcedVisibleItem === null
      ? filteredItems
      : filteredItems.filter((item) => input.getKey(item) !== forcedVisibleKey);
  const visiblePageableItems = pageableItems.slice(0, visibleCount);
  const visibleItemKeys = new Set([
    ...visiblePageableItems.map(input.getKey),
    ...(forcedVisibleKey === null ? [] : [forcedVisibleKey]),
  ]);
  const finalVisibleItems = filteredItems.filter((item) => visibleItemKeys.has(input.getKey(item)));
  const hiddenItems = filteredItems.filter((item) => !visibleItemKeys.has(input.getKey(item)));
  const hasOverflow = hiddenItems.length > 0;
  const pagerEnabled = input.pagerEnabled !== false;

  return {
    filteredItems,
    visibleItems: finalVisibleItems,
    hiddenItems,
    visibleCount,
    hasOverflow,
    showPager: Boolean(
      pagerEnabled &&
      maxItems !== null &&
      pageableItems.length > maxItems &&
      (input.expanded || hasOverflow),
    ),
  };
}
