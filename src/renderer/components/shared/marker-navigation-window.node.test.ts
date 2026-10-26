import { describe, expect, test } from "vite-plus/test";
import { projectMarkerNavigationVirtualWindow } from "./marker-navigation-window";

describe("marker navigation window", () => {
  test("projects a bounded overscanned DOM window for a 1,000-marker rail", () => {
    const window = projectMarkerNavigationVirtualWindow({
      itemCount: 1_000,
      scrollTop: 4_500,
      viewportHeight: 400,
    });

    expect(window).toEqual({
      startIndex: 438,
      endIndex: 502,
      paddingBeforePx: 4_380,
      paddingAfterPx: 4_980,
    });
    expect(window.endIndex - window.startIndex).toBeLessThan(100);
  });
});
