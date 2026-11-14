import { describe, expect, test } from "vite-plus/test";
import { render } from "@/test/dom";
import { BoxSelect, Filter } from "./generic-icons";

describe("generic icon adapter", () => {
  test("normalizes default geometry and decorative accessibility", () => {
    const view = render(<Filter />);
    const icon = view.container.querySelector("svg");

    expect(icon?.getAttribute("width")).toBe("16");
    expect(icon?.getAttribute("height")).toBe("16");
    expect(icon?.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.getAttribute("focusable")).toBe("false");
  });

  test("preserves custom stroke weight for fallback icons", () => {
    const view = render(<BoxSelect strokeWidth={2} />);
    expect(view.container.querySelector("svg svg")?.getAttribute("stroke-width")).toBe("2");
  });

  test("preserves explicit geometry and accessible names", () => {
    const view = render(<Filter aria-label="Filter tasks" size={20} />);
    const icon = view.container.querySelector("svg");

    expect(icon?.getAttribute("width")).toBe("20");
    expect(icon?.getAttribute("height")).toBe("20");
    expect(icon?.getAttribute("viewBox")).toBe("0 0 20 20");
    expect(icon?.getAttribute("aria-label")).toBe("Filter tasks");
    expect(icon?.hasAttribute("aria-hidden")).toBe(false);
  });
});
