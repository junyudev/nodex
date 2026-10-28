import { describe, expect, test } from "vite-plus/test";
import {
  buildAppShellLeadingTabStripSizing,
  buildAppShellTabFlexSizing,
  buildAppShellTabListWidth,
} from "./app-shell-tab-sizing";

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
