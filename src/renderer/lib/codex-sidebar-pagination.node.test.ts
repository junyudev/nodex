import { describe, expect, test } from "vite-plus/test";
import {
  CODEX_SIDEBAR_PAGE_INCREMENT,
  CODEX_SIDEBAR_PROJECT_GROUP_MAX_GROUPS,
  CODEX_SIDEBAR_PROJECTLESS_THREAD_MAX_ITEMS,
  CODEX_SIDEBAR_PROJECT_THREAD_MAX_ITEMS,
  paginateCodexSidebarItems,
} from "./codex-sidebar-pagination";

function items(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `item-${index + 1}`);
}

describe("paginateCodexSidebarItems", () => {
  test("matches Codex project thread page sizes", () => {
    const allItems = items(30);
    const collapsed = paginateCodexSidebarItems({
      items: allItems,
      getKey: (item) => item,
      maxItems: CODEX_SIDEBAR_PROJECT_THREAD_MAX_ITEMS,
      extraPages: 0,
    });
    const expandedFirst = paginateCodexSidebarItems({
      items: allItems,
      getKey: (item) => item,
      maxItems: CODEX_SIDEBAR_PROJECT_THREAD_MAX_ITEMS,
      extraPages: 1,
    });
    const expandedSecond = paginateCodexSidebarItems({
      items: allItems,
      getKey: (item) => item,
      maxItems: CODEX_SIDEBAR_PROJECT_THREAD_MAX_ITEMS,
      extraPages: 2,
    });

    expect(CODEX_SIDEBAR_PAGE_INCREMENT).toBe(10);
    expect(collapsed.visibleItems.length).toBe(5);
    expect(expandedFirst.visibleItems.length).toBe(15);
    expect(expandedSecond.visibleItems.length).toBe(25);
  });

  test("matches Codex project group max count", () => {
    const result = paginateCodexSidebarItems({
      items: items(8),
      getKey: (item) => item,
      maxItems: CODEX_SIDEBAR_PROJECT_GROUP_MAX_GROUPS,
      extraPages: 0,
    });

    expect(result.visibleItems.length).toBe(5);
    expect(result.showPager).toBe(true);
  });

  test("starts projectless chats at fifty with pager controls", () => {
    const result = paginateCodexSidebarItems({
      items: items(55),
      getKey: (item) => item,
      maxItems: CODEX_SIDEBAR_PROJECTLESS_THREAD_MAX_ITEMS,
      extraPages: 0,
    });

    expect(result.visibleItems.length).toBe(50);
    expect(result.hiddenItems.length).toBe(5);
    expect(result.showPager).toBe(true);
  });

  test("filters suppressed items before slicing", () => {
    const result = paginateCodexSidebarItems({
      items: items(7),
      getKey: (item) => item,
      maxItems: CODEX_SIDEBAR_PROJECT_THREAD_MAX_ITEMS,
      extraPages: 0,
      suppressedKeys: new Set(["item-1", "item-3"]),
    });

    expect(JSON.stringify(result.visibleItems)).toBe(
      JSON.stringify(["item-2", "item-4", "item-5", "item-6", "item-7"]),
    );
    expect(result.showPager).toBe(false);
  });

  test("appends a forced visible overflow item once", () => {
    const result = paginateCodexSidebarItems({
      items: items(8),
      getKey: (item) => item,
      maxItems: CODEX_SIDEBAR_PROJECT_THREAD_MAX_ITEMS,
      extraPages: 0,
      forcedVisibleKey: "item-8",
    });

    expect(JSON.stringify(result.visibleItems)).toBe(
      JSON.stringify(["item-1", "item-2", "item-3", "item-4", "item-5", "item-8"]),
    );
    expect(result.showPager).toBe(true);
  });

  test("keeps the page unchanged when the forced item is already visible", () => {
    for (const forcedVisibleKey of ["item-1", "item-5"]) {
      const result = paginateCodexSidebarItems({
        items: items(8),
        getKey: (item) => item,
        maxItems: CODEX_SIDEBAR_PROJECT_THREAD_MAX_ITEMS,
        extraPages: 0,
        forcedVisibleKey,
      });

      expect(JSON.stringify(result.visibleItems)).toBe(
        JSON.stringify(["item-1", "item-2", "item-3", "item-4", "item-5"]),
      );
      expect(result.showPager).toBe(true);
    }
  });

  test("offers no pager when the forced item is the only one beyond the page", () => {
    for (const extraPages of [0, 1]) {
      const result = paginateCodexSidebarItems({
        items: items(6),
        getKey: (item) => item,
        maxItems: CODEX_SIDEBAR_PROJECT_THREAD_MAX_ITEMS,
        extraPages,
        forcedVisibleKey: "item-6",
      });

      expect(result.visibleItems.length).toBe(6);
      expect(result.showPager).toBe(false);
    }
  });

  test("offers Show less when collapsing would hide an unforced item", () => {
    const result = paginateCodexSidebarItems({
      items: items(6),
      getKey: (item) => item,
      maxItems: CODEX_SIDEBAR_PROJECT_THREAD_MAX_ITEMS,
      extraPages: 1,
      forcedVisibleKey: "item-1",
    });

    expect(result.visibleItems.length).toBe(6);
    expect(result.hasOverflow).toBe(false);
    expect(result.showPager).toBe(true);
  });
});
