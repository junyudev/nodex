import { describe, expect, test } from "vite-plus/test";
import { resolveAppShellTabLocationDetails } from "./app-shell-tab-location";
import {
  buildAppShellLeadingTabStripSizing,
  buildAppShellTabFlexSizing,
  buildAppShellTabListWidth,
} from "./app-shell-tab-sizing";

describe("app shell tab location", () => {
  const details = (...tabs: Parameters<typeof resolveAppShellTabLocationDetails>[0]) =>
    Object.fromEntries(resolveAppShellTabLocationDetails(tabs));

  describe("tab location details", () => {
    test("a title no other tab shares shows no location", () => {
      expect(
        details(
          { id: "a", title: "index.ts", location: ["src", "lib"] },
          { id: "b", title: "README.md", location: ["docs"] },
        ),
      ).toEqual({});
    });

    test("same-titled tabs show the fewest trailing parts that tell them apart", () => {
      expect(
        details(
          { id: "renderer", title: "index.ts", location: ["src", "renderer", "lib"] },
          { id: "main", title: "index.ts", location: ["src", "main", "lib"] },
          { id: "shared", title: "index.ts", location: ["src", "shared"] },
        ),
      ).toEqual({ renderer: "renderer/lib", main: "main/lib", shared: "shared" });
    });

    test("a location that is the tail of another shows all of itself", () => {
      expect(
        details(
          { id: "short", title: "index.ts", location: ["lib"] },
          { id: "long", title: "index.ts", location: ["main", "lib"] },
        ),
      ).toEqual({ short: "lib", long: "main/lib" });
    });

    test("tabs in the same place stay plain, while others with their title still name theirs", () => {
      expect(
        details(
          { id: "first", title: "Untitled", location: ["Library"] },
          { id: "second", title: "Untitled", location: ["Library"] },
        ),
      ).toEqual({});
      expect(
        details(
          { id: "first", title: "Untitled", location: ["Library"] },
          { id: "second", title: "Untitled", location: ["Library"] },
          { id: "beta", title: " Untitled ", location: ["Beta"] },
        ),
      ).toEqual({ first: "Library", second: "Library", beta: "Beta" });
    });

    test("tabs without a location neither show one nor force one on others", () => {
      expect(
        details(
          { id: "browser", title: "Docs" },
          { id: "page", title: "Docs", location: ["Library"] },
        ),
      ).toEqual({});
    });
  });
});

describe("app shell tab sizing", () => {
  test("distributes unlocked tabs equally within the shared min and max bounds", () => {
    expect(
      buildAppShellTabListWidth({
        tabCount: 3,
        trailingWidthPx: 28,
        lockedWidthPx: null,
      }),
    ).toBe("clamp(276px, calc(100cqw - 28px), 486px)");

    const flexSizing = buildAppShellTabFlexSizing(null);
    expect(flexSizing.flexBasis).toBe(0);
    expect(flexSizing.flexGrow).toBe(1);
  });

  test("locks the whole row to one measured tab width during direct close", () => {
    expect(
      buildAppShellTabListWidth({
        tabCount: 3,
        trailingWidthPx: 28,
        lockedWidthPx: 120.4,
      }),
    ).toBe("366px");

    const flexSizing = buildAppShellTabFlexSizing(120.4);
    expect(flexSizing.flexBasis).toBe(120);
    expect(flexSizing.flexGrow).toBe(0);
  });

  test("normalizes empty and invalid layout inputs", () => {
    expect(
      buildAppShellTabListWidth({
        tabCount: 0,
        trailingWidthPx: Number.NaN,
        lockedWidthPx: null,
      }),
    ).toBe("0px");
    expect(
      buildAppShellTabListWidth({
        tabCount: 2.8,
        trailingWidthPx: -8,
        lockedWidthPx: Number.POSITIVE_INFINITY,
      }),
    ).toBe("clamp(183px, calc(100cqw - 0px), 323px)");
  });
});

describe("leading tab strip sizing", () => {
  test("gives the fixed leading tab an equal share after trailing actions and gaps", () => {
    const tabWidth = "clamp(90px, calc(calc(100cqw - 28px - 9px) / 4), 160px)";
    expect(
      buildAppShellLeadingTabStripSizing({ tabCount: 3, trailingWidthPx: 28, lockedWidthPx: null }),
    ).toEqual({ leadingTabWidth: tabWidth, listWidth: `calc(3 * ${tabWidth} + 6px)` });
  });

  test("locks the leading tab and scrolling tabs to the same measured width", () => {
    expect(
      buildAppShellLeadingTabStripSizing({
        tabCount: 3,
        trailingWidthPx: 28,
        lockedWidthPx: 120.4,
      }),
    ).toEqual({ leadingTabWidth: "120px", listWidth: "366px" });
  });

  test.each([null, 120] as const)(
    "keeps the leading tab with no content tabs (lock %s)",
    (lockedWidthPx) => {
      expect(
        buildAppShellLeadingTabStripSizing({ tabCount: 0, trailingWidthPx: 28, lockedWidthPx }),
      ).toEqual({
        leadingTabWidth:
          lockedWidthPx === null
            ? "clamp(90px, calc(calc(100cqw - 28px - 0px) / 1), 160px)"
            : "120px",
        listWidth: "0px",
      });
    },
  );
});
