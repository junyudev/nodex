import { describe, expect, test } from "vitest";
import {
  DEFAULT_MINI_ANCHOR,
  EMPTY_MINI_COVERAGE,
  miniDockWidth,
  MINI_VISIBILITIES,
} from "../../shared/mini";
import {
  clampMiniDock,
  miniAnchorForDock,
  miniDockAtAnchor,
  miniPreviewHostLayout,
  miniRelativeDock,
  miniWindowBounds,
  snapMiniDock,
} from "./mini-geometry";
import {
  initialMiniPresentation,
  transitionMiniPresentation as dispatch,
} from "./mini-presentation";

describe("Mini presentation", () => {
  const notice = { ...EMPTY_MINI_COVERAGE, notice: true };
  const visibilityCases = MINI_VISIBILITIES.flatMap((visibility) =>
    [false, true].map((active) => ({ visibility, active })),
  );

  test.each(visibilityCases)("$visibility, active=$active", (input) => {
    const initial = dispatch(initialMiniPresentation(input.visibility), {
      kind: "presence",
      update: { coverage: input.active ? notice : EMPTY_MINI_COVERAGE },
    });
    const expected =
      input.visibility === "always" || (input.visibility === "active" && input.active)
        ? "resting"
        : "hidden";
    expect(initial.event.kind).toBe(expected);

    for (const trigger of ["focus", "shortcut"] as const) {
      const focused = dispatch(initial, { kind: trigger });
      expect(focused.event).toEqual({
        kind: "focused",
        generation: initial.event.generation + 1,
        anchor: DEFAULT_MINI_ANCHOR,
        dock: { x: 0, y: 0 },
      });
      expect(dispatch(focused, { kind: "blur", dialogOpen: true })).toBe(focused);
      const release = dispatch(focused, {
        kind: "release",
        generation: focused.event.generation,
      });
      const blur = dispatch(focused, { kind: "blur", dialogOpen: false });
      const toggle = dispatch(focused, { kind: "shortcut" });
      for (const [event, reason] of [
        [release.event, "dismissed"],
        [blur.event, "blurred"],
        [toggle.event, "toggled"],
      ] as const) {
        expect(event).toEqual({
          kind: expected,
          generation: focused.event.generation + 1,
          ...(expected === "hidden"
            ? { reason }
            : { anchor: DEFAULT_MINI_ANCHOR, dock: { x: 0, y: 0 } }),
        });
      }
    }
  });

  test("policy and activity re-evaluate resting presence right away", () => {
    const hidden = initialMiniPresentation("active");
    const active = dispatch(hidden, { kind: "presence", update: { coverage: notice } });
    expect(active.event.kind).toBe("resting");
    const onDemand = dispatch(active, { kind: "presence", update: { visibility: "on-demand" } });
    expect(onDemand.event).toMatchObject({ kind: "hidden", reason: "idle" });
    const always = dispatch(onDemand, {
      kind: "presence",
      update: { visibility: "always", coverage: EMPTY_MINI_COVERAGE },
    });
    expect(always.event.kind).toBe("resting");
    const idle = dispatch(always, { kind: "presence", update: { visibility: "active" } });
    expect(idle.event).toMatchObject({ kind: "hidden", reason: "idle" });
  });

  test("a pending handoff and docked previews keep Mini resting through idleness", () => {
    const idle = initialMiniPresentation("active");
    expect(idle.event.kind).toBe("hidden");
    const pending = dispatch(idle, {
      kind: "presence",
      update: { previewDockRequested: true },
    });
    expect(pending.event.kind).toBe("resting");
    expect(
      dispatch(pending, {
        kind: "presence",
        update: { previewDockRequested: false },
      }).event.kind,
    ).toBe("hidden");
    const docked = dispatch(pending, {
      kind: "presence",
      update: { previewDockRequested: false, previewsDocked: true },
    });
    expect(docked.event).toBe(pending.event);
    const focused = dispatch(docked, { kind: "focus" });
    expect(dispatch(focused, { kind: "blur", dialogOpen: false }).event.kind).toBe("resting");
    expect(
      dispatch(focused, {
        kind: "presence",
        update: { visibility: "on-demand" },
      }).event.kind,
    ).toBe("hidden");
    expect(
      dispatch(docked, {
        kind: "presence",
        update: { previewsDocked: false },
      }).event.kind,
    ).toBe("hidden");
  });

  test("a focused Mini keeps the keyboard through policy and activity changes", () => {
    const focused = dispatch(initialMiniPresentation("always"), { kind: "focus" });
    const next = dispatch(focused, {
      kind: "presence",
      update: { visibility: "active", coverage: notice },
    });
    expect(next.event).toBe(focused.event);
    // Opening Nodex from Mini gives the keyboard to Nodex; Mini stays on screen beside it.
    expect(
      dispatch(next, { kind: "open-settled", opened: true, hasKeyboard: false }).event.kind,
    ).toBe("resting");
    expect(
      dispatch(dispatch(next, { kind: "presence", update: { coverage: EMPTY_MINI_COVERAGE } }), {
        kind: "open-settled",
        opened: true,
        hasKeyboard: false,
      }).event,
    ).toMatchObject({ kind: "hidden", reason: "finished" });
  });

  test("a failed Open settles the held blur only if Mini lost the keyboard", () => {
    const focused = dispatch(initialMiniPresentation("always"), { kind: "focus" });
    expect(dispatch(focused, { kind: "open-settled", opened: false, hasKeyboard: true })).toBe(
      focused,
    );
    const handingOff = dispatch(focused, {
      kind: "presence",
      update: { visibility: "active" },
    });
    expect(dispatch(handingOff, { kind: "blur", dialogOpen: true })).toBe(handingOff);
    expect(
      dispatch(handingOff, { kind: "open-settled", opened: false, hasKeyboard: false }).event,
    ).toMatchObject({ kind: "hidden", reason: "blurred" });
  });

  test("movement preserves the current focus generation and its ability to release", () => {
    const first = dispatch(initialMiniPresentation(), { kind: "shortcut" });
    const closed = dispatch(first, { kind: "shortcut" });
    const next = dispatch(closed, { kind: "shortcut" });
    expect(dispatch(next, { kind: "release", generation: first.event.generation })).toBe(next);
    const geometry = {
      anchor: { vertical: "top", horizontal: "right" },
      dock: { x: 400, y: 80 },
    } as const;
    const moved = dispatch(next, { kind: "geometry", geometry });
    expect(moved.event).toEqual({
      kind: "focused",
      generation: next.event.generation,
      ...geometry,
    });
    expect(dispatch(moved, { kind: "geometry", geometry: { ...geometry } })).toBe(moved);
    const released = dispatch(moved, { kind: "release", generation: next.event.generation });
    expect(released.event.kind).toBe("hidden");
    expect(dispatch(released, { kind: "focus" }).event).toMatchObject(geometry);
  });

  test("renderer loss clears its activity before a replacement is ready", () => {
    const active = dispatch(initialMiniPresentation("active"), {
      kind: "presence",
      update: { coverage: notice },
    });
    const lost = dispatch(active, { kind: "renderer-lost" });
    expect(lost.coverage).toEqual(EMPTY_MINI_COVERAGE);
    expect(lost.event).toMatchObject({ kind: "hidden", reason: "finished" });
    expect(dispatch(lost, { kind: "presence", update: {} }).event).toBe(lost.event);
  });
});

describe("Mini placement", () => {
  const workArea = { x: -1600, y: 32, width: 1600, height: 940 };
  const display = { workArea, bounds: { x: -1600, y: 0, width: 1600, height: 1000 } };
  const dockWidth = miniDockWidth(true);

  test("starts at bottom center, with the dock 12 DIP above the work area's edge", () => {
    const dock = miniDockAtAnchor(workArea, dockWidth);
    expect(dock).toEqual({ x: -800, y: 940 });
    expect(miniWindowBounds(display, dock)).toEqual({ x: -1100, y: 32, width: 600, height: 940 });
  });

  test("preserves a free position and flips growth direction without moving the window vertically", () => {
    const topDock = { x: -1228.5, y: 501 };
    const bottomDock = { ...topDock, y: 502 };
    expect(clampMiniDock(workArea, topDock, dockWidth)).toEqual(topDock);
    expect(clampMiniDock(workArea, bottomDock, dockWidth)).toEqual(bottomDock);
    expect(miniAnchorForDock(workArea, topDock)).toEqual({ vertical: "top", horizontal: "left" });
    expect(miniAnchorForDock(workArea, bottomDock)).toEqual({
      vertical: "bottom",
      horizontal: "left",
    });
    const bounds = miniWindowBounds(display, topDock);
    expect(miniWindowBounds(display, bottomDock)).toEqual(bounds);
    expect(miniRelativeDock(topDock, bounds)).toEqual({ x: 299.5, y: 469 });
    expect(miniRelativeDock(bottomDock, bounds)).toEqual({ x: 299.5, y: 470 });
  });

  test("reclamps a saved point after the work area shrinks, keeping the window on its display", () => {
    const smaller = { x: 40, y: 28, width: 460, height: 680 };
    const dock = clampMiniDock(smaller, { x: 500, y: 900 }, dockWidth);
    expect(dock).toEqual({ x: 430.5, y: 676 });
    const bounds = miniWindowBounds(
      {
        workArea: smaller,
        bounds: { x: 0, y: 0, width: 500, height: 720 },
      },
      dock,
    );
    expect(bounds).toEqual({ x: 0, y: 28, width: 500, height: 680 });
    expect(miniRelativeDock(dock, bounds)).toEqual({ x: 430.5, y: 648 });
    expect(miniRelativeDock(dock, smaller)).toEqual({ x: 390.5, y: 648 });
  });

  test.each([
    [-1400, 300, -1530.5, 64],
    [-800, 300, -800, 64],
    [-300, 300, -69.5, 64],
    [-1400, 700, -1530.5, 940],
    [-800, 700, -800, 940],
    [-300, 700, -69.5, 940],
  ])("snaps Option-drops in each of the six regions (%i, %i)", (x, y, snappedX, snappedY) => {
    expect(snapMiniDock(workArea, { x, y }, dockWidth)).toEqual({ x: snappedX, y: snappedY });
  });
});

describe("Mini preview placement", () => {
  const content = { x: 52, y: 400, width: 300, height: 280 };
  const base = { x: 75, y: 630, width: 200, height: 40 };

  test.each([
    ["bottom", "left", "bottom-left", 360, 670],
    ["bottom", "center", "bottom-left", 360, 670],
    ["bottom", "right", "bottom-right", 44, 670],
    ["top", "left", "top-left", 360, 630],
    ["top", "center", "top-left", 360, 630],
    ["top", "right", "top-right", 44, 630],
  ] as const)("docks alongside the %s %s placement", (vertical, horizontal, alignment, x, y) => {
    const layout = miniPreviewHostLayout(
      { content, base },
      { vertical, horizontal },
      undefined,
      false,
    );
    expect(layout).toMatchObject({
      anchorRect: content,
      interactionPassthroughRect: content,
      anchors: [{ alignment, point: { x, y } }],
      animated: false,
    });
  });

  test("only changes of stack alignment use the spring, respecting reduced motion", () => {
    const anchor = { vertical: "bottom", horizontal: "right" } as const;
    const layout = { content, base };
    expect(miniPreviewHostLayout(layout, anchor, "top-right", false).animated).toBe(true);
    expect(miniPreviewHostLayout(layout, anchor, "top-right", true).animated).toBe(false);
    expect(miniPreviewHostLayout(layout, anchor, "bottom-right", false).animated).toBe(false);
  });
});
