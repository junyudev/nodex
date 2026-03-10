import { describe, expect, test } from "bun:test";
import {
  FLOATING_SIDEBAR_TRANSITION_DURATION_MS,
  FLOATING_SIDEBAR_TRANSITION_TIMING_FUNCTION,
  SIDEBAR_HOVER_KEEP_OPEN_MS,
  SIDEBAR_HOVER_OPEN_DELAY_MS,
  SIDEBAR_HOVER_TRIGGER_WIDTH_PX,
} from "./floating-sidebar";

describe("floating sidebar constants", () => {
  test("matches Zen Browser hover timings", () => {
    expect(SIDEBAR_HOVER_OPEN_DELAY_MS).toBe(0);
    expect(SIDEBAR_HOVER_KEEP_OPEN_MS).toBe(100);
    expect(FLOATING_SIDEBAR_TRANSITION_DURATION_MS).toBe(250);
  });

  test("keeps a thin edge trigger and uses the imported linear easing curve", () => {
    expect(SIDEBAR_HOVER_TRIGGER_WIDTH_PX).toBe(10);
    expect(FLOATING_SIDEBAR_TRANSITION_TIMING_FUNCTION.startsWith("linear(")).toBeTrue();
    expect(FLOATING_SIDEBAR_TRANSITION_TIMING_FUNCTION.endsWith(")")).toBeTrue();
  });
});
