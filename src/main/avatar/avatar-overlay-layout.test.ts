import { describe, expect, it } from "vitest";
import {
  buildAvatarOverlayHostLayout,
  clampAvatarOverlayAnchor,
  resolveAvatarOverlayAnchor,
  resolveAvatarOverlayHostAlignment,
  resolveAvatarOverlayLayout,
  resolveAvatarOverlayPlacement,
  resolveAvatarOverlayWindowBounds,
  shouldAnimateAvatarLayout,
} from "./avatar-overlay-layout";

const display = {
  bounds: { x: -1_920, y: 0, width: 1_920, height: 1_080 },
  workArea: { x: -1_920, y: 24, width: 1_920, height: 1_056 },
};

describe("avatar overlay native layout", () => {
  it("spans the selected display vertically while retaining a narrow native draw surface", () => {
    const anchor = resolveAvatarOverlayAnchor(display);
    expect(anchor).toEqual({ x: -136, y: 935, width: 112, height: 121 });
    expect(resolveAvatarOverlayWindowBounds(display, anchor)).toEqual({
      x: -384,
      y: 24,
      width: 384,
      height: 1_056,
    });
  });

  it.each([
    ["top-start", "bottom-left"],
    ["top-end", "bottom-right"],
    ["bottom-start", "top-left"],
    ["bottom-end", "top-right"],
  ] as const)("maps %s to the opposite PiP anchor %s", (placement, alignment) => {
    expect(resolveAvatarOverlayHostAlignment(placement)).toBe(alignment);
  });

  it("derives the pet corner from its actual display position", () => {
    expect(
      resolveAvatarOverlayPlacement({ x: -136, y: 935, width: 112, height: 121 }, display),
    ).toBe("bottom-end");
    expect(
      resolveAvatarOverlayPlacement({ x: -1_900, y: 40, width: 112, height: 121 }, display),
    ).toBe("top-start");
  });

  it("publishes mascot-local host geometry and the target spring", () => {
    const windowBounds = { x: 100, y: 24, width: 384, height: 1_056 };
    const layout = resolveAvatarOverlayLayout({
      anchor: { x: 350, y: 940, width: 112, height: 121 },
      placement: "top-end",
      stackDisplayHeight: 233.4,
      windowBounds,
    });
    expect(layout.mascot).toEqual({ x: 250, y: 916, width: 112, height: 121 });
    expect(layout.stackDisplayHeight).toBe(233);
    expect(buildAvatarOverlayHostLayout(layout, true)).toMatchObject({
      animated: true,
      hostId: "avatar-overlay",
      interactionPassthroughRect: layout.mascot,
      isCodexHomeAvailable: false,
      presentationScope: "all",
      anchors: [{ alignment: "bottom-right", point: { x: 306, y: 976.5 } }],
      animationSpring: { damping: 18.85, initialVelocity: 0, mass: 1, stiffness: 180 },
    });
  });

  it("clamps a dragged mascot to the active display work area", () => {
    expect(
      clampAvatarOverlayAnchor({ x: -2_400, y: 2_000, width: 112, height: 121 }, display),
    ).toEqual({ x: -1_920, y: 959, width: 112, height: 121 });
  });

  it("disables native window motion when the system prefers reduced motion", () => {
    expect(shouldAnimateAvatarLayout(false, false)).toBe(false);
    expect(shouldAnimateAvatarLayout(true, true)).toBe(false);
    expect(shouldAnimateAvatarLayout(true, false)).toBe(true);
  });
});
