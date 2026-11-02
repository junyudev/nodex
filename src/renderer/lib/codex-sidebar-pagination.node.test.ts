import { describe, expect, test } from "vite-plus/test";
import {
  CODEX_SIDEBAR_PROJECT_GROUP_MAX_GROUPS,
  CODEX_SIDEBAR_PROJECTLESS_THREAD_MAX_ITEMS,
  CODEX_SIDEBAR_PROJECT_THREAD_MAX_ITEMS,
  paginateCodexSidebarItems,
} from "./codex-sidebar-pagination";

function items(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `item-${index + 1}`);
}

function paginate(
  count: number,
  extraPages: number,
  options: { forcedVisibleKey?: string; moreAtSource?: boolean; maxItems?: number } = {},
) {
  return paginateCodexSidebarItems({
    items: items(count),
    getKey: (item) => item,
    maxItems: options.maxItems ?? CODEX_SIDEBAR_PROJECT_THREAD_MAX_ITEMS,
    extraPages,
    forcedVisibleKey: options.forcedVisibleKey,
    moreAtSource: options.moreAtSource,
  });
}

describe("paginateCodexSidebarItems", () => {
  test("reveals five more rows with each Show more", () => {
    expect([0, 1, 2, 3, 4].map((depth) => paginate(23, depth).visibleItems.length)).toEqual([
      5, 10, 15, 20, 23,
    ]);
    expect(paginate(23, 3).hasOverflow).toBe(true);
    expect(paginate(23, 4).hasOverflow).toBe(false);
  });

  test("Show less hides the last five rows revealed and stops at the first page", () => {
    expect(paginate(23, 4).lessExtraPages).toBe(3);
    expect(paginate(23, 1).lessExtraPages).toBe(0);
    expect(paginate(23, 0).lessExtraPages).toBeNull();
  });

  test("Show less steps back from the rows a remembered depth still shows", () => {
    // Depth 4 would show 25 rows, but 12 remain: they fill depth 2, so Show less returns to 1.
    const result = paginate(12, 4);

    expect(result.visibleItems.length).toBe(12);
    expect(result.lessExtraPages).toBe(1);
    expect(paginate(12, result.lessExtraPages ?? 0).visibleItems.length).toBe(10);
  });

  test("shows a lone last row instead of paging it behind Show more", () => {
    const firstPage = paginate(6, 0);
    expect(firstPage.visibleItems.length).toBe(6);
    expect(firstPage.showPager).toBe(false);

    const revealed = paginate(11, 1);
    expect(revealed.visibleItems.length).toBe(11);
    expect(revealed.hasOverflow).toBe(false);
    expect(revealed.lessExtraPages).toBe(0);
  });

  test("keeps a lone hidden row paged while the source may hold more", () => {
    const result = paginate(6, 0, { moreAtSource: true });

    expect(result.visibleItems.length).toBe(5);
    expect(result.hasOverflow).toBe(true);
  });

  test("keeps the remembered depth for filling from a source", () => {
    expect(paginate(12, 4, { moreAtSource: true }).visibleCount).toBe(25);
  });

  test("starts Projects at five groups and projectless chats at fifty", () => {
    const projects = paginate(8, 0, { maxItems: CODEX_SIDEBAR_PROJECT_GROUP_MAX_GROUPS });
    expect(projects.visibleItems.length).toBe(5);
    expect(projects.showPager).toBe(true);

    const chats = paginate(57, 0, { maxItems: CODEX_SIDEBAR_PROJECTLESS_THREAD_MAX_ITEMS });
    expect(chats.visibleItems.length).toBe(50);
    expect(
      paginate(57, 1, { maxItems: CODEX_SIDEBAR_PROJECTLESS_THREAD_MAX_ITEMS }).visibleItems,
    ).toHaveLength(55);
  });

  test("filters suppressed items before slicing", () => {
    const result = paginateCodexSidebarItems({
      items: items(7),
      getKey: (item) => item,
      maxItems: CODEX_SIDEBAR_PROJECT_THREAD_MAX_ITEMS,
      extraPages: 0,
      suppressedKeys: new Set(["item-1", "item-3"]),
    });

    expect(result.visibleItems).toEqual(["item-2", "item-4", "item-5", "item-6", "item-7"]);
    expect(result.showPager).toBe(false);
  });

  test("appends a forced visible overflow item once", () => {
    const result = paginate(8, 0, { forcedVisibleKey: "item-8" });

    expect(result.visibleItems).toEqual([
      "item-1",
      "item-2",
      "item-3",
      "item-4",
      "item-5",
      "item-8",
    ]);
    expect(result.showPager).toBe(true);
  });

  test("keeps the page unchanged when the forced item is already visible", () => {
    for (const forcedVisibleKey of ["item-1", "item-5"]) {
      const result = paginate(8, 0, { forcedVisibleKey });

      expect(result.visibleItems).toEqual(["item-1", "item-2", "item-3", "item-4", "item-5"]);
      expect(result.showPager).toBe(true);
    }
  });

  test("offers no pager when the forced item is the only one beyond the page", () => {
    for (const extraPages of [0, 1]) {
      const result = paginate(6, extraPages, { forcedVisibleKey: "item-6" });

      expect(result.visibleItems.length).toBe(6);
      expect(result.showPager).toBe(false);
    }
  });

  test("offers Show less only when stepping back would hide an unforced item", () => {
    const hidesItem = paginate(7, 1, { forcedVisibleKey: "item-1" });
    expect(hidesItem.visibleItems.length).toBe(7);
    expect(hidesItem.lessExtraPages).toBe(0);

    const hidesOnlyForced = paginate(7, 1, { forcedVisibleKey: "item-7" });
    expect(hidesOnlyForced.visibleItems.length).toBe(7);
    expect(hidesOnlyForced.lessExtraPages).toBeNull();
  });
});
