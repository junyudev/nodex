import { describe, expect, test } from "vite-plus/test";
import {
  resolveWindowContentCaptionClearance,
  measureWorkbenchWindowControlsOverlay,
  resolveWorkbenchHeaderSafeInsets,
  resolveWorkbenchMacWindowControlPosition,
  resolveWorkbenchWindowControlsOverlayHeight,
  WORKBENCH_TITLEBAR_HEIGHT_PX,
  WORKBENCH_APPLICATION_MENU_HEIGHT_PX,
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

  test.each([0.8, 1, 1.5, 2])(
    "sizes Windows caption buttons to the scaled titlebar at %sx zoom",
    (windowZoom) => {
      expect(resolveWorkbenchWindowControlsOverlayHeight(windowZoom)).toBe(
        Math.round(WORKBENCH_APPLICATION_MENU_HEIGHT_PX * windowZoom),
      );
    },
  );

  test("measures caption buttons in device-independent pixels across page zoom", () => {
    const overlayAt = (areaWidth: number) => ({
      visible: true,
      getTitlebarAreaRect: () => ({ x: 0, width: areaWidth }),
    });

    expect(measureWorkbenchWindowControlsOverlay(overlayAt(862), 1000)).toEqual({
      left: 0,
      right: 138,
    });
    // At 125% page zoom the same 138 DIP of caption buttons occupy 110.4 CSS pixels.
    const zoomed = measureWorkbenchWindowControlsOverlay(overlayAt(689.6), 800, 1.25);
    expect(zoomed?.left).toBe(0);
    expect(zoomed?.right).toBeCloseTo(138);
  });

  test("reports no reservation when the overlay is absent, hidden, or not laid out", () => {
    const rect = () => ({ x: 0, width: 600 });

    expect(measureWorkbenchWindowControlsOverlay(undefined, 800)).toBeNull();
    expect(
      measureWorkbenchWindowControlsOverlay({ visible: false, getTitlebarAreaRect: rect }, 800),
    ).toBeNull();
    expect(
      measureWorkbenchWindowControlsOverlay(
        { visible: true, getTitlebarAreaRect: () => ({ x: 0, width: 0 }) },
        800,
      ),
    ).toBeNull();
  });

  test.each([1, 2])(
    "keeps a scaled 6px gap before Windows caption buttons at %sx zoom",
    (windowZoom) => {
      const insets = resolveWorkbenchHeaderSafeInsets({
        isMacPlatform: false,
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        windowZoom,
        windowControlsOverlay: { left: 0, right: 138 },
      });

      expect(insets.left).toBe(12);
      expect(insets.right * windowZoom - 138).toBeCloseTo(6 * windowZoom);
    },
  );
});

test("Windows application row alone consumes measured exclusions across both zoom coordinates", () => {
  const overlay = measureWorkbenchWindowControlsOverlay(
    { visible: true, getTitlebarAreaRect: () => ({ x: 0, width: 689.6 }) },
    800,
    1.25,
  );
  const insets = resolveWorkbenchHeaderSafeInsets({
    isMacPlatform: false,
    userAgent: "Windows",
    applicationMenu: true,
    windowZoom: 1.25 * 0.8,
    windowControlsOverlay: overlay,
  });
  expect(insets.left).toBe(6);
  expect(insets.right).toBeCloseTo(138);
  expect(
    resolveWorkbenchHeaderSafeInsets({
      isMacPlatform: false,
      userAgent: "Windows",
      applicationMenu: true,
    }),
  ).toEqual({ left: 6, right: 0 });
  expect(
    resolveWorkbenchHeaderSafeInsets({
      isMacPlatform: false,
      userAgent: "Windows",
      applicationMenu: true,
      fullscreen: true,
      windowControlsOverlay: { left: 0, right: 143 },
    }),
  ).toEqual({ left: 0, right: 0 });
});

test("full-window preview actions clear native controls without padding ordinary surfaces", () => {
  expect(resolveWindowContentCaptionClearance(143, 45)).toEqual({
    actionsTop: 57,
    contentTop: 109,
  });
  expect(resolveWindowContentCaptionClearance(0, 45)).toEqual({ actionsTop: 12, contentTop: 48 });
  expect(resolveWindowContentCaptionClearance(143, 45, true)).toEqual({
    actionsTop: 12,
    contentTop: 48,
  });
  expect(resolveWindowContentCaptionClearance(143, 0)).toEqual({ actionsTop: 12, contentTop: 48 });
});
