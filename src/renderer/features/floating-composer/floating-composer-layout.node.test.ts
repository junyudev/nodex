import { describe, expect, test } from "vite-plus/test";
import {
  clampFloatingComposerFrameWidth,
  isFloatingComposerPointerNearBubbleCorner,
  resolveFloatingComposerDockForRect,
  resolveFloatingComposerDockOrigin,
  resolveFloatingComposerDockScaleOrigin,
  resolveFloatingComposerDragConstraints,
  resolveFloatingComposerDragTarget,
  resolveFloatingComposerExpandedHeight,
  resolveFloatingComposerFrameWidth,
  resolveFloatingComposerResizeOffset,
  resolveFloatingComposerPaneDropSide,
  resolveMinimizedFloatingComposerDock,
} from "./floating-composer-layout";

const pane = { width: 1000, height: 800 };

describe("floating composer layout", () => {
  test("docks rest 10px from the pane edges, top docks below the pane header", () => {
    const box = { width: 400, height: 50 };
    const origin = (dock: Parameters<typeof resolveFloatingComposerDockOrigin>[0]["dock"]) =>
      resolveFloatingComposerDockOrigin({ dock, box, pane, inset: 10, topReserve: 44 });
    expect(origin("bottom-center")).toEqual({ x: 300, y: 740 });
    expect(origin("bottom-left")).toEqual({ x: 10, y: 740 });
    expect(origin("bottom-right")).toEqual({ x: 590, y: 740 });
    expect(origin("top-left")).toEqual({ x: 10, y: 54 });
    expect(origin("top-right")).toEqual({ x: 590, y: 54 });
  });

  test("a released composer settles at the bottom centre or the nearest corner", () => {
    const at = (x: number, y: number) =>
      resolveFloatingComposerDockForRect({ x: x - 100, y: y - 25, width: 200, height: 50 }, pane);
    expect(at(500, 700)).toBe("bottom-center");
    expect(at(260, 600)).toBe("bottom-center");
    expect(at(240, 600)).toBe("bottom-left");
    expect(at(900, 700)).toBe("bottom-right");
    expect(at(500, 200)).toBe("top-right");
    expect(at(100, 100)).toBe("top-left");
    expect(
      resolveFloatingComposerDockForRect({ x: 400, y: 675, width: 200, height: 50 }, pane, {
        minimized: true,
      }),
    ).toBe("bottom-right");
  });

  test("the centre dock minimizes to the bottom-right corner", () => {
    expect(resolveMinimizedFloatingComposerDock("bottom-center")).toBe("bottom-right");
    expect(resolveMinimizedFloatingComposerDock("top-left")).toBe("top-left");
  });

  test("frame width stays between the minimum and the pane", () => {
    expect(clampFloatingComposerFrameWidth(200, pane.width)).toBe(372);
    expect(clampFloatingComposerFrameWidth(600, pane.width)).toBe(600);
    expect(clampFloatingComposerFrameWidth(2000, pane.width)).toBe(980);
    expect(clampFloatingComposerFrameWidth(600, 300)).toBe(280);
  });

  test("resizing keeps the opposite edge still, then the frame returns to its dock", () => {
    const resize = (
      dock: Parameters<typeof resolveFloatingComposerResizeOffset>[0]["dock"],
      edge: "left" | "right",
      width: number,
    ) =>
      resolveFloatingComposerResizeOffset({
        dock,
        edge,
        startWidth: 400,
        startOffset: 0,
        width,
        pane,
        height: 50,
      });
    // Centered at x 300; growing the right edge by 100 keeps the left edge at 300.
    expect(resize("bottom-center", "right", 500)).toBe(50);
    expect(resize("bottom-center", "left", 500)).toBe(-50);
    // A right-docked frame grows from its anchored edge without any offset.
    expect(resize("bottom-right", "left", 500)).toBe(0);
    expect(resize("bottom-right", "right", 500)).toBe(0);
    // The left edge never passes the pane inset.
    expect(resize("bottom-left", "left", 500)).toBe(0);
  });

  test("a drag ending in a corner asks to minimize", () => {
    expect(isFloatingComposerPointerNearBubbleCorner({ pointer: { x: 960, y: 770 }, pane })).toBe(
      true,
    );
    expect(isFloatingComposerPointerNearBubbleCorner({ pointer: { x: 500, y: 770 }, pane })).toBe(
      false,
    );
  });

  test("a narrow pane's composer spans the pane", () => {
    expect(resolveFloatingComposerFrameWidth(560, 1000)).toBe(572);
    expect(resolveFloatingComposerFrameWidth(560, 600)).toBe(580);
    expect(resolveFloatingComposerFrameWidth(300, 600)).toBe(580);
  });

  test("an expanded frame keeps its stored height within the pane", () => {
    expect(resolveFloatingComposerExpandedHeight(640, 800)).toBe(640);
    expect(resolveFloatingComposerExpandedHeight(900, 800)).toBe(768);
    expect(resolveFloatingComposerExpandedHeight(200, 800)).toBe(400);
    // A tall compact composer raises the floor.
    expect(resolveFloatingComposerExpandedHeight(420, 800, 520)).toBe(520);
    // A short pane caps the floor too.
    expect(resolveFloatingComposerExpandedHeight(640, 300)).toBe(268);
  });

  test("a shrinking frame stays pinned to its dock", () => {
    expect(resolveFloatingComposerDockScaleOrigin("bottom-center")).toEqual({
      originX: 0.5,
      originY: 1,
    });
    expect(resolveFloatingComposerDockScaleOrigin("top-left")).toEqual({ originX: 0, originY: 0 });
    expect(resolveFloatingComposerDockScaleOrigin("bottom-right")).toEqual({
      originX: 1,
      originY: 1,
    });
  });

  test("a dragged frame heads for a corner dock and minimizes with the pointer in that corner", () => {
    const narrowFrame = { width: 300, height: 60 };
    // Resting at the bottom-left dock with the pointer still mid-frame: about to dock there.
    expect(
      resolveFloatingComposerDragTarget({
        rect: { x: 12, y: 728, ...narrowFrame },
        pane,
        pointer: { x: 150, y: 750 },
      }),
    ).toEqual({ dock: "bottom-left", nearDock: true, minimize: false });
    // Same frame, pointer pressed into the corner: release minimizes.
    expect(
      resolveFloatingComposerDragTarget({
        rect: { x: 12, y: 728, ...narrowFrame },
        pane,
        pointer: { x: 40, y: 780 },
      }),
    ).toEqual({ dock: "bottom-left", nearDock: true, minimize: true });
    // Far from any dock nothing is imminent.
    expect(
      resolveFloatingComposerDragTarget({
        rect: { x: 300, y: 300, ...narrowFrame },
        pane,
        pointer: { x: 450, y: 330 },
      }),
    ).toEqual({ dock: "top-left", nearDock: false, minimize: false });
  });

  test("a wide frame follows the pointer to a side", () => {
    const wideFrame = { width: 572, height: 60 };
    // Its centre stays in the middle half, yet the pointer at the left picks the left corner.
    expect(
      resolveFloatingComposerDragTarget({
        rect: { x: 10, y: 730, ...wideFrame },
        pane,
        pointer: { x: 40, y: 780 },
      }),
    ).toEqual({ dock: "bottom-left", nearDock: true, minimize: true });
    expect(
      resolveFloatingComposerDragTarget({
        rect: { x: 214, y: 730, ...wideFrame },
        pane,
        pointer: { x: 500, y: 760 },
      }).dock,
    ).toBe("bottom-center");
  });

  test("drag offsets keep a box inside the pane from wherever it rests", () => {
    const box = { width: 400, height: 50 };
    expect(
      resolveFloatingComposerDragConstraints({ dock: "bottom-center", box, pane, inset: 10 }),
    ).toEqual({ left: -290, right: 290, top: -730, bottom: 0 });
    expect(
      resolveFloatingComposerDragConstraints({ dock: "top-left", box, pane, inset: 10 }),
    ).toEqual({ left: 0, right: 580, top: 0, bottom: 730 });
    expect(
      resolveFloatingComposerDragConstraints({
        dock: "bottom-right",
        box: { width: 36, height: 36 },
        pane,
        inset: 16,
      }),
    ).toEqual({ left: -932, right: 0, top: -732, bottom: 0 });
  });
});

describe("floating composer pane drop", () => {
  test.each([
    { pointerX: 0, expected: "left" },
    { pointerX: 24, expected: "left" },
    { pointerX: 25, expected: null },
    { pointerX: 500, expected: null },
    { pointerX: 975, expected: null },
    { pointerX: 976, expected: "right" },
    { pointerX: 1000, expected: "right" },
  ] as const)("pointer at $pointerX resolves to $expected", ({ pointerX, expected }) => {
    expect(resolveFloatingComposerPaneDropSide(pointerX, 1000)).toBe(expected);
  });

  test("a pane with overlapping edge zones never resolves an ambiguous right drop", () => {
    expect(resolveFloatingComposerPaneDropSide(20, 40)).toBe("left");
    expect(resolveFloatingComposerPaneDropSide(40, 40)).toBeNull();
    expect(resolveFloatingComposerPaneDropSide(48, 48)).toBeNull();
    expect(resolveFloatingComposerPaneDropSide(49, 49)).toBe("right");
  });
});
