import { describe, expect, test } from "bun:test";
import { stepShiftScroll } from "./calendar-shift-scroll";

describe("stepShiftScroll", () => {
  test("triggers navigation once crossing half-day threshold", () => {
    const beforeHalf = stepShiftScroll({
      currentPx: 0,
      targetPx: 49,
      dayWidthPx: 100,
      deltaTimeMs: 1000 / 60,
      isInputIdle: false,
      followLerpPerFrame: 1,
    });
    expect(beforeHalf.navigateDays).toBe(0);

    const atHalf = stepShiftScroll({
      currentPx: 0,
      targetPx: 50,
      dayWidthPx: 100,
      deltaTimeMs: 1000 / 60,
      isInputIdle: false,
      followLerpPerFrame: 1,
    });
    expect(atHalf.navigateDays).toBe(1);
  });

  test("preserves residual offset after boundary crossing without hard reset", () => {
    const result = stepShiftScroll({
      currentPx: 119,
      targetPx: 180,
      dayWidthPx: 120,
      deltaTimeMs: 1000 / 60,
      isInputIdle: false,
    });

    expect(result.navigateDays).toBe(1);
    expect(result.currentPx > 0).toBeTrue();
    expect(result.currentPx < 120).toBeTrue();
    expect(result.targetPx > 0).toBeTrue();
    expect(result.shouldStop).toBe(false);
  });

  test("can emit multiple day navigations in one frame", () => {
    const result = stepShiftScroll({
      currentPx: 0,
      targetPx: 350,
      dayWidthPx: 100,
      deltaTimeMs: 1000 / 60,
      isInputIdle: false,
      followLerpPerFrame: 1,
    });

    expect(result.navigateDays).toBe(4);
    expect(result.currentPx).toBe(-50);
    expect(result.targetPx).toBe(-50);
    expect(result.shouldStop).toBe(false);
  });

  test("can suppress navigation wrapping while waiting for view commit", () => {
    const result = stepShiftScroll({
      currentPx: 95,
      targetPx: 140,
      dayWidthPx: 100,
      deltaTimeMs: 1000 / 60,
      isInputIdle: false,
      allowNavigation: false,
      followLerpPerFrame: 1,
    });

    expect(result.navigateDays).toBe(0);
    expect(result.currentPx).toBe(140);
    expect(result.targetPx).toBe(140);
    expect(result.shouldStop).toBe(false);
  });

  test("only settles to stop when input is idle", () => {
    const active = stepShiftScroll({
      currentPx: 0.2,
      targetPx: 0.2,
      dayWidthPx: 120,
      deltaTimeMs: 1000 / 60,
      isInputIdle: false,
      followLerpPerFrame: 1,
      settleEpsilonPx: 0.3,
    });
    expect(active.shouldStop).toBe(false);

    const idle = stepShiftScroll({
      currentPx: 0.2,
      targetPx: 0.2,
      dayWidthPx: 120,
      deltaTimeMs: 1000 / 60,
      isInputIdle: true,
      followLerpPerFrame: 1,
      idleTargetLerpPerFrame: 1,
      settleEpsilonPx: 0.3,
    });
    expect(idle.shouldStop).toBe(true);
    expect(idle.currentPx).toBe(0);
    expect(idle.targetPx).toBe(0);
  });
});
