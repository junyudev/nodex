import { describe, expect, test } from "vitest";
import { DEFAULT_MINI_ANCHOR, EMPTY_MINI_COVERAGE, MINI_VISIBILITIES } from "../../shared/mini";
import { miniBounds, MINI_WINDOW_SIZE, nearestMiniAnchor } from "./mini-geometry";
import {
  initialMiniPresentation,
  transitionMiniPresentation as dispatch,
} from "./mini-presentation";

describe("Mini presentation", () => {
  const notice = { ...EMPTY_MINI_COVERAGE, notice: true };
  const visibilityCases = MINI_VISIBILITIES.flatMap((visibility) =>
    [false, true].flatMap((active) =>
      [false, true].map((workbenchFocused) => ({ visibility, active, workbenchFocused })),
    ),
  );

  test.each(visibilityCases)(
    "$visibility, active=$active, Workbench focused=$workbenchFocused",
    (input) => {
      const initial = dispatch(initialMiniPresentation(input.visibility), {
        kind: "presence",
        update: {
          workbenchFocused: input.workbenchFocused,
          coverage: input.active ? notice : EMPTY_MINI_COVERAGE,
        },
      });
      const expected =
        !input.workbenchFocused &&
        (input.visibility === "always" || (input.visibility === "active" && input.active))
          ? "resting"
          : "hidden";
      expect(initial.event.kind).toBe(expected);

      for (const trigger of ["focus", "shortcut"] as const) {
        const focused = dispatch(initial, { kind: trigger });
        expect(focused.event).toEqual({
          kind: "focused",
          generation: initial.event.generation + 1,
          anchor: DEFAULT_MINI_ANCHOR,
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
            ...(expected === "hidden" ? { reason } : { anchor: DEFAULT_MINI_ANCHOR }),
          });
        }
      }
    },
  );

  test("policy, activity, and Workbench focus re-evaluate resting presence right away", () => {
    const hidden = initialMiniPresentation();
    const active = dispatch(hidden, { kind: "presence", update: { coverage: notice } });
    expect(active.event.kind).toBe("resting");
    const behindWorkbench = dispatch(active, {
      kind: "presence",
      update: { workbenchFocused: true },
    });
    expect(behindWorkbench.event).toMatchObject({ kind: "hidden", reason: "idle" });
    const outside = dispatch(behindWorkbench, {
      kind: "presence",
      update: { workbenchFocused: false },
    });
    expect(outside.event.kind).toBe("resting");
    const onDemand = dispatch(outside, { kind: "presence", update: { visibility: "on-demand" } });
    expect(onDemand.event).toMatchObject({ kind: "hidden", reason: "idle" });
    const always = dispatch(onDemand, {
      kind: "presence",
      update: { visibility: "always", coverage: EMPTY_MINI_COVERAGE },
    });
    expect(always.event.kind).toBe("resting");
    const idle = dispatch(always, { kind: "presence", update: { visibility: "active" } });
    expect(idle.event).toMatchObject({ kind: "hidden", reason: "idle" });
  });

  test("a focused Mini keeps the keyboard through policy, activity, and Workbench changes", () => {
    const focused = dispatch(initialMiniPresentation("always"), { kind: "focus" });
    const next = dispatch(focused, {
      kind: "presence",
      update: { visibility: "active", coverage: notice, workbenchFocused: true },
    });
    expect(next.event).toBe(focused.event);
    expect(
      dispatch(next, { kind: "open-settled", opened: true, hasKeyboard: false }).event,
    ).toMatchObject({ kind: "hidden", reason: "finished" });
  });

  test("a failed Open settles the held blur only if Mini lost the keyboard", () => {
    const focused = dispatch(initialMiniPresentation("always"), { kind: "focus" });
    expect(dispatch(focused, { kind: "open-settled", opened: false, hasKeyboard: true })).toBe(
      focused,
    );
    const handingOff = dispatch(focused, {
      kind: "presence",
      update: { workbenchFocused: true },
    });
    expect(dispatch(handingOff, { kind: "blur", dialogOpen: true })).toBe(handingOff);
    expect(
      dispatch(handingOff, { kind: "open-settled", opened: false, hasKeyboard: false }).event,
    ).toMatchObject({ kind: "hidden", reason: "blurred" });
  });

  test("a delayed release cannot affect a newer focus or an updated anchor", () => {
    const first = dispatch(initialMiniPresentation(), { kind: "shortcut" });
    const closed = dispatch(first, { kind: "shortcut" });
    const next = dispatch(closed, { kind: "shortcut" });
    expect(dispatch(next, { kind: "release", generation: first.event.generation })).toBe(next);
    const anchor = { vertical: "top", horizontal: "right" } as const;
    const moved = dispatch(next, { kind: "anchor", anchor });
    expect(moved.event).toEqual({
      kind: "focused",
      generation: next.event.generation + 1,
      anchor,
    });
    expect(dispatch(moved, { kind: "release", generation: next.event.generation })).toBe(moved);
    const released = dispatch(moved, { kind: "release", generation: moved.event.generation });
    const reopened = dispatch(released, { kind: "focus" });
    expect(reopened.event).toMatchObject({ kind: "focused", anchor });
    expect(dispatch(reopened, { kind: "anchor", anchor: { ...anchor } })).toBe(reopened);
  });

  test("renderer loss clears its activity before a replacement is ready", () => {
    const active = dispatch(initialMiniPresentation(), {
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

  test("anchors the window to the display work area in DIP", () => {
    expect(miniBounds(workArea, DEFAULT_MINI_ANCHOR)).toEqual({
      x: -1100,
      y: 240,
      ...MINI_WINDOW_SIZE,
    });
    expect(miniBounds(workArea, { vertical: "top", horizontal: "right" })).toEqual({
      x: -612,
      y: 44,
      ...MINI_WINDOW_SIZE,
    });
  });

  test("clamps an undersized display and preserves the current anchor on ties", () => {
    const small = { x: 10, y: 32, width: 500, height: 700 };
    const right = { vertical: "top", horizontal: "right" } as const;
    const clamped = miniBounds(small, right);
    expect(clamped).toEqual({ x: 22, y: 44, width: 476, height: 676 });
    expect(nearestMiniAnchor(small, clamped, right)).toEqual(right);
  });

  test.each([
    ["top", "left", -1600, 28],
    ["top", "center", -1130, 30],
    ["top", "right", -570, 50],
    ["bottom", "left", -1550, 270],
    ["bottom", "center", -1050, 210],
    ["bottom", "right", -620, 300],
  ] as const)("snaps a drop near %s %s", (vertical, horizontal, x, y) => {
    expect(nearestMiniAnchor(workArea, { x, y, ...MINI_WINDOW_SIZE })).toEqual({
      vertical,
      horizontal,
    });
  });
});
