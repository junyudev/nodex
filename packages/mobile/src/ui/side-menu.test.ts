import { describe, expect, it } from "vitest";

import { draggedProgress, restsOpen, sideMenuWidth } from "./side-menu";

describe("restsOpen", () => {
  it("settles a slow release on the nearer side", () => {
    expect(restsOpen(0.6, 0)).toBe(true);
    expect(restsOpen(0.4, 120)).toBe(false);
    expect(restsOpen(0.6, -120)).toBe(true);
  });

  it("lets a flick decide, whichever side is nearer", () => {
    expect(restsOpen(0.1, 900)).toBe(true);
    expect(restsOpen(0.9, -900)).toBe(false);
  });
});

describe("draggedProgress", () => {
  it("follows the finger from where the drag found the menu", () => {
    expect(draggedProgress(0, 150, 300)).toBe(0.5);
    expect(draggedProgress(1, -75, 300)).toBe(0.75);
  });

  it("stops at fully closed and fully open", () => {
    expect(draggedProgress(0, -40, 300)).toBe(0);
    expect(draggedProgress(1, 40, 300)).toBe(1);
    expect(draggedProgress(0.5, 600, 300)).toBe(1);
  });
});

describe("sideMenuWidth", () => {
  it("leaves part of the app in sight on a phone of any width", () => {
    for (const screen of [320, 375, 402, 440]) {
      const menu = sideMenuWidth(screen);
      expect(menu).toBeGreaterThan(screen / 2);
      expect(screen - menu).toBeGreaterThanOrEqual(64);
    }
  });
});
