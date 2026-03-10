import { describe, expect, test } from "bun:test";
import {
  CALENDAR_SHIFT_WHEEL_SCOPE_ATTR,
  CALENDAR_SHIFT_WHEEL_SCOPE_VALUE,
  isInsideCalendarShiftWheelScope,
  resolveStageWheelNavigation,
  resolveWrappedStageIndex,
  shouldPreventStageRailShiftWheelFromCalendar,
  shouldDeferStageShiftWheelToNestedScroll,
} from "./stage-wheel-navigation";

describe("resolveWrappedStageIndex", () => {
  test("wraps forward at the end", () => {
    expect(resolveWrappedStageIndex(4, 1, 5)).toBe(0);
  });

  test("wraps backward at the beginning", () => {
    expect(resolveWrappedStageIndex(0, -1, 5)).toBe(4);
  });

  test("normalizes out-of-range index", () => {
    expect(resolveWrappedStageIndex(-1, 1, 5)).toBe(0);
  });
});

describe("resolveStageWheelNavigation", () => {
  test("ignores wheel without shift modifier", () => {
    const result = resolveStageWheelNavigation({
      deltaPx: 80,
      shiftKey: false,
      ctrlKey: false,
      nowMs: 500,
      lastStepAtMs: 0,
    });

    expect(result.consumeEvent).toBe(false);
    expect(result.direction).toBe(0);
  });

  test("ignores ctrl/meta zoom-modified wheel", () => {
    const result = resolveStageWheelNavigation({
      deltaPx: 80,
      shiftKey: true,
      ctrlKey: true,
      nowMs: 500,
      lastStepAtMs: 0,
    });

    expect(result.consumeEvent).toBe(false);
    expect(result.direction).toBe(0);
  });

  test("produces next-stage direction for positive deltas", () => {
    const result = resolveStageWheelNavigation({
      deltaPx: 96,
      shiftKey: true,
      ctrlKey: false,
      nowMs: 500,
      lastStepAtMs: 0,
    });

    expect(result.consumeEvent).toBe(true);
    expect(result.direction).toBe(1);
    expect(result.nextStepAtMs).toBe(500);
  });

  test("produces previous-stage direction for negative deltas", () => {
    const result = resolveStageWheelNavigation({
      deltaPx: -96,
      shiftKey: true,
      ctrlKey: false,
      nowMs: 500,
      lastStepAtMs: 0,
    });

    expect(result.consumeEvent).toBe(true);
    expect(result.direction).toBe(-1);
  });

  test("consumes wheel during cooldown without changing stage", () => {
    const result = resolveStageWheelNavigation({
      deltaPx: 96,
      shiftKey: true,
      ctrlKey: false,
      nowMs: 100,
      lastStepAtMs: 30,
      cooldownMs: 100,
    });

    expect(result.consumeEvent).toBe(true);
    expect(result.direction).toBe(0);
    expect(result.nextStepAtMs).toBe(30);
  });

  test("consumes tiny deltas without changing stage", () => {
    const result = resolveStageWheelNavigation({
      deltaPx: 1,
      shiftKey: true,
      ctrlKey: false,
      nowMs: 200,
      lastStepAtMs: 0,
      minDeltaPx: 2,
    });

    expect(result.consumeEvent).toBe(true);
    expect(result.direction).toBe(0);
  });
});

describe("shouldDeferStageShiftWheelToNestedScroll", () => {
  function createMockHorizontalScroller({
    railScrollWidth = 0,
    railClientWidth = 0,
    nestedScrollWidth = 500,
    nestedClientWidth = 200,
    nestedScrollLeft = 120,
  }: {
    railScrollWidth?: number;
    railClientWidth?: number;
    nestedScrollWidth?: number;
    nestedClientWidth?: number;
    nestedScrollLeft?: number;
  } = {}) {
    const makeComputedStyle = () => ({
      overflowX: "auto",
      overflow: "auto",
    });

    const rail = {
      parentElement: null,
      scrollWidth: railScrollWidth,
      clientWidth: railClientWidth,
      scrollLeft: 0,
    } as unknown as HTMLElement;
    const nested = {
      parentElement: rail,
      scrollWidth: nestedScrollWidth,
      clientWidth: nestedClientWidth,
      scrollLeft: nestedScrollLeft,
    } as unknown as HTMLElement;

    const ownerDocument = {
      defaultView: {
        getComputedStyle: () => makeComputedStyle(),
      },
    };

    (rail as unknown as { ownerDocument: unknown }).ownerDocument = ownerDocument;
    (nested as unknown as { ownerDocument: unknown }).ownerDocument = ownerDocument;

    const childTarget = {
      parentElement: nested,
    } as unknown as EventTarget;

    return { rail, nested, childTarget };
  }

  test("returns true when nested scroller can still scroll in wheel direction", () => {
    const { rail, childTarget } = createMockHorizontalScroller();
    const result = shouldDeferStageShiftWheelToNestedScroll({
      target: childTarget,
      stopAt: rail,
      direction: 1,
    });
    expect(result).toBeTrue();
  });

  test("returns false when nested scroller is at the direction boundary", () => {
    const { rail, childTarget } = createMockHorizontalScroller({
      nestedScrollWidth: 500,
      nestedClientWidth: 200,
      nestedScrollLeft: 300,
    });
    const result = shouldDeferStageShiftWheelToNestedScroll({
      target: childTarget,
      stopAt: rail,
      direction: 1,
    });
    expect(result).toBeFalse();
  });

  test("does not treat stage-rail container itself as a nested scroller", () => {
    const { rail } = createMockHorizontalScroller({
      railScrollWidth: 700,
      railClientWidth: 300,
    });
    const result = shouldDeferStageShiftWheelToNestedScroll({
      target: rail,
      stopAt: rail,
      direction: 1,
    });
    expect(result).toBeFalse();
  });
});

describe("isInsideCalendarShiftWheelScope", () => {
  test("returns true when any ancestor marks calendar shift-wheel scope", () => {
    const root = {
      parentElement: null,
      getAttribute: (name: string) =>
        name === CALENDAR_SHIFT_WHEEL_SCOPE_ATTR ? CALENDAR_SHIFT_WHEEL_SCOPE_VALUE : null,
    } as unknown as HTMLElement;

    const leaf = {
      parentElement: root,
      getAttribute: () => null,
    } as unknown as HTMLElement;

    const target = {
      parentElement: leaf,
    } as unknown as EventTarget;

    expect(isInsideCalendarShiftWheelScope(target)).toBeTrue();
  });

  test("returns false when target tree has no calendar scope marker", () => {
    const root = {
      parentElement: null,
      getAttribute: () => null,
    } as unknown as HTMLElement;

    const leaf = {
      parentElement: root,
      getAttribute: () => null,
    } as unknown as HTMLElement;

    const target = {
      parentElement: leaf,
    } as unknown as EventTarget;

    expect(isInsideCalendarShiftWheelScope(target)).toBeFalse();
  });
});

describe("shouldPreventStageRailShiftWheelFromCalendar", () => {
  test("returns true for shift wheel from calendar scope", () => {
    const root = {
      parentElement: null,
      getAttribute: (name: string) =>
        name === CALENDAR_SHIFT_WHEEL_SCOPE_ATTR ? CALENDAR_SHIFT_WHEEL_SCOPE_VALUE : null,
    } as unknown as HTMLElement;

    const target = {
      parentElement: root,
    } as unknown as EventTarget;

    expect(shouldPreventStageRailShiftWheelFromCalendar({
      target,
      shiftKey: true,
      ctrlKey: false,
    })).toBeTrue();
  });

  test("returns false when shift is not pressed", () => {
    const target = {
      parentElement: null,
    } as unknown as EventTarget;

    expect(shouldPreventStageRailShiftWheelFromCalendar({
      target,
      shiftKey: false,
      ctrlKey: false,
    })).toBeFalse();
  });

  test("returns false for ctrl/meta-modified wheel", () => {
    const root = {
      parentElement: null,
      getAttribute: (name: string) =>
        name === CALENDAR_SHIFT_WHEEL_SCOPE_ATTR ? CALENDAR_SHIFT_WHEEL_SCOPE_VALUE : null,
    } as unknown as HTMLElement;

    const target = {
      parentElement: root,
    } as unknown as EventTarget;

    expect(shouldPreventStageRailShiftWheelFromCalendar({
      target,
      shiftKey: true,
      ctrlKey: true,
    })).toBeFalse();
  });

  test("returns false for non-calendar targets", () => {
    const root = {
      parentElement: null,
      getAttribute: () => null,
    } as unknown as HTMLElement;

    const target = {
      parentElement: root,
    } as unknown as EventTarget;

    expect(shouldPreventStageRailShiftWheelFromCalendar({
      target,
      shiftKey: true,
      ctrlKey: false,
    })).toBeFalse();
  });
});
