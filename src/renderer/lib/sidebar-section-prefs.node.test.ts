import { describe, expect, test } from "vite-plus/test";
import {
  makeDefaultSidebarCollapsibleSectionsState,
  normalizeSidebarCollapsibleSectionsState,
  normalizeSidebarSectionExtraPages,
  withSidebarSectionExtraPages,
} from "./sidebar-section-prefs";

describe("sidebar-section-prefs", () => {
  test("normalizes built-in state and preserves bounded custom disclosure keys", () => {
    const defaults = makeDefaultSidebarCollapsibleSectionsState();
    const state = normalizeSidebarCollapsibleSectionsState({
      pinned: true,
      projects: "collapsed",
      chats: true,
      custom: true,
      "custom:section-alpha": true,
    });

    expect(defaults.pinned).toBe(false);
    expect(defaults.pages).toBe(false);
    expect(state.pinned).toBe(true);
    expect(state.projects).toBe(false);
    expect(state.chats).toBe(true);
    expect(state["custom:section-alpha"]).toBe(true);
    expect(state.custom).toBeUndefined();
  });

  test("migrates the retired Library collapse preference to Pages", () => {
    expect(normalizeSidebarCollapsibleSectionsState({ library: true }).pages).toBe(true);
  });

  test("keeps only positive whole Show more depths for known sections", () => {
    expect(
      normalizeSidebarSectionExtraPages({
        pages: 3,
        projects: 0,
        chats: -1,
        pinned: 2.5,
        "custom:section-alpha": 2,
      }),
    ).toEqual({ pages: 3 });
    expect(normalizeSidebarSectionExtraPages({ pages: 1e9 }).pages).toBe(1000);
    expect(normalizeSidebarSectionExtraPages(["pages"])).toEqual({});
  });

  test("records a depth and forgets a section that returns to its first page", () => {
    const deeper = withSidebarSectionExtraPages({}, "pages", 2);
    expect(deeper).toEqual({ pages: 2 });
    expect(withSidebarSectionExtraPages(deeper, "pages", 2)).toBe(deeper);
    expect(withSidebarSectionExtraPages(deeper, "pages", 0)).toEqual({});
  });
});
