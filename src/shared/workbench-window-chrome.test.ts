import { describe, expect, test } from "vite-plus/test";
import {
  resolveWorkbenchHeaderSafeInsets,
  resolveWorkbenchMacWindowControlPosition,
  WORKBENCH_TITLEBAR_HEIGHT_PX,
} from "./workbench-window-chrome";

const legacyMacUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";

describe("Workbench native window geometry", () => {
  test.each([0.8, 1, 1.25, 2])(
    "centers physical window buttons in the scaled titlebar at %sx zoom",
    (windowZoom) => {
      const position = resolveWorkbenchMacWindowControlPosition(windowZoom);
      const nativeButtonCenter = position.y + 14 / 2;
      const titlebarCenter = (WORKBENCH_TITLEBAR_HEIGHT_PX * windowZoom) / 2;

      expect(position.x).toBe(16);
      expect(Math.abs(nativeButtonCenter - titlebarCenter)).toBeLessThanOrEqual(0.5);
    },
  );

  test.each([0.8, 1, 1.25, 2])(
    "keeps a scaled 6px gap after fixed native controls at %sx zoom",
    (windowZoom) => {
      const insets = resolveWorkbenchHeaderSafeInsets({
        isMacPlatform: true,
        userAgent: legacyMacUserAgent,
        windowZoom,
      });

      expect(insets.left * windowZoom - 82).toBeCloseTo(6 * windowZoom);
      expect(insets.right).toBe(0);
    },
  );

  test("reserves modern macOS controls separately from the legacy user agent", () => {
    const legacy = resolveWorkbenchHeaderSafeInsets({
      isMacPlatform: true,
      userAgent: legacyMacUserAgent,
    });
    const modern = resolveWorkbenchHeaderSafeInsets({
      isMacPlatform: true,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)",
    });

    expect(legacy.left).toBe(88);
    expect(modern.left).toBe(98);
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "falls back to unscaled native coordinates for invalid zoom %s",
    (windowZoom) => {
      expect(resolveWorkbenchMacWindowControlPosition(windowZoom)).toEqual({ x: 16, y: 15 });
      expect(
        resolveWorkbenchHeaderSafeInsets({
          isMacPlatform: true,
          userAgent: legacyMacUserAgent,
          windowZoom,
        }),
      ).toEqual({ left: 88, right: 0 });
    },
  );

  test("does not infer macOS controls from the user agent on another platform", () => {
    expect(
      resolveWorkbenchHeaderSafeInsets({
        isMacPlatform: false,
        userAgent: legacyMacUserAgent,
        windowZoom: 2,
      }),
    ).toEqual({ left: 12, right: 12 });
  });
});
