import { describe, expect, test } from "vite-plus/test";
import {
  makeDefaultSidebarCollapsibleSectionsState,
  normalizeSidebarCollapsibleSectionsState,
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
});
