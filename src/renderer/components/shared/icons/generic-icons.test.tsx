import { describe, expect, test } from "vite-plus/test";
import { render } from "@/test/dom";
import { Filter } from "./generic-icons";

describe("generic icon adapter", () => {
  test("normalizes default geometry and decorative accessibility", () => {
    const view = render(<Filter />);
    const icon = view.container.querySelector("svg");

    expect(icon?.getAttribute("width")).toBe("16");
    expect(icon?.getAttribute("height")).toBe("16");
    expect(icon?.querySelector("svg")?.getAttribute("stroke-width")).toBe("1.75");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.getAttribute("focusable")).toBe("false");
  });

  test("preserves explicit geometry and accessible names", () => {
    const view = render(<Filter aria-label="Filter tasks" size={20} strokeWidth={2} />);
    const icon = view.container.querySelector("svg");

    expect(icon?.getAttribute("width")).toBe("20");
    expect(icon?.getAttribute("height")).toBe("20");
    expect(icon?.querySelector("svg")?.getAttribute("stroke-width")).toBe("2");
    expect(icon?.getAttribute("aria-label")).toBe("Filter tasks");
    expect(icon?.hasAttribute("aria-hidden")).toBe(false);
  });
});
