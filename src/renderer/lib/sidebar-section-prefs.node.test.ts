import { describe, expect, test } from "vite-plus/test";
import {
  makeDefaultSidebarCollapsibleSectionsState,
  normalizeSidebarCollapsibleSectionsState,
  normalizeSidebarListExtraPages,
  withSidebarListExtraPages,
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

  test("keeps positive whole Show more depths for built-in, Project, and custom lists", () => {
    expect(
      normalizeSidebarListExtraPages({
        pages: 3,
        projects: 0,
        chats: -1,
        pinned: 2.5,
        "project:alpha": 2,
        "custom:section-alpha": 1,
        "project:": 4,
        library: 4,
      }),
    ).toEqual({ pages: 3, "project:alpha": 2, "custom:section-alpha": 1 });
    expect(normalizeSidebarListExtraPages({ pages: 1e9 }).pages).toBe(1000);
    expect(normalizeSidebarListExtraPages(["pages"])).toEqual({});
  });

  test("records a depth and forgets a list that returns to its first page", () => {
    const deeper = withSidebarListExtraPages({}, "project:alpha", 2);
    expect(deeper).toEqual({ "project:alpha": 2 });
    expect(withSidebarListExtraPages(deeper, "project:alpha", 2)).toBe(deeper);
    expect(withSidebarListExtraPages(deeper, "project:alpha", 0)).toEqual({});
  });

  test("remembers the most recently changed lists when Projects come and go", () => {
    let state = {};
    for (let index = 0; index < 205; index += 1) {
      state = withSidebarListExtraPages(state, `project:${index}`, 1);
    }
    state = withSidebarListExtraPages(state, "project:10", 2);
    const remembered = Object.keys(state);
    expect(remembered).toHaveLength(200);
    expect(remembered).not.toContain("project:4");
    expect(remembered[0]).toBe("project:5");
    expect(remembered.at(-1)).toBe("project:10");
    expect(Object.keys(normalizeSidebarListExtraPages(state))).toEqual(remembered);
  });
});
