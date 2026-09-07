import { expect, test, vi } from "vite-plus/test";
import { workbenchElementInViewport } from "./workbench-view-content";

test("a mounted Board card is visible only where its box intersects every clipping ancestor", () => {
  const host = document.createElement("div");
  const card = document.createElement("div");
  host.style.overflowX = "hidden";
  host.style.overflowY = "hidden";
  host.style.opacity = "1";
  card.style.opacity = "1";
  host.append(card);
  document.body.append(host);
  const box = (x: number, y: number, width: number, height: number) =>
    new DOMRect(x, y, width, height);
  vi.spyOn(card, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList);
  vi.spyOn(card, "getBoundingClientRect").mockReturnValue(box(150, 20, 80, 40));
  const hostBounds = vi.spyOn(host, "getBoundingClientRect").mockReturnValue(box(0, 0, 100, 100));
  try {
    expect(workbenchElementInViewport(card)).toBe(false);
    hostBounds.mockReturnValue(box(0, 0, 200, 100));
    expect(workbenchElementInViewport(card)).toBe(true);
    host.style.visibility = "hidden";
    expect(workbenchElementInViewport(card)).toBe(false);
    host.style.visibility = "visible";
    host.remove();
    expect(workbenchElementInViewport(card)).toBe(false);
  } finally {
    host.remove();
  }
});
