import { describe, expect, test } from "vite-plus/test";
import { render } from "@/test/dom";
import { OpenTabsIcon } from "./open-tabs-icon";

describe("OpenTabsIcon", () => {
  test("retains its 16px intrinsic canvas without a caller size", () => {
    const view = render(<OpenTabsIcon count={1} />);
    const svg = view.container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("16");
    expect(svg?.getAttribute("height")).toBe("16");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(svg?.getAttribute("focusable")).toBe("false");
  });

  test.each([
    [1, "1"],
    [9, "9"],
    [10, "9+"],
    [12, "9+"],
  ])("keeps the compact count %s decorative", (count, label) => {
    const view = render(<OpenTabsIcon count={count} />);
    const glyph = view.container.firstElementChild;
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
    expect(glyph?.textContent).toBe(label);
  });
});
