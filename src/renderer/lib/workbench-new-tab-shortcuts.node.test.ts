import { describe, expect, test } from "vite-plus/test";
import { decodeNewTabShortcutPreferences } from "./workbench-new-tab-shortcuts";

describe("decodeNewTabShortcutPreferences", () => {
  const bottom = { order: ["files", "terminal"], pinned: [] };

  test("keeps a valid arrangement for each panel, including an empty pin set", () => {
    const value = {
      right: { order: ["side_chat", "new_page", "review"], pinned: ["review", "side_chat"] },
      bottom,
    };

    expect(decodeNewTabShortcutPreferences(value)).toEqual(value);
  });

  test("keeps the first occurrence of each recognized tool and drops Browser", () => {
    expect(
      decodeNewTabShortcutPreferences({
        right: {
          order: ["browser", "files", 3, "files", "unknown", "new_page", "page_stage"],
          pinned: ["terminal", null, "browser", "terminal", "new_page", "unknown"],
        },
      }),
    ).toEqual({
      right: { order: ["files", "new_page", "page_stage"], pinned: ["terminal", "new_page"] },
    });
  });

  test.each([[null], [false], ["right"], [[]]])(
    "defaults both panels for a malformed root (%j)",
    (value) => {
      expect(decodeNewTabShortcutPreferences(value)).toEqual({});
    },
  );

  test.each([
    [null],
    [[]],
    [{ order: ["files"] }],
    [{ pinned: ["files"] }],
    [{ order: "files", pinned: [] }],
    [{ order: [], pinned: {} }],
  ])("defaults only the malformed panel (%j)", (right) => {
    expect(decodeNewTabShortcutPreferences({ right, bottom })).toEqual({ bottom });
  });

  test("ignores unknown and inherited panel keys", () => {
    const value = Object.assign(Object.create({ right: bottom }), { left: bottom, bottom });

    expect(decodeNewTabShortcutPreferences(value)).toEqual({ bottom });
  });

  test("defaults an unreadable panel without losing the other panel", () => {
    const value = {
      get right() {
        throw new Error("Unreadable preference");
      },
      bottom,
    };

    expect(decodeNewTabShortcutPreferences(value)).toEqual({ bottom });
  });
});
